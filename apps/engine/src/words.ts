/**
 * What the engine says to people about an order: its reason, and counts in step summaries.
 */

// The reason helpers are core rules (packages/core/src/reasons.ts), kept importable from here.
export { capReason, failureReason, orderReason, REASON_MAX } from '@commerceworker/core';

/** "1 reservation" / "3 reservations". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What a `control.set` step assigned, in words: `{ cycle: 2, year: null }` → "Cycle 2". A
 * variable with no value is left out; text reads without quotes.
 */
export function varsSummary(vars: Record<string, unknown>): string {
  const words = Object.entries(vars)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${sentenceCase(k)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return words.join(', ') || 'Nothing set';
}

/**
 * Why a line can't be bought in the quantity asked: "Organic cotton tee is out of stock" when none
 * is left, else "Only 2 of Organic cotton tee are available".
 */
export const stockShort = (name: string, available: number): string =>
  available > 0 ? `Only ${available} of ${name} are available.` : `${name} is out of stock.`;

/** "next_cycle" → "Next cycle". */
const sentenceCase = (s: string) => {
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
