/**
 * The behaviour every `OrderViewTokens` keeps: the in-memory store runs it in node and the D1 store
 * in workerd (packages/db). Order ids start `ov_`, which the D1 runner clears before each case.
 */
import type { OrderViewTokens } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

const now = 1_000_000;
const hash = (c: string) => c.repeat(64).slice(0, 64);

export function describeOrderViewTokensContract(
  name: string,
  make: () => Promise<OrderViewTokens>,
) {
  describe(`${name}: the order-view tokens contract`, () => {
    it('lists an order’s live hashes and no other order’s', async () => {
      const tokens = await make();
      await tokens.issue('ov_1', hash('a'), now, now + 100);
      await tokens.issue('ov_2', hash('b'), now, now + 100);
      expect(await tokens.live('ov_1', now + 1)).toEqual([hash('a')]);
      expect(await tokens.live('ov_none', now + 1)).toEqual([]);
    });

    it('stops listing a hash at its expiry', async () => {
      const tokens = await make();
      await tokens.issue('ov_3', hash('c'), now, now + 100);
      expect(await tokens.live('ov_3', now + 99)).toEqual([hash('c')]);
      expect(await tokens.live('ov_3', now + 100)).toEqual([]);
    });

    it('keeps one row for a hash issued twice, and drops the expired when it issues', async () => {
      const tokens = await make();
      await tokens.issue('ov_4', hash('d'), now, now + 10);
      await tokens.issue('ov_4', hash('d'), now, now + 10);
      await tokens.issue('ov_4', hash('e'), now + 50, now + 500);
      expect(await tokens.live('ov_4', now + 60)).toEqual([hash('e')]);
    });

    it('revokes every credential of the orders it is given', async () => {
      const tokens = await make();
      await tokens.issue('ov_5', hash('f'), now, now + 100);
      await tokens.issue('ov_5', hash('0'), now, now + 100);
      await tokens.issue('ov_6', hash('1'), now, now + 100);
      expect(await tokens.revoke(['ov_5'])).toBe(2);
      expect(await tokens.live('ov_5', now + 1)).toEqual([]);
      expect(await tokens.live('ov_6', now + 1)).toEqual([hash('1')]);
    });
  });
}
