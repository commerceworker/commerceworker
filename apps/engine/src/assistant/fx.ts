/**
 * Exchange rates through the assistant, REST's and the Commerce page's twin: reading them, and
 * setting one. A rate changes what buyers pay in its currency, so setting one stops for a confirm
 * whose card shows the rate now, the new one and the change, flags a large change, and says what
 * stays as it was: orders already priced keep their `fxRate`. The use-cases are
 * `@commerceworker/application`'s, the ones REST runs.
 */
import { listFxRates, planFxRate, setFxRate } from '@commerceworker/application/commerce';
import {
  type ActionPreview,
  BASE_CURRENCY,
  FX_LARGE_CHANGE,
  type Principal,
  parseFxCurrencies,
  type ToolInput,
} from '@commerceworker/core';
import { recordAudit } from '../audit';
import { pricingStore } from '../wire';
import { Refused } from './data';

type Trail = Record<string, unknown>;

/** The currencies the deployment names: the daily refresh writes these, and a rate may be added to them. */
const allowedOf = (env: Pick<Env, 'FX_CURRENCIES'>) => parseFxCurrencies(env.FX_CURRENCIES);

export const readFxRates = (env: Env) =>
  listFxRates({ pricing: pricingStore(env) }, allowedOf(env));

/** A rate as a card shows it. */
const rate = (n: number | null) => (n === null ? 'none' : String(n));

export async function previewFxRate(
  env: Env,
  i: ToolInput<'set_fx_rate'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const { current, change, problem } = await planFxRate(
    { pricing: pricingStore(env) },
    i,
    allowedOf(env),
  );
  const percent =
    change.percent === null
      ? 'a new rate'
      : `${change.percent >= 0 ? '+' : ''}${change.percent.toFixed(2)}%`;
  const refreshed = allowedOf(env).includes(i.currency);
  return {
    title: `Set the ${i.currency} rate to ${i.rate} per ${BASE_CURRENCY}`,
    href: '/commerce#pricing',
    consequences: [
      `Now ${rate(current?.rate ?? null)}, then ${rate(i.rate)} ${i.currency} per 1 ${BASE_CURRENCY} (${percent})`,
      ...(change.large
        ? [
            `A change of ${Math.round(FX_LARGE_CHANGE * 100)}% or more: check it is not a slipped decimal point`,
          ]
        : []),
      `Carts and orders priced in ${i.currency} from now on convert at it`,
      'Orders already priced keep the rate they were priced at (their fxRate)',
      refreshed
        ? `It holds until someone changes it: the daily ECB refresh leaves a rate a person set`
        : `The daily refresh doesn't cover ${i.currency}, so it holds until someone changes it`,
    ],
    blocked: roleBlock ?? problem ?? undefined,
  };
}

export async function runFxRate(env: Env, p: Principal, i: ToolInput<'set_fx_rate'>, trail: Trail) {
  const r = await setFxRate(
    { pricing: pricingStore(env) },
    i,
    p.email ?? p.name,
    Date.now(),
    allowedOf(env),
  );
  if (!r.ok) throw new Refused(r.error);
  await recordAudit(env, r.audit.action, {
    actor: p,
    target: r.audit.target,
    detail: { ...r.audit.detail, ...trail },
  });
  return {
    done: `Set the ${r.currency} rate to ${r.rate} per ${BASE_CURRENCY}`,
    href: '/commerce#pricing',
    id: r.currency,
  };
}
