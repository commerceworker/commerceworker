import { Ago } from '@commerceworker/ui/ago';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { Field, FieldDescription, FieldLabel } from '@commerceworker/ui/field';
import { Input } from '@commerceworker/ui/input';
import { plural } from '@commerceworker/ui/lib/format';
import { Body, Empty, PageHeader, Section } from '@commerceworker/ui/page';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { Download, Eraser, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { data, Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import { StepUpField } from '~/components/step-up-field';
import { dataSubjectInput } from '~/lib/api-schemas';
import { audit } from '~/lib/audit.server';
import { requireUser, stepUp, stepUpMethod } from '~/lib/auth.server';
import { orderRef } from '~/lib/format';
import { eraseSubject, recentRequests } from '~/lib/privacy.server';
import type { Route } from './+types/privacy';

export const meta = () => [{ title: 'Privacy requests · CommerceWorker' }];

/** The address the person gave stays out of every cache, the answer to an erase included. */
export const headers: Route.HeadersFunction = ({ actionHeaders }) => actionHeaders;

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request, 'admin');
  const [requests, method] = await Promise.all([recentRequests(), stepUpMethod(me)]);
  return { requests, stepUp: me.kind === 'user' ? method : undefined };
}

const NO_STORE = { 'cache-control': 'private, no-store' };

/**
 * Erasing can't be undone, so the admin types the address twice and proves it's them (the
 * step-up the team's sensitive changes ask for). An export is a download from its own route
 * (`privacy-export.ts`).
 */
export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request, 'admin');
  const f = await request.formData();
  const parsed = dataSubjectInput.safeParse({ email: String(f.get('email') ?? '') });
  if (!parsed.success)
    return data(
      { kind: 'error' as const, error: 'Enter the address the person is known by.' },
      { status: 400, headers: NO_STORE },
    );
  const email = parsed.data.email;
  if (
    String(f.get('confirm') ?? '')
      .trim()
      .toLowerCase() !== email.toLowerCase()
  )
    return data(
      { kind: 'error' as const, error: 'Type the address again, exactly, to confirm the erasure.' },
      { status: 400, headers: NO_STORE },
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
        detail: { intent: 'personal_data.erase', error: failed },
      });
      return data({ kind: 'error' as const, error: failed }, { status: 403, headers: NO_STORE });
    }
  }
  const r = await eraseSubject(request, me, email);
  return data(
    r.ok
      ? { kind: 'erased' as const, erased: r }
      : { kind: 'running' as const, running: r.orders, erased: r.erased },
    { headers: NO_STORE },
  );
}

export default function Privacy() {
  const { requests, stepUp: method } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  const erasing = nav.state === 'submitting' && nav.formAction === '/privacy';
  const [email, setEmail] = useState('');
  // A round left orders: the same form erases the next 100.
  const more = result?.kind === 'erased' && !result.erased.done;
  return (
    <>
      <PageHeader
        title="Privacy requests"
        subtitle="Answer a request about one person, by the email address they are known by: download everything held about them, or erase who they are while keeping the commercial record. Each request is recorded, naming the person only by a hash of their address."
      />
      <Body className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid min-w-0 gap-4">
          <Section
            title="Find a person"
            description="Their customer accounts, the orders with that address as the contact, and the orders started by an email from it."
          >
            <Field>
              <FieldLabel htmlFor="subject-email">Email address</FieldLabel>
              <Input
                id="subject-email"
                type="email"
                inputMode="email"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={email}
                onChange={(e) => setEmail(e.currentTarget.value)}
                placeholder="person@example.com"
                className="max-w-96"
              />
            </Field>
          </Section>

          <Section
            title="Download their data"
            description="A JSON file of their accounts, up to 500 orders with contact details and lines, the messages sent to them, their intake emails, the documents on their orders and the places their orders shipped to."
          >
            {/* A plain form, so the browser saves the file the route answers with. */}
            <form method="post" action="/privacy/export">
              <input type="hidden" name="email" value={email} />
              <Button type="submit" variant="outline" disabled={!email.includes('@')}>
                <Download aria-hidden="true" /> Download their data
              </Button>
            </form>
          </Section>

          <Section
            title="Erase them"
            description="Removes who they are from their orders, accounts, messages, documents, intake emails, carts and sign-ins. Lines, amounts, payments, shipments and ledgers stay. It can’t be undone."
          >
            <Form method="post" className="grid gap-4">
              <input type="hidden" name="email" value={email} />
              <Field>
                <FieldLabel htmlFor="subject-confirm">Type the address again to confirm</FieldLabel>
                <Input
                  id="subject-confirm"
                  name="confirm"
                  type="email"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="max-w-96"
                  onPaste={(e) => e.preventDefault()}
                />
                <FieldDescription>
                  Orders still running are never erased: cancel them or let them finish first.
                </FieldDescription>
              </Field>
              {method !== undefined ? <StepUpField method={method} next="/privacy" /> : null}
              <Button
                type="submit"
                variant="destructive"
                disabled={erasing || !email.includes('@')}
                className="justify-self-start"
              >
                <Eraser aria-hidden="true" />{' '}
                {erasing ? 'Erasing…' : more ? 'Continue erasing' : 'Erase this person'}
              </Button>
            </Form>
            <Outcome result={result} />
          </Section>
        </div>

        <aside className="min-w-0">
          <Section
            title="Recent requests"
            description="From the audit log. The person is a hash of their address, so the log doesn’t keep it."
            flush
          >
            {requests.length ? (
              <Table stack="cards" caption="Recent privacy requests">
                <TableHead className="sr-only">
                  <Tr>
                    <Th>Request</Th>
                    <Th numeric>When</Th>
                  </Tr>
                </TableHead>
                <TableBody>
                  {requests.map((r) => (
                    <Tr key={r.id}>
                      <Td>
                        <div className="text-sm">{REQUEST_LABEL[r.action] ?? r.action}</div>
                        <div className="break-all text-muted-foreground text-xs">
                          {r.actor ?? 'Someone'} · <span className="font-mono">{r.target}</span>
                          {summary(r.detail) ? ` · ${summary(r.detail)}` : ''}
                        </div>
                      </Td>
                      <Td numeric label="When" className="text-muted-foreground text-xs">
                        <Ago ms={r.at} />
                      </Td>
                    </Tr>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Empty icon={<ShieldCheck aria-hidden="true" />} title="No requests yet">
                Exports and erasures appear here as they are made.
              </Empty>
            )}
            <p className="border-t px-4 py-2.5 text-xs">
              <Link to="/audit?group=personal_data" className="text-link hover:underline">
                All of them in the audit log
              </Link>
            </p>
          </Section>
        </aside>
      </Body>
    </>
  );
}

const REQUEST_LABEL: Record<string, string> = {
  'personal_data.exported': 'Data downloaded',
  'personal_data.erased': 'Erased',
  'personal_data.erasure_replayed': 'Erased again after a restore',
};

/** "12 orders, 1 account": what a request touched, from its audit detail. */
function summary(d: Record<string, unknown> | null) {
  if (!d) return '';
  const n = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : 0);
  return [
    n('orders') ? plural(n('orders'), 'order') : null,
    n('customers') ? plural(n('customers'), 'account') : null,
  ]
    .filter(Boolean)
    .join(', ');
}

type Result = ReturnType<typeof useActionData<typeof action>>;

/** "3 orders, 1 customer account, …": what an erasure round removed. */
function describe(c: {
  orders: number;
  customers: number;
  messages: number;
  documents: number;
  inboundEmails: number;
  carts: number;
}) {
  return [
    plural(c.orders, 'order'),
    plural(c.customers, 'customer account'),
    plural(c.messages, 'message'),
    plural(c.documents, 'document'),
    plural(c.inboundEmails, 'intake email'),
    c.carts ? plural(c.carts, 'cart') : null,
  ].filter((x): x is string => !!x);
}

/** What the erase did, what's left, or why it was refused. */
function Outcome({ result }: { result: Result }) {
  if (!result) return null;
  if (result.kind === 'error')
    return (
      <p role="alert" className="mt-3 text-destructive text-sm">
        {result.error}
      </p>
    );
  if (result.kind === 'running')
    return (
      <Alert variant="warning" role="alert" className="mt-4">
        <AlertTitle>Stopped: {plural(result.running.length, 'order')} still running</AlertTitle>
        <AlertDescription>
          {result.erased
            ? `Before reaching them it erased ${describe(result.erased).join(', ')}, and that stays erased. `
            : 'Nothing was erased. '}
          Cancel them or let them finish, then erase again.
          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {result.running.map((id) => (
              <li key={id}>
                <Link to={`/orders/${id}`} className="font-mono text-link hover:underline">
                  {orderRef(id)}
                </Link>
              </li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    );
  const { counts, done, teamMember } = result.erased;
  const parts = describe(counts);
  const nothing = Object.values(counts).every((n) => n === 0);
  return (
    <div role="status" className="mt-4 grid gap-2 text-sm">
      <p>
        {nothing ? (
          <>
            <span className="font-medium">Erased.</span> Nothing was held about this address.
          </>
        ) : (
          <>
            <span className="font-medium">{done ? 'Erased.' : 'Partly erased.'}</span>{' '}
            {parts.join(', ')}.
          </>
        )}
      </p>
      {done ? null : (
        <p className="text-muted-foreground">
          More of their orders are left: continue to erase the next 100.
        </p>
      )}
      {teamMember ? (
        <p>
          The address also belongs to someone on your team, who isn’t touched:{' '}
          <Link to="/team" className="text-link hover:underline">
            remove them on Team
          </Link>{' '}
          if you need to.
        </p>
      ) : null}
    </div>
  );
}
