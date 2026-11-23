import { isCartEvent, OUTBOUND_EVENTS } from '@commerceworker/core';
import { Ago } from '@commerceworker/ui/ago';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { Checkbox } from '@commerceworker/ui/checkbox';
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@commerceworker/ui/field';
import { Input } from '@commerceworker/ui/input';
import { plural } from '@commerceworker/ui/lib/format';
import { cn } from '@commerceworker/ui/lib/utils';
import { Body, Empty, PageHeader, Section } from '@commerceworker/ui/page';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { KeyRound, Send, Trash2, Webhook } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  data,
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from 'react-router';
import { CopyButton } from '~/components/copy-button';
import { FormSheet, useFormSheet } from '~/components/form-sheet';
import { ToneBadge } from '~/components/status';
import { StepUpField } from '~/components/step-up-field';
import { subscriptionInput } from '~/lib/api-schemas';
import { useAssistant } from '~/lib/assistant';
import { audit } from '~/lib/audit.server';
import { requireUser, stepUp, stepUpMethod } from '~/lib/auth.server';
import { orderRef } from '~/lib/format';
import { SECRET_HEADERS } from '~/lib/secret-response';
import { auditUrl } from '~/lib/webhook-audit';
import {
  createSubscription,
  listDeliveries,
  listSubscriptions,
  rotateSubscription,
} from '~/lib/webhooks.server';
import type { Route } from './+types/webhooks';

export const meta = () => [{ title: 'Webhooks · CommerceWorker' }];

/** A new secret's response is never stored (`SECRET_HEADERS`), a full-page submit included. */
export const headers: Route.HeadersFunction = ({ actionHeaders }) => actionHeaders;

/** Deliveries shown for the chosen subscription, newest first. */
const DELIVERIES = 50;

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request, 'admin');
  const asked = new URL(request.url).searchParams.get('subscription');
  const [subscriptions, method] = await Promise.all([listSubscriptions(), stepUpMethod(me)]);
  const chosen = subscriptions.find((s) => s.id === asked) ?? subscriptions[0] ?? null;
  return {
    subscriptions,
    chosen: chosen?.id ?? null,
    // The payloads carry buyers' details and the page never shows them: they stay on the server.
    deliveries: chosen
      ? (await listDeliveries(chosen.id, DELIVERIES)).map(({ payload: _, ...d }) => d)
      : [],
    // Undefined where nobody signs in (a workspace with no admin yet): nothing to step up from.
    stepUp: me.kind === 'user' ? method : undefined,
  };
}

/** A new secret comes back once, from the action, and is never stored in the clear. */
type Secret = { label: string; value: string; url: string };

/**
 * Adding a subscription sends order data, buyers' details included, to an address an admin types,
 * and rotating changes what receivers must check; both ask the admin to prove it's them first, as
 * the team's sensitive changes do. Removing one and sending a delivery again go through the
 * assistant, which asks the person to confirm (`delete_webhook_subscription`,
 * `redeliver_webhook_delivery`).
 */
export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request, 'admin');
  const f = await request.formData();
  const intent = String(f.get('intent') ?? '');
  if (intent !== 'create' && intent !== 'rotate')
    return data({ error: 'That isn’t something this page does.' }, 400);
  // The address and events are checked first, so a mistyped one doesn't spend a one-time code.
  const parsed =
    intent === 'create'
      ? subscriptionInput.safeParse({
          url: String(f.get('url') ?? '').trim(),
          events: f.get('all') === 'on' ? ['*'] : f.getAll('events').map(String),
        })
      : null;
  if (parsed && !parsed.success)
    return data(
      {
        error:
          parsed.error.issues[0]?.path[0] === 'events'
            ? 'Choose the events to send, or all of them.'
            : (parsed.error.issues[0]?.message ?? 'Check the address.'),
      },
      400,
    );
  if (me.kind === 'user') {
    const failed = await stepUp(request, me, {
      code: String(f.get('code') ?? ''),
      password: String(f.get('password') ?? ''),
    });
    if (failed) {
      await audit(request, 'auth.step_up_failed', {
        actor: me,
        target: null,
        detail: { intent: `webhook.${intent}`, error: failed },
      });
      return data({ error: failed }, 403);
    }
  }
  if (parsed?.success) {
    const created = await createSubscription(parsed.data);
    await audit(request, 'webhook.subscribed', {
      actor: me,
      target: auditUrl(parsed.data.url),
      detail: { id: created.subscription.id, events: parsed.data.events, via: 'app' },
    });
    return data(
      {
        chosen: created.subscription.id,
        secret: {
          label: 'Signing secret for the new subscription',
          value: created.secret,
          url: created.subscription.url,
        } satisfies Secret,
      },
      { headers: SECRET_HEADERS },
    );
  }
  const id = String(f.get('id') ?? '');
  const rotated = await rotateSubscription(id);
  if (!rotated) return data({ error: `No webhook subscription ${id}.` }, 404);
  await audit(request, 'webhook.rotated', {
    actor: me,
    target: auditUrl(rotated.subscription.url),
    detail: { id, via: 'app' },
  });
  return data(
    {
      chosen: id,
      secret: {
        label: 'New signing secret',
        value: rotated.secret,
        url: rotated.subscription.url,
      } satisfies Secret,
    },
    { headers: SECRET_HEADERS },
  );
}

type Data = Awaited<ReturnType<typeof loader>>;

export default function Webhooks() {
  const { subscriptions, chosen, deliveries, stepUp: method } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const secret = result && 'secret' in result ? result.secret : null;
  const error = result && 'error' in result ? result.error : null;
  const nav = useNavigation();
  const busy = nav.state === 'submitting' && nav.formData?.get('intent') === 'create';
  const sheet = useFormSheet(result, (r) => 'secret' in r);
  const secretRef = useRef<HTMLDivElement>(null);
  // A new secret takes focus: copying it is what to do next.
  useEffect(() => {
    if (secret) secretRef.current?.focus();
  }, [secret]);
  const current = subscriptions.find((s) => s.id === chosen) ?? null;
  return (
    <>
      <PageHeader
        title="Webhooks"
        subtitle="Where CommerceWorker sends signed events as orders and carts change, and what each receiver answered. A failed delivery is retried for about a day, then waits here to be sent again."
        actions={
          <FormSheet
            open={sheet.open}
            onOpenChange={sheet.onOpenChange}
            label="New subscription"
            description="Each delivery is a signed JSON POST. The signing secret is shown once, when you add it."
          >
            <NewSubscription error={sheet.open ? error : null} busy={busy} stepUp={method} />
          </FormSheet>
        }
      />
      <Body className="grid gap-4">
        {secret ? (
          <Alert
            ref={secretRef}
            tabIndex={-1}
            variant="warning"
            role="note"
            className="outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <KeyRound aria-hidden="true" />
            <AlertTitle>{secret.label}</AlertTitle>
            <AlertDescription className="max-w-measure">
              Give it to the receiver at <span className="break-all font-mono">{secret.url}</span>{' '}
              to check each delivery’s signature. Copy it now: it is shown once.
            </AlertDescription>
            <div className="col-start-2 mt-2 flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 select-all break-all rounded-sm bg-card px-2 py-1.5 font-mono text-sm">
                {secret.value}
              </code>
              <CopyButton text={secret.value} />
            </div>
          </Alert>
        ) : null}
        {error && !sheet.open ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <Section
          title="Subscriptions"
          description="Each address and the events it takes. Choose one to see its deliveries."
          flush
        >
          {subscriptions.length ? (
            <ul className="divide-y">
              {subscriptions.map((s) => (
                <SubscriptionRow key={s.id} s={s} chosen={s.id === chosen} stepUp={method} />
              ))}
            </ul>
          ) : (
            <Empty icon={<Webhook aria-hidden="true" />} title="No subscriptions yet">
              Add one to send order and cart events to your own systems as they happen.
            </Empty>
          )}
        </Section>
        {current ? <Deliveries rows={deliveries} url={current.url} /> : null}
      </Body>
    </>
  );
}

function NewSubscription({
  error,
  busy,
  stepUp,
}: {
  error: string | null;
  busy: boolean;
  stepUp: Data['stepUp'];
}) {
  const [all, setAll] = useState(true);
  return (
    <Form method="post" className="flex flex-col gap-4">
      <input type="hidden" name="intent" value="create" />
      <Field>
        <FieldLabel htmlFor="webhook-url">Address</FieldLabel>
        <Input
          id="webhook-url"
          name="url"
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://example.com/hooks/commerceworker"
          required
        />
        <FieldDescription>An https address that answers with a 2xx.</FieldDescription>
      </Field>
      <FieldSet>
        <FieldLegend variant="label">Events</FieldLegend>
        <div className="flex min-h-9 items-center gap-2 touch:min-h-11">
          <Checkbox
            id="webhook-all"
            name="all"
            checked={all}
            onCheckedChange={(v) => setAll(v === true)}
          />
          <FieldLabel htmlFor="webhook-all" className="font-normal">
            Every event, including ones added later
          </FieldLabel>
        </div>
        {all ? null : (
          <div className="grid gap-x-4 sm:grid-cols-2">
            {OUTBOUND_EVENTS.map((e) => (
              <div key={e} className="flex min-h-9 items-center gap-2 touch:min-h-11">
                <Checkbox id={`webhook-event-${e}`} name="events" value={e} />
                <FieldLabel
                  htmlFor={`webhook-event-${e}`}
                  className="font-mono font-normal text-xs"
                >
                  {e}
                </FieldLabel>
              </div>
            ))}
          </div>
        )}
      </FieldSet>
      {stepUp !== undefined ? <StepUpField method={stepUp} next="/webhooks" /> : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy} className="self-start">
        {busy ? 'Adding…' : 'Add subscription'}
      </Button>
    </Form>
  );
}

/**
 * One subscription: its address and events, picked to show its deliveries. Rotating asks for the
 * step-up in place; removing asks through the assistant, which says what stops.
 */
function SubscriptionRow({
  s,
  chosen,
  stepUp,
}: {
  s: Data['subscriptions'][number];
  chosen: boolean;
  stepUp: Data['stepUp'];
}) {
  const { act } = useAssistant();
  const { revalidate } = useRevalidator();
  const [rotating, setRotating] = useState(false);
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const remove = async () => {
    setAsking(true);
    setFailed(null);
    try {
      const r = await act('delete_webhook_subscription', { subscriptionId: s.id });
      if (!('declined' in r)) revalidate();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  };
  const all = s.events.includes('*');
  return (
    <li className={cn('px-4 py-3', chosen && 'bg-muted/50')}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-72">
          <Link
            to={`?subscription=${s.id}`}
            aria-current={chosen ? 'true' : undefined}
            preventScrollReset
            className="break-all font-mono text-sm hover:underline aria-[current]:font-medium"
          >
            {s.url}
          </Link>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {all ? 'Every event' : s.events.join(', ')} · added <Ago ms={s.createdAt} />
            {s.previousExpiresAt ? (
              <>
                {' '}
                · the previous secret also signs until <Ago ms={s.previousExpiresAt} />
              </>
            ) : null}
          </p>
          {failed ? (
            <p role="alert" className="mt-1 text-bad text-sm">
              {failed}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {rotating ? null : (
            <Button size="sm" variant="outline" onClick={() => setRotating(true)}>
              <KeyRound aria-hidden="true" /> Rotate secret
            </Button>
          )}
          {asking ? (
            <span className="text-muted-foreground text-sm" aria-live="polite">
              Confirm it in the assistant
            </span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove the subscription for ${s.url}`}
              onClick={() => void remove()}
            >
              <Trash2 aria-hidden="true" /> Remove
            </Button>
          )}
        </div>
      </div>
      {rotating ? (
        <Form method="post" className="mt-3 flex flex-wrap items-end gap-3">
          <input type="hidden" name="intent" value="rotate" />
          <input type="hidden" name="id" value={s.id} />
          <p className="w-full max-w-measure text-muted-foreground text-xs">
            For 24 hours each delivery is signed with both secrets, so the receiver can switch
            without rejecting any.
          </p>
          {stepUp !== undefined ? (
            <StepUpField method={stepUp} next={`/webhooks?subscription=${s.id}`} />
          ) : null}
          <Button type="submit" size="sm">
            Rotate now
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setRotating(false)}>
            Cancel
          </Button>
        </Form>
      ) : null}
    </li>
  );
}

const DELIVERY_TONE: Record<string, 'ok' | 'bad' | 'run'> = {
  delivered: 'ok',
  failed: 'bad',
  pending: 'run',
};

/**
 * The chosen subscription's latest deliveries: what was sent, about which order or cart, and what
 * the receiver answered. One that failed or arrived can be sent again, with the same delivery id,
 * so a receiver that dedupes handles it once.
 */
function Deliveries({ rows, url }: { rows: Data['deliveries']; url: string }) {
  const failed = rows.filter((r) => r.status === 'failed').length;
  return (
    <Section
      title="Deliveries"
      description={
        <>
          The latest {DELIVERIES} to <span className="break-all font-mono">{url}</span>, newest
          first.
        </>
      }
      actions={
        failed ? (
          <span className="font-medium text-bad text-xs tabular">
            {plural(failed, 'failed delivery', 'failed deliveries')}
          </span>
        ) : null
      }
      flush
    >
      {rows.length ? (
        <Table stack="cards" scroll caption="Deliveries">
          <TableHead>
            <Tr>
              <Th>Event</Th>
              <Th>About</Th>
              <Th>Status</Th>
              <Th>Answer</Th>
              <Th numeric>When</Th>
              <Th className="text-right">
                <span className="sr-only">Send again</span>
              </Th>
            </Tr>
          </TableHead>
          <TableBody>
            {rows.map((d) => (
              <DeliveryRow key={d.id} d={d} />
            ))}
          </TableBody>
        </Table>
      ) : (
        <Empty>Nothing sent yet. Deliveries appear here as orders and carts change.</Empty>
      )}
    </Section>
  );
}

function DeliveryRow({ d }: { d: Data['deliveries'][number] }) {
  const { act } = useAssistant();
  const { revalidate } = useRevalidator();
  const [state, setState] = useState<'idle' | 'asking' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const again = async () => {
    setState('asking');
    setError(null);
    try {
      const r = await act('redeliver_webhook_delivery', { deliveryId: d.id });
      if ('declined' in r) setState('idle');
      else {
        setState('sent');
        revalidate();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('idle');
    }
  };
  const cart = isCartEvent(d.event);
  return (
    <Tr>
      <Td>
        <span className="font-mono text-xs">{d.event}</span>
        <div className="font-mono text-2xs text-muted-foreground">{d.id}</div>
      </Td>
      <Td label="About">
        <Link
          to={cart ? `/carts/${d.orderId}` : `/orders/${d.orderId}`}
          className="font-mono text-xs hover:underline"
        >
          {cart ? 'Cart' : 'Order'} {orderRef(d.orderId)}
        </Link>
      </Td>
      <Td label="Status">
        <ToneBadge tone={DELIVERY_TONE[d.status] ?? 'idle'} label={d.status} />
        {d.attempts > 1 ? (
          <div className="text-muted-foreground text-xs">{plural(d.attempts, 'attempt')}</div>
        ) : null}
      </Td>
      <Td label="Answer" className="max-w-72">
        {d.responseStatus ? <span className="font-mono text-xs">{d.responseStatus}</span> : null}
        {d.lastError ? (
          <div className="break-words text-muted-foreground text-xs">{d.lastError}</div>
        ) : d.responseStatus ? null : (
          <span className="text-muted-foreground">—</span>
        )}
      </Td>
      <Td numeric label="When" className="text-muted-foreground text-xs">
        <Ago ms={d.deliveredAt ?? d.createdAt} />
      </Td>
      <Td className="text-right">
        {d.status === 'pending' ? null : state === 'sent' ? (
          <span role="status" className="font-medium text-ok text-sm">
            Sent again
          </span>
        ) : state === 'asking' ? (
          <span className="text-muted-foreground text-sm" aria-live="polite">
            Confirm it in the assistant
          </span>
        ) : (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Send ${d.event} ${d.id} again`}
            onClick={() => void again()}
          >
            <Send aria-hidden="true" /> Send again
          </Button>
        )}
        {error ? (
          <p role="alert" className="mt-1 text-bad text-xs">
            {error}
          </p>
        ) : null}
      </Td>
    </Tr>
  );
}
