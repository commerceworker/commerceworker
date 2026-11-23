import {
  BASE_CURRENCY,
  ORDER_MODEL_LABELS,
  type OrderModel,
  type OrderState,
} from '@commerceworker/core';
import { Button } from '@commerceworker/ui/button';
import { useNow } from '@commerceworker/ui/hooks/use-now';
import { Item, ItemActions, ItemContent, ItemTitle } from '@commerceworker/ui/item';
import { count, money, plural } from '@commerceworker/ui/lib/format';
import { Body, Empty, PageHeader, Section } from '@commerceworker/ui/page';
import { Check, Zap } from 'lucide-react';
import { useId, useState } from 'react';
import { Link, useLoaderData } from 'react-router';
import { FindBar } from '~/components/back-office';
import { WaitingAt } from '~/components/waiting-at';
import { useAssistant } from '~/lib/assistant';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { eventAction, eventWaiting } from '~/lib/events';
import { customerNames, waitingOnEvents } from '~/lib/orders.server';
import { useCan } from '~/lib/use-me';
import { isOverdue } from '~/lib/where';
import type { Route } from './+types/events';

export const meta = () => [{ title: 'Outside events · CommerceWorker' }];

/** Orders waiting on an outside event whose live state the page reads, most recently updated first. */
const CHECKED = 20;

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const q = new URL(request.url).searchParams.get('q')?.trim() ?? '';
  const waiting = await waitingOnEvents(CHECKED);
  const states = (await Promise.all(waiting.orders.map((o) => engine().snapshot(o.id)))).filter(
    (s): s is OrderState => !!s,
  );
  const names = await customerNames(states.map((s) => s.order?.customerId));
  const events = states.flatMap((s) =>
    s.waits
      .filter((w) => w.kind === 'event')
      .map((w) => {
        const o = s.order;
        return {
          orderId: s.orderId!,
          title: o?.title || (o ? ORDER_MODEL_LABELS[o.model as OrderModel] : ''),
          // Who the order is for and what it is worth, so a person can match it to the payment,
          // parcel or reply in front of them before recording it.
          customer:
            (o?.customerId ? names[o.customerId] : null) ||
            o?.contact?.name ||
            o?.contact?.email ||
            null,
          amount: w.amount ?? o?.total ?? 0,
          currency: o?.currency ?? BASE_CURRENCY,
          event: w.event!,
          nodeId: w.nodeId,
          since: w.since,
          due: w.deadline ?? null,
        };
      }),
  );
  return {
    events,
    // Every order waiting on one, not just those read: the header counts them all.
    waitingTotal: waiting.total,
    waitingOverdue: waiting.overdue,
    shownOrders: states.length,
    q,
  };
}

type EventItem = Awaited<ReturnType<typeof loader>>['events'][number];

const eventKey = (e: Pick<EventItem, 'orderId' | 'nodeId'>) => `${e.orderId}-${e.nodeId}`;

export default function OutsideEvents() {
  const {
    events: allEvents,
    waitingTotal,
    waitingOverdue,
    shownOrders,
    q,
  } = useLoaderData<typeof loader>();
  const term = q.toLowerCase().replace(/^#/, '');
  const events = allEvents.filter(
    (e) => !term || [e.title, e.customer, e.orderId].some((x) => x?.toLowerCase().includes(term)),
  );
  const [recorded, setRecorded] = useState<ReadonlySet<string>>(new Set());
  const open = events.filter((e) => !recorded.has(eventKey(e))).length;
  // More orders wait on an outside event than the page read.
  const partial = waitingTotal > shownOrders;
  return (
    <>
      <PageHeader
        title="Outside events"
        subtitle="Orders waiting on the outside world, such as a payment, a delivery or a seller’s answer. Recording one resumes the order."
      />
      <Body className="grid gap-4">
        <FindBar q={q} label="Find an order or customer" matched="Showing only orders matching" />
        <Section
          title="Waiting"
          description="Orders waiting for an outside event, most recently updated first."
          actions={
            partial ? (
              <WaitingCount
                waiting={`${plural(waitingTotal, 'order')} waiting`}
                overdue={waitingOverdue}
              />
            ) : open ? (
              <WaitingCount
                waiting={`${open} waiting`}
                dues={events.filter((e) => !recorded.has(eventKey(e))).map((e) => e.due)}
              />
            ) : null
          }
        >
          {events.length ? (
            <ul className="flex flex-col gap-2">
              {events.map((e) => (
                <EventRow
                  key={eventKey(e)}
                  e={e}
                  onRecorded={() =>
                    setRecorded((s) => (s.has(eventKey(e)) ? s : new Set(s).add(eventKey(e))))
                  }
                />
              ))}
            </ul>
          ) : (
            <Empty>
              {q
                ? `No order matching “${q}” is waiting for an outside event.`
                : 'No order is waiting for an outside event, such as a payment or a delivery.'}
            </Empty>
          )}
          {partial ? (
            <p className="mt-3 text-muted-foreground text-xs">
              <span className="block max-w-measure">
                Showing the {shownOrders} most recently updated of {count(waitingTotal)} orders
                waiting on an outside event.{' '}
                <Link to="/orders?status=waiting" className="text-link hover:underline">
                  See every waiting order
                </Link>
                .
              </span>
            </p>
          ) : null}
        </Section>
      </Body>
    </>
  );
}

/**
 * How many orders wait on an outside event, muted: a count is not a warning. Beside it, in the wait
 * colour, how many of them are past their step's deadline (The Overdue Rule, DESIGN.md): checked
 * live against the rows' `dues` when the page shows them all, else the index's `overdue` count when
 * the page loaded.
 */
function WaitingCount({
  waiting,
  dues,
  overdue: counted = 0,
}: {
  waiting: string;
  dues?: (number | null)[];
  overdue?: number;
}) {
  const now = useNow(dues ? 30_000 : null);
  const overdue = dues ? dues.filter((d) => isOverdue(d, now)).length : counted;
  return (
    <span className="text-xs tabular">
      <span className="text-muted-foreground">{waiting}</span>
      {/* The server's clock and the browser's can disagree on a deadline just passed. */}
      <span className="ml-2 font-medium text-wait empty:hidden" suppressHydrationWarning>
        {overdue ? `${count(overdue)} overdue` : ''}
      </span>
    </span>
  );
}

/**
 * One order waiting on the outside world. Recording the event asks through the assistant: its card
 * says what the event resumes, and nothing is delivered until the person confirms there.
 */
function EventRow({ e, onRecorded }: { e: EventItem; onRecorded: () => void }) {
  const canOperate = useCan('operator');
  const { act } = useAssistant();
  const [asking, setAsking] = useState(false);
  const [delivered, setDelivered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const waitId = useId();
  const record = async () => {
    setAsking(true);
    setError(null);
    try {
      const r = await act('deliver_event', { orderId: e.orderId, event: e.event });
      if ('declined' in r) return;
      setDelivered(true);
      onRecorded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  };
  const label = eventAction(e.event);

  return (
    <Item asChild variant="muted" size="sm" className="gap-x-4 gap-y-2">
      <li>
        <ItemContent className="min-w-0 basis-64">
          <ItemTitle className="line-clamp-none">
            <Link id={titleId} to={`/orders/${e.orderId}`} className="hover:underline">
              {e.title || 'Order'}{' '}
              <span className="font-mono font-normal text-muted-foreground text-xs">
                ref {e.orderId.slice(-6)}
              </span>
            </Link>
          </ItemTitle>
          <p id={waitId} className="text-muted-foreground">
            <WaitingAt
              at={`Waits for ${eventWaiting(e.event)}`}
              since={e.since}
              on={null}
              due={e.due}
            />
          </p>
          {e.customer || e.amount ? (
            <p className="text-muted-foreground text-xs tabular">
              {[e.customer, e.amount ? money(e.amount, e.currency) : null]
                .filter(Boolean)
                .join(' · ')}
            </p>
          ) : null}
          {error ? (
            <p className="mt-1 text-bad text-sm" role="alert">
              {error}
            </p>
          ) : null}
        </ItemContent>
        <ItemActions className="shrink-0">
          {!canOperate ? (
            <span className="text-muted-foreground text-xs">An operator records this.</span>
          ) : e.event === 'seller.responded' ? (
            // Each seller answers for their own part; the order page asks per seller.
            <Button asChild size="sm" variant="outline">
              <Link to={`/orders/${e.orderId}`} aria-describedby={`${titleId} ${waitId}`}>
                Answer per seller
              </Link>
            </Button>
          ) : e.event === 'return.requested' ? (
            // The items, reason and refund are asked for on the order page.
            <Button asChild size="sm" variant="outline">
              <Link to={`/orders/${e.orderId}`} aria-describedby={`${titleId} ${waitId}`}>
                Record a return or claim
              </Link>
            </Button>
          ) : delivered ? (
            <span role="status" className="inline-flex items-center gap-1.5 font-medium text-ok">
              <Check className="size-4" aria-hidden="true" /> Recorded
            </span>
          ) : asking ? (
            <span className="text-muted-foreground" aria-live="polite">
              Confirm it in the assistant
            </span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              aria-describedby={`${titleId} ${waitId}`}
              onClick={() => void record()}
            >
              <Zap /> {error ? `Try again: ${label.toLowerCase()}` : label}
            </Button>
          )}
        </ItemActions>
      </li>
    </Item>
  );
}
