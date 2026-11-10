/**
 * Buy X, get Y: a promotion of kind `bxgy` carries a rule instead of a `value`. Buying X units of
 * the `buy` lines earns Y units of the `get` lines at a percentage off (100 is free), as many times
 * as `repeat` allows. Pure: `applyPromotion` (./promotions.ts) calls `bxgyOffs` to turn the rule
 * into what each line gives up, and the surfaces that write a rule use `bxgyRuleSchema` and
 * `bxgyShapeProblem`, so a rule that can never apply is refused where it is made.
 *
 * Units, not lines, are counted: a line of 3 is 3 units, and a fractional remainder (2.5 is 2
 * units) counts for nothing. A unit with no price, or a price of 0, is neither bought nor
 * discounted: it can't earn a discount and has none to give.
 *
 * Which units are discounted is the buyer's best case, the usual rule: the cheapest of the `get`
 * units first. Units counted as bought stay out of the discounted ones, so with the same SKUs on
 * both sides, "buy 2, get 1 free" on six units takes the two cheapest off and needs three units
 * per group. (The surveyed design this came from scaled the whole subtotal pro rata and never
 * picked units; this does.)
 */

import { z } from 'zod';
import { money } from './logic';
import type { OrderLine } from './types';

/** Caps on what a rule may ask for, so a typo can't make one that never applies. */
export const MAX_BXGY_QTY = 1000;
export const MAX_BXGY_SKUS = 200;

const skuList = z
  .array(z.string().min(1).max(100))
  .min(1, 'A list of SKUs needs at least one; leave it out for any line')
  .max(MAX_BXGY_SKUS)
  .refine((s) => new Set(s).size === s.length, 'A SKU is listed once');
const whole = (what: string) =>
  z
    .number()
    .int(`${what} is a whole number`)
    .min(1, `${what} is at least 1`)
    .max(MAX_BXGY_QTY, `${what} is at most ${MAX_BXGY_QTY}`);
const qty = whole('A quantity');

/**
 * A rule as it is stored, and as the tool takes it (a missing field takes its default):
 * `buy.skus` null is any line; `get.skus` null is the same lines as `buy`; `percent` 100 is free;
 * `repeat` null is unlimited.
 */
export const bxgyRuleSchema = z
  .object({
    buy: z.object({ skus: skuList.nullable().default(null), qty }).strict(),
    get: z
      .object({
        skus: skuList.nullable().default(null),
        qty,
        percent: z.number().gt(0, 'A percentage is above 0').max(100).default(100),
      })
      .strict(),
    repeat: whole('Repeat').nullable().default(null),
  })
  .strict();
export type BxgyRule = z.infer<typeof bxgyRuleSchema>;

/** The rule `rule` is, or why it can't be one. */
export function parseBxgyRule(rule: unknown): { rule: BxgyRule } | { error: string } {
  const r = bxgyRuleSchema.safeParse(rule);
  return r.success
    ? { rule: r.data }
    : { error: r.error.issues[0]?.message ?? 'The rule is not a buy X, get Y rule.' };
}

/**
 * Why a promotion of `kind` can't carry `rule` and `skus`, or null when it can: `bxgy` needs a
 * valid rule and names its SKUs inside it, and no other kind takes one.
 */
export function bxgyShapeProblem(
  kind: string,
  rule: unknown,
  skus: readonly string[] | null | undefined,
): string | null {
  if (kind !== 'bxgy') return rule == null ? null : 'Only a buy X, get Y promotion takes a rule.';
  if (rule == null) return 'A buy X, get Y promotion needs its rule.';
  if (skus?.length) return 'A buy X, get Y promotion lists its SKUs inside its rule.';
  const r = parseBxgyRule(rule);
  return 'error' in r ? r.error : null;
}

const labelOf = (skus: string[] | null) => (skus ? skus.join(' or ') : 'items');

/** A rule in words, as a confirm card and the Promotions page show it: "Buy 2 TEE, get 1 free". */
export function describeBxgy(rule: BxgyRule): string {
  const { buy, get, repeat } = rule;
  const off = get.percent === 100 ? 'free' : `${get.percent}% off`;
  const what = get.skus ? `${labelOf(get.skus)} ` : '';
  return `Buy ${buy.qty} ${labelOf(buy.skus)}, get ${get.qty} ${what}${off}${
    repeat === null ? '' : `, up to ${repeat} ${repeat === 1 ? 'time' : 'times'} per order`
  }`;
}

/** What a buyer is told when the order is too small for the rule to apply once. */
export function bxgyNeeds(rule: BxgyRule): string {
  const { buy, get } = rule;
  return get.skus
    ? `${buy.qty} ${labelOf(buy.skus)} and ${get.qty} ${labelOf(get.skus)}`
    : `at least ${buy.qty + get.qty} ${labelOf(buy.skus)}`;
}

type Counted = {
  /** Whole units of the line that count (0 for a line with no price). */
  n: number;
  price: number;
  buy: boolean;
  get: boolean;
};

function count(rule: BxgyRule, lines: OrderLine[]): Counted[] {
  const getSkus = rule.get.skus ?? rule.buy.skus;
  return lines.map((l) => ({
    n: l.unitPrice && l.unitPrice > 0 ? Math.floor(l.qty) : 0,
    price: l.unitPrice ?? 0,
    buy: !rule.buy.skus || rule.buy.skus.includes(l.sku),
    get: !getSkus || getSkus.includes(l.sku),
  }));
}

/**
 * How many times the rule applies to `lines`. Each time needs X units to buy and Y to discount,
 * none counted twice: with B units that can be bought, G that can be discounted and S that can be
 * either, it is the most N with N·X ≤ B, N·Y ≤ G and N·(X+Y) ≤ B + G − S, held to `repeat`.
 */
export function bxgyGroups(rule: BxgyRule, lines: OrderLine[]): number {
  const cs = count(rule, lines);
  const sum = (f: (c: Counted) => boolean) => cs.reduce((n, c) => (f(c) ? n + c.n : n), 0);
  const B = sum((c) => c.buy);
  const G = sum((c) => c.get);
  const S = sum((c) => c.buy && c.get);
  const fits = Math.min(
    Math.floor(B / rule.buy.qty),
    Math.floor(G / rule.get.qty),
    Math.floor((B + G - S) / (rule.buy.qty + rule.get.qty)),
  );
  return Math.min(fits, rule.repeat ?? Number.POSITIVE_INFINITY);
}

/**
 * What each of `lines` gives up, in the order's currency to the cent: the cheapest units of the
 * `get` lines, as many as the rule's groups earn, each `percent` off. `cap` (also in the order's
 * currency) limits the total, every line scaled down alike. Units the groups need for buying are
 * never among the discounted ones: units that could be either are discounted only while enough
 * are left to buy with.
 */
export function bxgyOffs(rule: BxgyRule, lines: OrderLine[], cap: number): number[] {
  const cs = count(rule, lines);
  const groups = bxgyGroups(rule, lines);
  const offs = lines.map(() => 0);
  if (!groups) return offs;
  const bought = groups * rule.buy.qty;
  let need = groups * rule.get.qty;
  const onlyBuy = cs.reduce((n, c) => (c.buy && !c.get ? n + c.n : n), 0);
  const either = cs.reduce((n, c) => (c.buy && c.get ? n + c.n : n), 0);
  // Of the units that could be either, those the buying doesn't need.
  let spare = either - Math.max(0, bought - onlyBuy);
  const taken = lines.map(() => 0);
  const cheapest = cs
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.get && c.n > 0)
    .sort((a, b) => a.c.price - b.c.price || a.i - b.i);
  for (const { c, i } of cheapest) {
    if (need <= 0) break;
    const n = Math.min(c.n, need, c.buy ? spare : c.n);
    taken[i] = n;
    need -= n;
    if (c.buy) spare -= n;
  }
  const raw = cs.map((c, i) => money((taken[i] ?? 0) * c.price * (rule.get.percent / 100)));
  const total = raw.reduce((a, b) => a + b, 0);
  const scale = total > cap ? cap / total : 1;
  return raw.map((o) => (scale < 1 ? money(o * scale) : o));
}
