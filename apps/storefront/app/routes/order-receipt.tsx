/**
 * An order's receipt for its buyer: the page a confirmation email links to
 * (`/orders/<id>?t=<credential>`, also what UCP's default `orderPermalink` points at). The
 * credential is a bearer secret, so the page is never cached, sends no referrer and is kept out of
 * search; what it shows is the engine's buyer-safe view (`StorefrontRpc.orderReceipt`: lines,
 * totals, status, ship-to, tracking), never a timeline or a note. An unknown order, a wrong
 * credential and an expired one all read the same.
 */

import { type BuyerOrderView, formatAmount } from '@commerceworker/core';
import { Empty } from '@commerceworker/ui/page';
import { Receipt } from 'lucide-react';
import { data, isRouteErrorResponse, useLoaderData, useRouteError } from 'react-router';
import { engine } from '~/lib/env.server';
import { overBudget } from '~/lib/rate-limit';
import type { Route } from './+types/order-receipt';

const ORDER_ID = /^[A-Za-z0-9_-]{1,100}$/;

const PRIVATE = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
};

const STATUS: Record<BuyerOrderView['status'], string> = {
  queued: 'Received',
  running: 'Being prepared',
  waiting: 'Being prepared',
  completed: 'Complete',
  declined: 'Not accepted',
  cancelled: 'Cancelled',
  failed: 'Could not be completed',
  rolled_back: 'Cancelled',
};

export const meta = ({ loaderData: d }: Route.MetaArgs) => [
  { title: `${d ? `Order ${d.ref}` : 'Order'} · CommerceWorker` },
  { name: 'robots', content: 'noindex' },
  { name: 'referrer', content: 'no-referrer' },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  const limited = await overBudget(
    'API_LIMIT',
    `receipt:${request.headers.get('cf-connecting-ip') ?? 'unknown'}`,
  );
  if (limited) throw limited;
  const credential = new URL(request.url).searchParams.get('t');
  const view =
    credential && ORDER_ID.test(params.orderId)
      ? await engine().orderReceipt(params.orderId, credential)
      : null;
  if (!view)
    throw data('This link isn’t valid, or it has expired.', { status: 404, headers: PRIVATE });
  return data(view, { headers: PRIVATE });
}

export function headers({ errorHeaders, loaderHeaders }: Route.HeadersArgs) {
  return errorHeaders ?? loaderHeaders;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const said = isRouteErrorResponse(error) && typeof error.data === 'string' ? error.data : null;
  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-24">
      <Empty
        icon={<Receipt aria-hidden="true" />}
        title={
          <h1 className="text-xl tracking-title">
            {said ? 'We can’t show this order' : 'Something went wrong'}
          </h1>
        }
      >
        {said ?? 'Try the link in your confirmation email again.'}
      </Empty>
    </main>
  );
}

export default function OrderReceiptPage() {
  const o = useLoaderData<typeof loader>();
  const cash = (n: number) => formatAmount(n, o.currency);
  return (
    <main id="main" className="mx-auto max-w-2xl px-6 pt-safe-12 pb-safe-12">
      <h1 className="font-semibold text-2xl tracking-title">Order {o.ref}</h1>
      <p className="mt-1 text-muted-foreground">
        {STATUS[o.status]} · placed {new Date(o.placedAt).toISOString().slice(0, 10)}
      </p>

      <ul className="mt-8 divide-y">
        {o.lines.map((l, i) => (
          // A line has no id of its own; the order and its position are its identity.
          <li key={`${l.sku}-${i}`} className="flex justify-between gap-4 py-3">
            <span>
              {l.qty} × {l.name}
            </span>
            {l.lineTotal !== null && <span className="tabular-nums">{cash(l.lineTotal)}</span>}
          </li>
        ))}
      </ul>

      <dl className="mt-6 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
        <dt>Subtotal</dt>
        <dd className="text-right">{cash(o.subtotal)}</dd>
        {o.shipping > 0 && (
          <>
            <dt>Shipping</dt>
            <dd className="text-right">{cash(o.shipping)}</dd>
          </>
        )}
        {o.tax > 0 && (
          <>
            <dt>Tax</dt>
            <dd className="text-right">{cash(o.tax)}</dd>
          </>
        )}
        <dt className="font-semibold">Total</dt>
        <dd className="text-right font-semibold">{cash(o.total)}</dd>
      </dl>

      {o.shipTo.length > 0 && (
        <section className="mt-8" aria-labelledby="ship-to">
          <h2 id="ship-to" className="font-semibold">
            Shipping to
          </h2>
          <p className="mt-1 text-muted-foreground">
            {o.shipTo.map((line, i) => (
              <span key={`${i}-${line}`} className="block">
                {line}
              </span>
            ))}
          </p>
        </section>
      )}

      {o.shipments.length > 0 && (
        <section className="mt-8" aria-labelledby="tracking">
          <h2 id="tracking" className="font-semibold">
            Tracking
          </h2>
          <ul className="mt-1 text-muted-foreground">
            {o.shipments.map((s) => (
              <li key={s.tracking}>
                {s.carrier ? `${s.carrier}: ` : ''}
                <span className="font-mono">{s.tracking}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
