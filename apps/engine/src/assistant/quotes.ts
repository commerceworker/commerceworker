/**
 * Negotiated quotes through the assistant, REST's and the pages' twin: reading them, drafting,
 * editing and revising (no confirm: a draft prices nothing), and sending, accepting, declining,
 * ending and converting (a confirm card whose text says what it does to pricing and orders). The
 * use-cases are `@commerceworker/application`'s, the ones REST runs; the engine's own order call
 * (`QuoteOrderDeps`) is the start path every other order takes (`startOrderOnce`).
 */
import * as uc from '@commerceworker/application/commerce';
import {
  type ActionPreview,
  dayOfExpiry,
  newId,
  type Principal,
  type QuoteDetail,
  quoteTotal,
  type ToolInput,
} from '@commerceworker/core';
import { recordAudit } from '../audit';
import { startOrderOnce } from '../orders';
import {
  companyDirectory,
  orderRecords,
  pricingStore,
  purchaseOrderStore,
  quoteStore,
} from '../wire';
import { type Confirmed, Refused } from './data';

type Trail = Record<string, unknown>;

const ALL = { all: true } as const;
const ports = (env: Env) => ({
  quotes: quoteStore(env),
  companies: companyDirectory(env),
  pricing: pricingStore(env),
  purchaseOrders: purchaseOrderStore(env),
});

/** A quote's page, and where a card sends the person. */
const href = (quoteId: string) => `/quotes/${quoteId}`;

const money = (n: number) => n.toFixed(2);

/** Lines a card names one by one; a longer quote is summarised after them. */
const CARD_LINES = 25;

/**
 * What a confirm card shows of the quote being committed: its company, version and expiry, and its
 * lines with the quantity each price covers, deepest discount from list first, so the lines that
 * matter most to what a company pays are the ones named. A quote too long for the card says how
 * many lines are below list price and the deepest discount, so nothing is hidden.
 */
function quoteDetails(q: QuoteDetail): string[] {
  const off = (l: QuoteDetail['lines'][number]) =>
    l.listPrice ? Math.round((1 - l.unitPrice / l.listPrice) * 100) : 0;
  const ranked = [...q.lines].sort((a, b) => off(b) - off(a) || a.sku.localeCompare(b.sku));
  const shown = ranked.slice(0, CARD_LINES).map((l) => {
    const d = off(l);
    return `${l.sku} up to ${l.qty} at ${money(l.unitPrice)}${d > 0 ? ` (${d}% off list)` : ''}`;
  });
  const below = ranked.filter((l) => off(l) > 0);
  const deepest = ranked[0];
  return [
    `Company ${q.companyId}, version ${q.version}`,
    `Lines: ${shown.join('; ')}${q.lines.length > CARD_LINES ? `; and ${q.lines.length - CARD_LINES} more` : ''}`,
    ...(below.length && deepest
      ? [
          `${below.length} of ${q.lines.length} lines are below list price; deepest ${off(deepest)}% off on ${deepest.sku}`,
        ]
      : []),
    `Total at the quoted quantities: ${money(quoteTotal(q.lines))} (base currency)`,
    q.expiresAt === null ? 'Expiry: none set' : `Good through ${dayOfExpiry(q.expiresAt)} (UTC)`,
  ];
}

export async function readQuotes(env: Env, i: ToolInput<'list_quotes'>) {
  const r = await uc.listQuotes(ports(env), ALL, i);
  if (!r.ok) throw new Refused(r.error);
  const { ok: _, ...rest } = r;
  return rest;
}

export async function readQuote(env: Env, i: ToolInput<'get_quote'>) {
  const r = await uc.getQuote(ports(env), ALL, i.quoteId);
  if (!r.ok) throw new Refused(r.error);
  const { ok: _, ...rest } = r;
  return rest;
}

async function audited(
  env: Env,
  p: Principal,
  audit: uc.AuditDraft | null,
  trail: Trail,
): Promise<void> {
  if (audit)
    await recordAudit(env, audit.action, {
      actor: p,
      target: audit.target ?? null,
      detail: { ...audit.detail, ...trail },
    });
}

export async function openQuote(
  env: Env,
  p: Principal,
  i: ToolInput<'create_quote'>,
  trail: Trail,
) {
  const r = await uc.createQuote(ports(env), ALL, i, () => newId('qt'), Date.now(), p.id);
  if (!r.ok) throw new Refused(r.error);
  await audited(env, p, r.audit, trail);
  return {
    done: `Drafted quote ${r.quote.name}`,
    href: href(r.quote.id),
    quote: uc.quoteView(r.quote),
  };
}

export async function changeQuote(
  env: Env,
  p: Principal,
  i: ToolInput<'update_quote'>,
  trail: Trail,
) {
  const r = await uc.updateQuote(ports(env), ALL, i, Date.now());
  if (!r.ok) throw new Refused(r.error);
  await audited(env, p, r.audit, trail);
  return {
    done: r.changed ? `Changed quote ${r.quote.name}` : `Quote ${r.quote.name} is as asked`,
    href: href(r.quote.id),
    quote: uc.quoteView(r.quote),
  };
}

export async function nextQuoteVersion(
  env: Env,
  p: Principal,
  i: ToolInput<'revise_quote'>,
  trail: Trail,
) {
  const r = await uc.reviseQuote(ports(env), ALL, i, () => newId('qt'), Date.now(), p.id);
  if (!r.ok) throw new Refused(r.error);
  await audited(env, p, r.audit, trail);
  return {
    done: r.changed
      ? `Started version ${r.quote.version} of quote ${r.quote.name}`
      : `Version ${r.quote.version} of quote ${r.quote.name} was already started`,
    href: href(r.quote.id),
    quote: uc.quoteView(r.quote),
  };
}

/** The engine's order start for a quote: the one every order takes, once per key. */
function orderDeps(env: Env, p: Principal, trail: Trail): uc.QuoteOrderDeps {
  return {
    async start(req) {
      try {
        // A start being finished goes back to the flow the first try named, not the default.
        const prior = req.resumed ? await orderRecords(env).byIdempotencyKey(req.key) : undefined;
        const started = await startOrderOnce(env, {
          flowId: prior?.flowId ?? req.flowId,
          input: req.input,
          startedBy: p.id,
          idempotencyKey: req.key,
        });
        if ('mismatch' in started)
          return { ok: false, error: 'This quote already started an order on another flow.' };
        if (!started.replayed)
          await recordAudit(env, 'order.started', {
            actor: p,
            target: started.orderId,
            detail: { flowId: req.flowId, quote: req.input.meta?.quoteId, ...trail },
          });
        return { ok: true, orderId: started.orderId, replayed: !!started.replayed };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

const blockedCard = (title: string, error: string, roleBlock?: string): ActionPreview => ({
  title,
  consequences: [],
  blocked: roleBlock ?? error,
});

export async function previewSendQuote(
  env: Env,
  i: ToolInput<'send_quote'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const plan = await uc.planSendQuote(ports(env), ALL, i, Date.now());
  if (!plan.ok) return blockedCard('Send a quote', plan.error, roleBlock);
  const q = plan.quote;
  return {
    title: `Send quote ${q.name}`,
    href: href(q.id),
    consequences: plan.repeat
      ? ['It has been sent already; nothing changes']
      : [...quoteDetails(q), 'It can’t be edited once sent; a change is a new version'],
    blocked: roleBlock,
    // What the person sees is this draft; confirming sends only this draft.
    bound: { quote: uc.quoteFingerprint(q) },
  };
}

export async function runSendQuote(
  env: Env,
  p: Principal,
  i: ToolInput<'send_quote'>,
  trail: Trail,
  confirmed?: Confirmed,
) {
  // A confirm that was shown a preview is held to what it showed; a call with none (REST's) isn't.
  const held =
    confirmed && confirmed !== 'direct' && typeof confirmed.bound?.quote === 'string'
      ? confirmed.bound.quote
      : undefined;
  const r = await uc.sendQuote(ports(env), ALL, { ...i, heldTo: held }, Date.now());
  if (!r.ok) throw new Refused(r.error);
  await audited(env, p, r.audit, trail);
  return { done: `Sent quote ${r.quote.name}`, href: href(r.quote.id), id: r.quote.id };
}

export async function previewAcceptQuote(
  env: Env,
  i: ToolInput<'accept_quote'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const plan = await uc.planAcceptQuote(ports(env), ALL, i, Date.now());
  if (!plan.ok) return blockedCard('Accept a quote', plan.error, roleBlock);
  const q = plan.quote;
  return {
    title: `Accept quote ${q.name}`,
    href: href(q.id),
    consequences: plan.repeat
      ? ['It has been accepted already; nothing changes']
      : [
          `Records that ${q.companyId} accepted it`,
          ...quoteDetails(q),
          `Until it ends, the company’s orders are priced at these prices, ahead of every other price, up to each line’s quantity`,
          'The quoted quantity isn’t used up: every order of the company gets the price until the quote ends',
        ],
    blocked: roleBlock,
  };
}

export async function runAcceptQuote(
  env: Env,
  p: Principal,
  i: ToolInput<'accept_quote'>,
  trail: Trail,
) {
  const r = await uc.acceptQuote(ports(env), ALL, i, Date.now());
  if (!r.ok) throw new Refused(r.error);
  await audited(env, p, r.audit, trail);
  return { done: `Accepted quote ${r.quote.name}`, href: href(r.quote.id), id: r.quote.id };
}

export async function previewDeclineQuote(
  env: Env,
  i: ToolInput<'decline_quote'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const plan = await uc.planDeclineQuote(ports(env), ALL, i);
  if (!plan.ok) return blockedCard('Decline a quote', plan.error, roleBlock);
  const q = plan.quote;
  return {
    title: `Decline quote ${q.name}`,
    href: href(q.id),
    consequences: plan.repeat
      ? ['It has been declined already; nothing changes']
      : [
          plan.from === 'draft'
            ? 'Withdraws the draft: it is never sent'
            : `Records that ${q.companyId} declined it`,
          'Nothing is priced from it; it can be revised into a new version',
        ],
    blocked: roleBlock,
  };
}

export async function runDeclineQuote(
  env: Env,
  p: Principal,
  i: ToolInput<'decline_quote'>,
  trail: Trail,
) {
  const r = await uc.declineQuote(ports(env), ALL, i, Date.now());
  if (!r.ok) throw new Refused(r.error);
  await audited(env, p, r.audit, trail);
  return { done: `Declined quote ${r.quote.name}`, href: href(r.quote.id), id: r.quote.id };
}

export async function previewExpireQuote(
  env: Env,
  i: ToolInput<'expire_quote'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const plan = await uc.planExpireQuote(ports(env), ALL, i);
  if (!plan.ok) return blockedCard('End a quote', plan.error, roleBlock);
  const q = plan.quote;
  return {
    title: `End quote ${q.name}`,
    href: href(q.id),
    consequences: plan.repeat
      ? ['It has ended already; nothing changes']
      : [
          plan.from === 'accepted'
            ? `Orders from ${q.companyId} stop being priced from it at once`
            : 'It can no longer be accepted',
          'Orders already priced keep their prices',
          'It can be revised into a new version',
        ],
    blocked: roleBlock,
  };
}

export async function runExpireQuote(
  env: Env,
  p: Principal,
  i: ToolInput<'expire_quote'>,
  trail: Trail,
) {
  const r = await uc.expireQuote(ports(env), ALL, i, Date.now());
  if (!r.ok) throw new Refused(r.error);
  await audited(env, p, r.audit, trail);
  return { done: `Ended quote ${r.quote.name}`, href: href(r.quote.id), id: r.quote.id };
}

export async function previewConvertQuote(
  env: Env,
  i: ToolInput<'convert_quote'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const plan = await uc.planConvertQuote(ports(env), ALL, i, Date.now());
  if (!plan.ok) return blockedCard('Convert a quote', plan.error, roleBlock);
  const q = plan.quote;
  return {
    title: `Convert quote ${q.name}`,
    href: href(q.id),
    consequences: plan.resume
      ? [
          plan.to === 'po'
            ? `It was converted to the purchase order draft ${q.convertedId} but the draft was never made: this makes it`
            : 'It was converted to an order that never started: this starts it, priced at the quote',
          ...quoteDetails(q),
        ]
      : plan.repeat
        ? [
            `It was converted already, to ${q.convertedTo === 'po' ? 'a purchase order draft' : 'an order'} ${q.convertedId}; nothing new is made`,
            ...quoteDetails(q),
          ]
        : plan.to === 'po'
          ? [
              ...quoteDetails(q),
              `Makes a draft purchase order numbered ${plan.poNumber} with the quote’s ${q.lines.length} line${q.lines.length === 1 ? '' : 's'} at their quoted prices`,
              'The draft starts nothing: submitting it sends the order through credit, budgets and approvals',
            ]
          : [
              ...quoteDetails(q),
              `Starts an order of ${q.lines.length} line${q.lines.length === 1 ? '' : 's'} for ${q.companyId} on ${plan.flowId}, priced at the quote`,
              'The order is held to the company’s credit limit and budgets, and goes to its approvers when the flow asks',
            ],
    blocked: roleBlock,
  };
}

export async function runConvertQuote(
  env: Env,
  p: Principal,
  i: ToolInput<'convert_quote'>,
  trail: Trail,
) {
  const r = await uc.convertQuote(ports(env), ALL, i, orderDeps(env, p, trail), Date.now());
  if (!r.ok) throw new Refused(r.error);
  await audited(env, p, r.audit, trail);
  const page = r.to === 'po' ? `/purchase-orders/${r.resultId}` : `/orders/${r.resultId}`;
  return {
    done:
      r.to === 'po'
        ? `Converted quote ${r.quote.name} to purchase order draft ${r.resultId}`
        : `Converted quote ${r.quote.name} to order ${r.resultId}`,
    href: page,
    id: r.quote.id,
  };
}
