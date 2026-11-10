/**
 * The workspace's exchange rates as people see and change them: each currency's rate, when it was
 * set and by whom (the daily ECB refresh, or a person), and setting one. The REST routes, the MCP
 * tools and the rates page all run these. The rules a rate is held to (`fxRateProblem`, the
 * large-change flag, whether the daily refresh overwrites a person's rate) are core's. Time comes
 * in as `now`; the caller records the audit draft.
 */
import { BASE_CURRENCY, type FxSource, fxRateChange, fxRateProblem } from '@commerceworker/core';
import type { PricingStore } from '@commerceworker/ports/commerce';
import type { AuditDraft } from './audit-trail';

export interface FxRateListing {
  readonly currency: string;
  /** Null for a currency the deployment names but nothing has set a rate for yet. */
  readonly rate: number | null;
  readonly updatedAt: number | null;
  readonly source: FxSource | null;
  /** The person, for a person's rate. */
  readonly updatedBy: string | null;
}

/**
 * Every currency with a rate, and each `allowed` one (the registry's `fxCurrencies`) without,
 * sorted by code. Never the base currency: its rate is always 1.
 */
export async function listFxRates(
  ports: { readonly pricing: PricingStore },
  allowed: readonly string[] = [],
): Promise<{ base: string; rates: FxRateListing[] }> {
  const stored = await ports.pricing.fxRateRows();
  const rates: FxRateListing[] = stored.map((r) => ({ ...r }));
  for (const currency of allowed)
    if (currency !== BASE_CURRENCY && !stored.some((r) => r.currency === currency))
      rates.push({ currency, rate: null, updatedAt: null, source: null, updatedBy: null });
  rates.sort((a, b) => a.currency.localeCompare(b.currency));
  return { base: BASE_CURRENCY, rates };
}

/**
 * What setting a rate would do, for a preview: the rate now, the change, and why it can't go ahead
 * (`fxRateProblem`), or null.
 */
export async function planFxRate(
  ports: { readonly pricing: PricingStore },
  input: { currency: string; rate: number },
  allowed: readonly string[] = [],
) {
  const { rates } = await listFxRates(ports, allowed);
  const now = rates.find((r) => r.currency === input.currency);
  const known = rates.map((r) => r.currency);
  return {
    current: now ?? null,
    change: fxRateChange(now?.rate ?? null, input.rate),
    problem: fxRateProblem(input, known),
  };
}

/** Sets a currency's rate as a person's, unless `fxRateProblem` refuses it. */
export async function setFxRate(
  ports: { readonly pricing: PricingStore },
  input: { currency: string; rate: number },
  by: string,
  now: number,
  allowed: readonly string[] = [],
): Promise<
  | { ok: true; currency: string; rate: number; previous: number | null; audit: AuditDraft }
  | { ok: false; error: string }
> {
  const { current, change, problem } = await planFxRate(ports, input, allowed);
  if (problem) return { ok: false, error: problem };
  await ports.pricing.setFxRates([input], now, 'person', by);
  const previous = current?.rate ?? null;
  return {
    ok: true,
    currency: input.currency,
    rate: input.rate,
    previous,
    audit: {
      action: 'fx.rate_set',
      target: input.currency,
      detail: {
        from: previous,
        to: input.rate,
        ...(change.percent === null ? {} : { percent: Math.round(change.percent * 100) / 100 }),
        ...(change.large ? { large: true } : {}),
      },
    },
  };
}
