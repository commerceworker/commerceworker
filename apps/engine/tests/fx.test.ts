import { env } from 'cloudflare:workers';
import { ECB_DAILY_URL } from '@commerceworker/core';
import { createDb, fxRates } from '@commerceworker/db';
import { inArray } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { refreshRates } from '../src/fx';

const db = () => createDb(env.DB);
const FEED = `<Cube><Cube time='2026-11-06'><Cube currency='USD' rate='1.0800'/><Cube currency='GBP' rate='0.8400'/><Cube currency='CAD' rate='1.4900'/></Cube></Cube>`;
const rates = async () =>
  Object.fromEntries(
    (
      await db()
        .select()
        .from(fxRates)
        .where(inArray(fxRates.currency, ['GBP', 'CAD', 'NOK']))
    ).map((r) => [r.currency, [r.rate, r.updatedAt]]),
  );

describe('the daily exchange-rate refresh', () => {
  it('writes the named currencies from the ECB feed, adding a currency that had no rate', async () => {
    const fetcher = vi.fn(async () => new Response(FEED));
    const r = await refreshRates({ DB: env.DB, FX_CURRENCIES: 'GBP,CAD' }, fetcher, 5_000);
    expect(r).toEqual({ ok: true, date: '2026-11-06', updated: ['GBP', 'CAD'], missing: [] });
    expect(fetcher).toHaveBeenCalledWith(ECB_DAILY_URL, expect.anything());
    expect(await rates()).toMatchObject({ GBP: [0.777778, 5_000], CAD: [1.37963, 5_000] });
  });

  it('keeps the rates it has when the feed is down or answers something else', async () => {
    await refreshRates({ DB: env.DB, FX_CURRENCIES: 'GBP' }, async () => new Response(FEED), 6_000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const down = await refreshRates(
      { DB: env.DB, FX_CURRENCIES: 'GBP' },
      async () => {
        throw new Error('network');
      },
      7_000,
    );
    const html = await refreshRates(
      { DB: env.DB, FX_CURRENCIES: 'GBP' },
      async () => new Response('<html>busy</html>', { status: 503 }),
      8_000,
    );
    warn.mockRestore();
    expect([down.ok, html.ok]).toEqual([false, false]);
    expect((await rates()).GBP).toEqual([0.777778, 6_000]);
  });

  it('does nothing when the deployment names no currencies', async () => {
    const fetcher = vi.fn();
    expect(await refreshRates({ DB: env.DB, FX_CURRENCIES: '' }, fetcher)).toMatchObject({
      ok: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
