/**
 * Data subject requests (`erasure.ts` in core): find everything held about one person by their
 * email address, then export it or erase it. A person is a customer account with that email, a
 * guest buyer who gave it, or a sender whose email started an order. Erasing works through their
 * orders a batch at a time; the customer accounts and the rest go once no order is left. Time comes
 * in as `now`.
 */
import {
  type ErasureResult,
  eraseText,
  erasureTerms,
  type SubjectExport,
  subjectEmail,
  subjectTarget,
  taxCertificatePrefix,
} from '@commerceworker/core';
import type {
  ObjectStore,
  OrderRuntime,
  Subject,
  SubjectCarts,
  SubjectStore,
} from '@commerceworker/ports/commerce';

/** Orders erased per call; the caller repeats until `done`. */
export const ERASE_BATCH = 100;
/** Orders in one export. */
export const EXPORT_MAX = 500;

export type SubjectPorts = {
  readonly subjects: SubjectStore;
  readonly files: ObjectStore;
  readonly orders: OrderRuntime;
  readonly carts: SubjectCarts;
};

/** The subject's words to erase: their email and their accounts' names. */
const termsOf = (s: Subject) => erasureTerms([s.email, ...s.accounts.map((c) => c.name)]);

export async function exportDataSubject(
  ports: SubjectPorts,
  raw: string,
  now: number,
): Promise<SubjectExport> {
  const s = await ports.subjects.subject(subjectEmail(raw));
  const rows = await ports.subjects.orders(s, { limit: EXPORT_MAX + 1 });
  const list = rows.slice(0, EXPORT_MAX);
  const withState = await Promise.all(
    list.map(async (o) => {
      const order = (await ports.orders.snapshot(o.id)).order;
      return {
        id: o.id,
        status: o.status,
        channel: o.channel,
        externalId: o.externalId,
        createdAt: o.createdAt,
        customerId: o.customerId,
        title: order?.title ?? o.title,
        contact: order?.contact,
        lines: order?.lines,
        currency: o.currency,
        total: o.total,
        meta: order?.meta,
      };
    }),
  );
  const held = await ports.subjects.rows(
    s,
    list.map((o) => o.id),
  );
  const carts = await Promise.all([
    ...(await ports.subjects.buyerCarts(s.email, EXPORT_MAX)).map((id) =>
      ports.carts.subjectExport(id),
    ),
    ...(
      await ports.subjects.customerCarts(
        s.accounts.map((c) => c.id),
        EXPORT_MAX,
      )
    ).map((id) => ports.carts.customerExport(id)),
  ]);
  return {
    email: s.email,
    exportedAt: now,
    customers: s.accounts.map(({ stripePaymentMethodId: _pm, ...c }) => c),
    orders: withState,
    messages: held.messages,
    inboundEmails: held.inboundEmails.map(({ r2Key: _key, ...r }) => r),
    documents: held.documents,
    checkouts: (await ports.subjects.checkouts(s.email, EXPORT_MAX)).map(
      ({ id, status, buyer, shipTo, lines, orderId, createdAt }) => ({
        id,
        status,
        buyer,
        shipTo,
        lines,
        orderId,
        createdAt,
      }),
    ),
    carts: carts
      .filter((c) => c !== null)
      // Plain data, not the RPC result it came in.
      .map((c) => JSON.parse(JSON.stringify(c)) as Record<string, unknown>),
    taxCertificates: held.taxCertificates.map(({ regions, ...c }) => ({
      ...c,
      regions: JSON.parse(String(regions)) as unknown,
    })),
    addresses: held.addresses.map(({ key: _key, ...a }) => a),
    truncated: rows.length > EXPORT_MAX,
    teamMember: s.teamMember,
  };
}

/**
 * Erases the buyer from one external cart if they were erased before the cart was indexed under
 * them (carts opened before carts' buyers were indexed, which an erasure couldn't find). True if
 * it did.
 */
export async function eraseIfErased(ports: SubjectPorts, cartId: string, email: string) {
  if (!email) return false;
  if (!(await ports.subjects.wasErased(await subjectTarget(email)))) return false;
  await ports.carts.eraseSubject(cartId, termsOf(await ports.subjects.subject(email)));
  return true;
}

export async function eraseDataSubject(
  ports: SubjectPorts,
  raw: string,
  now: number,
): Promise<ErasureResult> {
  const s = await ports.subjects.subject(subjectEmail(raw));
  const terms = termsOf(s);
  const active = await ports.subjects.orders(s, { active: true, limit: 20 });
  if (active.length) return { ok: false, reason: 'active_orders', orders: active.map((o) => o.id) };

  const batch = await ports.subjects.orders(s, { limit: ERASE_BATCH + 1 });
  const list = batch.slice(0, ERASE_BATCH);
  const result = {
    ok: true as const,
    done: batch.length <= ERASE_BATCH,
    orders: 0,
    customers: 0,
    documents: 0,
    messages: 0,
    inboundEmails: 0,
    carts: 0,
    taxCertificates: 0,
    addresses: 0,
    teamMember: s.teamMember,
  };

  // Their external carts: each loses their messages and files, and stops naming them.
  for (const id of await ports.subjects.buyerCarts(s.email, EXPORT_MAX)) {
    await ports.carts.eraseSubject(id, terms);
    result.carts++;
  }
  // Staff carts for their accounts: each loses the address it would ship to, their words from its
  // title, and its events, which carried that title.
  for (const id of await ports.subjects.customerCarts(
    s.accounts.map((c) => c.id),
    EXPORT_MAX,
  )) {
    const shipTo = await ports.carts.eraseShipTo(id);
    await ports.carts.eraseFromEvents(id, terms);
    if (shipTo) result.carts++;
  }

  const erased = await eraseOrders(ports, list, terms, now);
  if (erased.refused.length) return { ok: false, reason: 'active_orders', orders: erased.refused };
  Object.assign(result, {
    orders: erased.orders,
    documents: erased.documents,
    messages: erased.messages,
    inboundEmails: erased.inboundEmails,
  });
  if (!result.done) return result;

  // No order left: what isn't tied to one, then the accounts themselves.
  for (const key of await ports.subjects.unlinkedFiles(s.email))
    result.documents += await ports.files.deletePrefix(key);
  const unlinked = await ports.subjects.eraseUnlinked(s.email);
  result.inboundEmails += unlinked.inboundEmails;
  result.messages += unlinked.messages;
  for (const c of s.accounts) {
    // Their tax certificates go whole, files and rows: a certificate names the business and its
    // registration, and no order needs it once the orders it exempted are written.
    await ports.files.deletePrefix(taxCertificatePrefix(c.id));
    const gone = await ports.subjects.eraseAccount(c.id);
    result.taxCertificates += gone.taxCertificates;
    result.addresses += gone.addresses;
    result.customers++;
  }
  return result;
}

/**
 * Erases the buyer from finished orders: each order's agent state, its files and document rows,
 * its webhook deliveries, the checkout session that placed it, the messages and intake rows that
 * belong to it, and the events of a cart submitted as it. `terms` are the subject's words to erase
 * besides each order's own contact; the retention sweep passes none. An order running again is
 * skipped and named in `refused`.
 */
export async function eraseOrders(
  ports: SubjectPorts,
  list: readonly { id: string; title: string }[],
  terms: string[],
  now: number,
) {
  const result = {
    orders: 0,
    documents: 0,
    messages: 0,
    inboundEmails: 0,
    refused: [] as string[],
  };
  const done: string[] = [];
  for (const o of list) {
    const erased = await ports.orders.erasePersonalData(o.id, terms);
    if (!erased) {
      result.refused.push(o.id);
      continue;
    }
    result.documents += await ports.files.deletePrefix(`orders/${o.id}/`);
    // An order no agent holds (its title is all the index has) is erased with the subject's
    // terms, and loses its indexed reason, free text that may name them. A held order's agent
    // re-indexed it.
    await ports.subjects.markOrderErased(
      o.id,
      { title: erased.held ? erased.title : eraseText(o.title, terms), clearReason: !erased.held },
      now,
    );
    done.push(o.id);
    result.orders++;
  }
  if (done.length) {
    const rows = await ports.subjects.eraseOrderRows(done);
    result.messages += rows.messages;
    result.inboundEmails += rows.inboundEmails;
    // A cart submitted as one of these orders: its events carried the title the order took.
    for (const id of await ports.subjects.orderCarts(done))
      await ports.carts.eraseFromEvents(id, terms);
  }
  return result;
}
