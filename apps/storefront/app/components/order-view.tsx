import { type BuyerOrderView, formatAmount } from '@commerceworker/core';

/** What the buyer is told of an order's status. */
export const STATUS: Record<BuyerOrderView['status'], string> = {
  queued: 'Received',
  running: 'Being prepared',
  waiting: 'Being prepared',
  completed: 'Complete',
  declined: 'Not accepted',
  cancelled: 'Cancelled',
  failed: 'Could not be completed',
  rolled_back: 'Cancelled',
};

/** A day as the buyer reads it, in UTC so the server and the browser agree. */
export const placedOn = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * An order as its buyer may see it (`BuyerOrderView`: lines, totals, status, ship-to, tracking),
 * for the receipt a confirmation email links to and for a signed-in shopper's own order. The caller
 * owns the page around it. A line has no id of its own; the order and its position are its identity.
 */
export function OrderView({ order: o }: { order: BuyerOrderView }) {
  const cash = (n: number) => formatAmount(n, o.currency);
  return (
    <>
      <h1 className="font-semibold text-2xl tracking-title">Order {o.ref}</h1>
      <p className="mt-1 text-muted-foreground">
        {STATUS[o.status]} · placed {placedOn(o.placedAt)}
      </p>

      <ul className="mt-8 divide-y">
        {o.lines.map((l, i) => (
          <li key={`${l.sku}-${i}`} className="flex justify-between gap-4 py-3">
            <span className="min-w-0 break-words">
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
    </>
  );
}
