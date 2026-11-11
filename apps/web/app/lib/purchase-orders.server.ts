/**
 * Purchase orders for the list, the draft editor and the customer page. Reads only: every change
 * goes through the assistant's tools (`create_po_draft`, `update_po_draft`, `submit_po`,
 * `cancel_po`), the same use-cases REST and MCP run. A staff page reads every company's
 * (`{ all: true }`); the customer page passes its company's scope.
 */
import { getPurchaseOrder, listPurchaseOrders } from '@commerceworker/application/commerce';
import type { PurchaseOrderDetail } from '@commerceworker/core';
import type { PurchaseOrderScope } from '@commerceworker/ports/commerce';
import type { PoFilters } from './purchase-orders';
import { companyDirectory, purchaseOrderStore } from './wire.server';

export const PO_PAGE = 25;
/** POs a company's customer page lists before linking to the full list. */
export const COMPANY_PO_PAGE = 5;

const ports = () => ({ purchaseOrders: purchaseOrderStore(), companies: companyDirectory() });
const ALL: PurchaseOrderScope = { all: true };

/** A page of POs, with the names of the companies on it so a row reads as a company, not an id. */
export async function purchaseOrderPage(
  filters: PoFilters,
  cursor: string | undefined,
  scope: PurchaseOrderScope = ALL,
  limit = PO_PAGE,
) {
  const r = await listPurchaseOrders(ports(), scope, {
    companyId: filters.company,
    status: filters.status,
    search: filters.q,
    from: filters.from,
    to: filters.to,
    cursor,
    limit,
  });
  if (!r.ok) return { purchaseOrders: [], total: 0, cursor: null, companies: {}, error: r.error };
  const ids = [...new Set(r.purchaseOrders.map((p) => p.companyId))];
  const names = await Promise.all(ids.map((id) => companyDirectory().company(ALL, id)));
  return {
    purchaseOrders: r.purchaseOrders,
    total: r.total,
    cursor: r.cursor,
    companies: Object.fromEntries(names.flatMap((c) => (c ? [[c.customerId, c.name]] : []))),
    error: null,
  };
}

/** One PO with its company and, for a draft, the company's active members to pick a buyer from. */
export async function purchaseOrderDetail(id: string) {
  const r = await getPurchaseOrder(ports(), ALL, id);
  if (!r.ok) return null;
  // A read by id carries its lines (a list's rows carry a count).
  const po = r.purchaseOrder as PurchaseOrderDetail & { href: string };
  const [company, members] = await Promise.all([
    companyDirectory().company(ALL, po.companyId),
    companyDirectory().members(ALL, { companyId: po.companyId, status: 'active', limit: 100 }),
  ]);
  return {
    po,
    company: company
      ? { id: company.customerId, name: company.name, status: company.status }
      : null,
    members: members.rows.map((m) => ({ id: m.id, name: m.name, email: m.email })),
  };
}

/** The companies a new PO can be for: active ones, by name. */
export async function activeCompanies() {
  const page = await companyDirectory().companies(ALL, { status: 'active', limit: 100 });
  return page.rows.map((c) => ({ id: c.customerId, name: c.name }));
}

/** A company's newest POs for its customer page, read in its own scope. */
export async function companyPurchaseOrders(companyId: string) {
  const { purchaseOrders, total } = await purchaseOrderPage(
    {},
    undefined,
    { companyId },
    COMPANY_PO_PAGE,
  );
  return { purchaseOrders, total };
}
