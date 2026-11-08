import type { RecordOrder } from '@commerceworker/ports/commerce';
import { humanize, money } from './format';
import { type RecordKind, type RecordRow, stepOf } from './records';
import { orderBoard } from './wire.server';

/** Rows per kind of record. */
const PER_KIND = 30;

/** The order a record belongs to, as the page shows it. */
const base = (r: RecordOrder) => ({
  orderId: r.orderId ?? '',
  orderTitle: r.orderTitle || '',
  customer: r.customerName ?? r.contactEmail ?? null,
});

/**
 * The latest records orders wrote, by kind, newest first: payments, invoices and payouts; shipments;
 * stock holds; seller orders; messages; documents. With `q`, only those whose order (id, `#ref`,
 * title, customer, contact email) or own fields (SKU, recipient, tracking number, seller) match.
 */
export async function recentRecords(q?: string): Promise<Record<RecordKind, RecordRow[]>> {
  const {
    payments: pays,
    invoices: bills,
    payouts: outs,
    shipments: ships,
    holds,
    sellerOrders: parts,
    messages: msgs,
    documents: docs,
  } = await orderBoard().recentRecords(q ?? '', PER_KIND);

  const cash: RecordRow[] = [
    ...pays.map((p) => ({
      ...base(p),
      id: p.id,
      kind: 'money' as const,
      // "authorization:card_present" is an authorization, by card present.
      what: humanize(p.kind.split(':')[0]),
      detail:
        [
          p.kind.includes(':') ? humanize(p.kind.split(':')[1]) : null,
          p.provider === 'stripe' ? 'Stripe' : null,
          // A ref that is another row's id (a capture's authorization) says nothing here.
          p.ref && !p.ref.includes(p.orderId) ? p.ref : null,
        ]
          .filter(Boolean)
          .join(' · ') || null,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      step: stepOf(p.id, p.orderId),
      at: p.createdAt,
    })),
    ...bills.map((b) => ({
      ...base(b),
      id: b.id,
      kind: 'money' as const,
      what: `Invoice${b.number ? ` ${b.number}` : ''}`,
      detail:
        [b.provider === 'stripe' ? 'Stripe' : null, b.terms ? humanize(b.terms) : null]
          .filter(Boolean)
          .join(' · ') || null,
      amount: b.amount,
      currency: b.currency,
      status: b.status,
      step: stepOf(b.id, b.orderId),
      at: b.createdAt,
    })),
    ...outs.map((p) => ({
      ...base(p),
      id: p.id,
      kind: 'money' as const,
      what: `Payout to ${p.seller ?? p.sellerId}`,
      detail: `${money(p.gross)} gross, ${money(p.commission)} commission`,
      amount: p.net,
      currency: null,
      status: p.status,
      step: stepOf(p.id, p.orderId),
      at: p.createdAt,
    })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, PER_KIND);

  return {
    money: cash,
    shipments: ships.map((s) => ({
      ...base(s),
      id: s.id,
      kind: 'shipments' as const,
      what: [s.carrier, s.tracking].filter(Boolean).join(' ') || 'Shipment',
      detail: null,
      amount: null,
      currency: null,
      status: s.status,
      step: stepOf(s.id, s.orderId),
      at: s.createdAt,
    })),
    holds: holds.map((h) => ({
      ...base(h),
      id: h.id,
      kind: 'holds' as const,
      what: `${h.qty} × ${h.sku}`,
      detail: h.location ? `at ${h.location}` : 'at the warehouse',
      amount: null,
      currency: null,
      status: h.status,
      step: stepOf(h.id, h.orderId),
      at: h.createdAt,
    })),
    sellers: parts.map((p) => ({
      ...base(p),
      id: p.id,
      kind: 'sellers' as const,
      what: p.seller ?? p.sellerId,
      detail: p.reason,
      amount: p.subtotal,
      currency: null,
      status: p.status,
      step: null,
      at: p.createdAt,
    })),
    messages: msgs.map((m) => ({
      ...base(m),
      id: m.id,
      kind: 'messages' as const,
      what: m.subject,
      detail: `To ${m.recipient}`,
      amount: null,
      currency: null,
      status: null,
      step: null,
      at: m.createdAt,
    })),
    documents: docs.map((d) => ({
      ...base(d),
      id: d.id,
      kind: 'documents' as const,
      what: humanize(d.kind),
      detail: d.contentType,
      amount: null,
      currency: null,
      status: null,
      step: null,
      at: d.createdAt,
    })),
  };
}
