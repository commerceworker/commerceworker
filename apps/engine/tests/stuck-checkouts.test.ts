import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ORPHAN_HOLD_MS, settleOrphanedHolds } from '../src/checkout/hosted';
import { ensureTemplates } from '../src/flows';
import { checkoutSessions } from '../src/wire';
import { enableUcp, monitorCheckout, platform, ucp } from './ucp-helpers';

beforeAll(async () => {
  await ensureTemplates(env);
  await enableUcp();
});

const later = () => Date.now() + ORPHAN_HOLD_MS + 60_000;

describe('a UCP checkout left claimed, with test payments', () => {
  it('is reopened by the sweep, once: there is no hold to find, and no order was placed', async () => {
    const alpha = await platform('stuck_alpha');
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const s = (await checkoutSessions(env).load('stuck_alpha', c.id))!;
    // The Worker died after claiming it: nothing but the claim was written.
    await checkoutSessions(env).save(
      { ...s, status: 'complete_in_progress', version: s.version + 1, updatedAt: Date.now() },
      s.version,
    );
    expect((await settleOrphanedHolds(env, Date.now())).released).toBe(0);

    expect(await settleOrphanedHolds(env, later())).toMatchObject({ released: 1, failed: 0 });
    expect(await checkoutSessions(env).load('stuck_alpha', c.id)).toMatchObject({
      status: 'ready_for_complete',
      orderId: null,
    });
    expect(await settleOrphanedHolds(env, later())).toMatchObject({ released: 0 });
  });
});
