/**
 * Price books through the assistant, REST's and the Price books pages' twin: reading books, a
 * book's entries and what a customer would pay, and the writes: adding a book, moving it along
 * its lifecycle, setting its entries, assigning it, and writing contract prices. Every write
 * changes what buyers pay, so each stops for a confirm whose card says what changes and for whom,
 * and that the book prices nothing until it is active and inside its dates. The use-cases are
 * `@commerceworker/application`'s, the ones REST runs; a card's `blocked` is their `plan…`.
 */
import {
  assignPriceBook,
  createPriceBook,
  getPriceBook,
  listPriceBooks,
  planContractPrices,
  planPriceBook,
  planPriceBookAssignment,
  planPriceBookEntries,
  planPriceBookStatus,
  previewPrice,
  putContractPrices,
  putPriceBookEntries,
  setPriceBookStatus,
} from '@commerceworker/application/commerce';
import {
  type ActionPreview,
  BASE_CURRENCY,
  newId,
  type Principal,
  priceBookState,
  type ToolInput,
} from '@commerceworker/core';
import { recordAudit } from '../audit';
import { companyDirectory, priceBookStore, pricingStore } from '../wire';
import { money, Refused } from './data';

type Trail = Record<string, unknown>;

const ALL = { all: true } as const;
const ports = (env: Env) => ({
  books: priceBookStore(env),
  pricing: pricingStore(env),
  companies: companyDirectory(env),
});

export const readPriceBooks = (env: Env, i: ToolInput<'list_price_books'>) =>
  listPriceBooks({ books: priceBookStore(env) }, i);

export async function readPriceBook(env: Env, i: ToolInput<'get_price_book'>) {
  const r = await getPriceBook({ books: priceBookStore(env) }, i);
  if (!r.ok) throw new Refused(r.error);
  const { ok: _ok, ...answer } = r;
  return answer;
}

export async function readPricePreview(env: Env, i: ToolInput<'preview_price'>) {
  const r = await previewPrice({ pricing: pricingStore(env) }, i, Date.now());
  if (!r.ok) throw new Refused(r.error);
  const { ok: _ok, ...answer } = r;
  return answer;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The dates a card says a book is in force between. */
const when = (b: { startsAt: number | null; endsAt: number | null }) =>
  b.startsAt === null && b.endsAt === null
    ? 'No dates: in force whenever it is active'
    : `In force ${b.startsAt === null ? 'from now' : `from ${day(b.startsAt)}`}${b.endsAt === null ? '' : ` until ${day(b.endsAt)}`}`;

const href = (id?: string) => (id ? `/price-books/${id}` : '/price-books');

export async function previewCreatePriceBook(
  env: Env,
  i: ToolInput<'create_price_book'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const { code, problem } = planPriceBook(i);
  const taken = code ? await priceBookStore(env).find(code) : undefined;
  return {
    title: `Add the price book ${code ?? i.code}`,
    href: href(),
    consequences: [
      `${i.name.trim()}, priority ${i.priority ?? 0}: the higher number wins when several books assigned to a customer price a line`,
      when({ startsAt: i.startsAt ?? null, endsAt: i.endsAt ?? null }),
      'Starts as a draft: it prices nothing until it has entries, is assigned and is made active',
    ],
    blocked:
      roleBlock ??
      problem ??
      (taken ? `The code ${code} is taken by another price book.` : undefined),
  };
}

export async function runCreatePriceBook(
  env: Env,
  p: Principal,
  i: ToolInput<'create_price_book'>,
  trail: Trail,
) {
  const r = await createPriceBook(ports(env), i, p.email ?? p.name, Date.now(), newId('pb'));
  if (!r.ok) throw new Refused(r.error);
  await recordAudit(env, r.audit.action, {
    actor: p,
    target: r.audit.target,
    detail: { ...r.audit.detail, ...trail },
  });
  return { done: `Added the price book ${r.book.code}`, href: href(r.book.id), id: r.book.id };
}

const VERB = { active: 'Activate', inactive: 'Deactivate', archived: 'Archive' } as const;

export async function previewPriceBookStatus(
  env: Env,
  i: ToolInput<'set_price_book_status'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const plan = await planPriceBookStatus(ports(env), i, Date.now());
  const b = plan.book;
  const effect =
    i.status === 'active'
      ? [
          `Its ${plan.entries} entries price ${plan.assigned} ${plan.assigned === 1 ? 'assignee' : 'assignees'} (customers and tiers) from now, ahead of lower-priority books`,
          plan.inDates
            ? 'Orders priced from now on use it; orders already priced keep their prices'
            : 'Its dates keep it out of force for now',
        ]
      : i.status === 'inactive'
        ? [
            'Its assignees go back to the prices they would pay without it: other books, contract prices, list',
            'Orders already priced keep their prices',
          ]
        : [
            'Archiving is for good: the book and its entries stay for the record, but it can never be active again',
          ];
  return {
    title: `${VERB[i.status]} ${b?.name ?? 'a price book'}`,
    href: href(b?.id),
    consequences: [
      ...(b
        ? [`${b.name}: ${priceBookState(b, Date.now())}, priority ${b.priority}`, when(b)]
        : []),
      ...effect,
    ],
    blocked: roleBlock ?? plan.problem ?? undefined,
  };
}

export async function runPriceBookStatus(
  env: Env,
  p: Principal,
  i: ToolInput<'set_price_book_status'>,
  trail: Trail,
) {
  const r = await setPriceBookStatus(ports(env), i, Date.now());
  if (!r.ok) throw new Refused(r.error);
  await recordAudit(env, r.audit.action, {
    actor: p,
    target: r.audit.target,
    detail: { ...r.audit.detail, ...trail },
  });
  return { done: `${VERB[i.status]}d ${r.book.name}`, href: href(r.book.id) };
}

export async function previewPriceBookEntries(
  env: Env,
  i: ToolInput<'put_price_book_entries'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const plan = await planPriceBookEntries(ports(env), i, Date.now());
  const b = plan.book;
  const sample = i.entries
    .filter((e) => !e.remove)
    .slice(0, 5)
    .map(
      (e) =>
        `${e.sku}${e.minQty && e.minQty > 1 ? ` from ${e.minQty}` : ''}: ${e.price !== undefined ? money(e.price, BASE_CURRENCY) : `${e.discountPct}% off list`}`,
    );
  const live = b?.status === 'active' && plan.inDates;
  return {
    title: `Set ${i.entries.length} ${i.entries.length === 1 ? 'entry' : 'entries'} in ${b?.name ?? 'a price book'}`,
    href: href(b?.id),
    consequences: [
      `Adds or replaces ${plan.puts}, removes ${plan.removes} (prices in ${BASE_CURRENCY}, the base currency)`,
      ...sample,
      ...(plan.puts > sample.length ? [`and ${plan.puts - sample.length} more`] : []),
      live
        ? `It is in force: what ${plan.assigned} ${plan.assigned === 1 ? 'assignee' : 'assignees'} pay changes at once for new orders; orders already priced keep their prices`
        : 'It is not in force (draft, inactive or outside its dates), so no price changes yet',
    ],
    blocked: roleBlock ?? plan.problem ?? undefined,
  };
}

export async function runPriceBookEntries(
  env: Env,
  p: Principal,
  i: ToolInput<'put_price_book_entries'>,
  trail: Trail,
) {
  const r = await putPriceBookEntries(ports(env), i, Date.now());
  if (!r.ok) throw new Refused(r.error);
  await recordAudit(env, r.audit.action, {
    actor: p,
    target: r.audit.target,
    detail: { ...r.audit.detail, ...trail },
  });
  return {
    done: `Set ${r.put} and removed ${r.removed} in ${r.book.name}`,
    href: href(r.book.id),
  };
}

export async function previewPriceBookAssignment(
  env: Env,
  i: ToolInput<'assign_price_book'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const { book, to, customer, problem } = await planPriceBookAssignment(ports(env), i);
  const who = !to
    ? 'a customer or tier'
    : 'customerId' in to
      ? (customer?.name ?? to.customerId)
      : `every ${to.tier} customer`;
  return {
    title: `${i.remove ? 'Take' : 'Assign'} ${book?.name ?? 'a price book'} ${i.remove ? 'away from' : 'to'} ${who}`,
    href: href(book?.id),
    consequences: [
      ...(book
        ? [`${book.name}: ${priceBookState(book, Date.now())}, priority ${book.priority}`]
        : []),
      i.remove
        ? `${who} no longer pays its prices; orders already priced keep theirs`
        : `${who} pays its prices while it is in force, where it outranks lower-priority books`,
    ],
    blocked: roleBlock ?? problem ?? undefined,
  };
}

export async function runPriceBookAssignment(
  env: Env,
  p: Principal,
  i: ToolInput<'assign_price_book'>,
  trail: Trail,
) {
  const r = await assignPriceBook(ports(env), i, Date.now());
  if (!r.ok) throw new Refused(r.error);
  await recordAudit(env, r.audit.action, {
    actor: p,
    target: r.audit.target,
    detail: { ...r.audit.detail, ...trail },
  });
  return {
    done: `${i.remove ? 'Took away' : 'Assigned'} ${r.book.name}`,
    href: href(r.book.id),
  };
}

export async function previewContractPrices(
  env: Env,
  i: ToolInput<'put_contract_prices'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const plan = await planContractPrices(ports(env), ALL, i);
  const who = plan.customer?.name ?? i.customerId;
  const sample = i.prices
    .slice(0, 5)
    .map((c) => `${c.sku}: ${c.price === null ? 'remove' : money(c.price, BASE_CURRENCY)}`);
  return {
    title: `Set ${i.prices.length} contract ${i.prices.length === 1 ? 'price' : 'prices'} for ${who}`,
    href: `/customers/${i.customerId}`,
    consequences: [
      `Sets ${plan.sets}, removes ${plan.removes} (prices in ${BASE_CURRENCY}, the base currency)`,
      ...sample,
      ...(i.prices.length > sample.length ? [`and ${i.prices.length - sample.length} more`] : []),
      `${who}'s new orders use them: a contract price is what was agreed, even above list price; orders already priced keep theirs`,
    ],
    blocked: roleBlock ?? plan.problem ?? undefined,
  };
}

export async function runContractPrices(
  env: Env,
  p: Principal,
  i: ToolInput<'put_contract_prices'>,
  trail: Trail,
) {
  const r = await putContractPrices(ports(env), ALL, i);
  if (!r.ok) throw new Refused(r.error);
  await recordAudit(env, r.audit.action, {
    actor: p,
    target: r.audit.target,
    detail: { ...r.audit.detail, ...trail },
  });
  return {
    done: `Set ${r.set} and removed ${r.removed} contract prices`,
    href: `/customers/${i.customerId}`,
  };
}
