import { Ago } from '@commerceworker/ui/ago';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@commerceworker/ui/item';
import { plural } from '@commerceworker/ui/lib/format';
import { Body, PageHeader, Section } from '@commerceworker/ui/page';
import { Mail } from 'lucide-react';
import { Link, useLoaderData } from 'react-router';
import { ToneBadge } from '~/components/status';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { humanize, orderRef } from '~/lib/format';
import { publishedFlows, recentInboundEmails } from '~/lib/orders.server';
import type { Route } from './+types/intake';

export const meta = () => [{ title: 'Email intake · CommerceWorker' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const [emails, configured, flows] = await Promise.all([
    recentInboundEmails(),
    // The engine owns INTAKE_MAILBOXES; ask it rather than assume the defaults.
    engine().intakeMailboxes(),
    publishedFlows(),
  ]);
  const host = new URL(request.url).hostname;
  const flowName = new Map(flows.map((f) => [f.id, f.name]));
  const mailboxes = Object.entries(configured).map(([local, flowId]) => ({
    address: `${local}@${host === 'localhost' ? 'app.commerceworker.com' : host}`,
    flowId,
    flowName: flowName.get(flowId) ?? null,
  }));
  return { emails, mailboxes };
}

export default function EmailIntake() {
  const { emails, mailboxes } = useLoaderData<typeof loader>();
  return (
    <>
      <PageHeader
        title="Email intake"
        subtitle="Orders, order forms and purchase orders sent by email start an Order Flow. The sender gets an acknowledgement with the order’s reference."
      />
      <Body className="grid gap-4">
        <Section
          title="Addresses"
          description="Mail is accepted from customers’ own addresses, their company domains and senders an administrator has allowed. Each address starts its flow; what arrived is below, newest first."
        >
          {/* Each address and the flow it starts; then what arrived, newest first. */}
          <ul className="grid gap-2 md:grid-cols-2">
            {mailboxes.map((m) => (
              <Item asChild key={m.address} variant="muted" size="sm" className="min-w-0">
                <li>
                  <ItemMedia variant="icon">
                    <Mail className="text-muted-foreground" aria-hidden="true" />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="w-full">
                      <a
                        href={`mailto:${m.address}`}
                        className="break-all font-mono font-normal text-link hover:underline"
                      >
                        {m.address}
                      </a>
                    </ItemTitle>
                    <ItemDescription>
                      starts{' '}
                      <Link to={`/flows/${m.flowId}`} className="hover:text-foreground">
                        {m.flowName ?? m.flowId}
                      </Link>
                    </ItemDescription>
                  </ItemContent>
                </li>
              </Item>
            ))}
          </ul>
          {emails.length ? (
            <ul className="-mx-2 mt-3 flex flex-col gap-1">
              {emails.map((e) => (
                <Item
                  asChild
                  key={e.id}
                  size="xs"
                  className="flex-nowrap items-start px-2 hover:bg-muted/60 max-sm:flex-wrap"
                >
                  <li>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="line-clamp-none w-full">
                        <span className="min-w-0 break-words">{e.subject || '(no subject)'}</span>
                      </ItemTitle>
                      <ItemDescription className="line-clamp-none break-words text-xs">
                        from {e.sender} to {e.mailbox}
                        {e.attachments ? ` · ${plural(e.attachments, 'attachment')}` : ''}
                        {e.reason ? ` · ${e.reason}` : ''}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions className="shrink-0 items-center gap-3 self-start text-xs">
                      <ToneBadge
                        tone={
                          e.status === 'accepted' ? 'ok' : e.status === 'duplicate' ? 'idle' : 'bad'
                        }
                        label={humanize(e.status)}
                      />
                      {e.orderId ? (
                        <Link
                          to={`/orders/${e.orderId}`}
                          className="font-mono text-link hover:underline"
                        >
                          {orderRef(e.orderId)}
                        </Link>
                      ) : null}
                      <span className="text-muted-foreground">
                        <Ago ms={e.receivedAt} />
                      </span>
                    </ItemActions>
                  </li>
                </Item>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-muted-foreground text-sm">
              No email received yet. Send a purchase order to one of the addresses above.
            </p>
          )}
        </Section>
      </Body>
    </>
  );
}
