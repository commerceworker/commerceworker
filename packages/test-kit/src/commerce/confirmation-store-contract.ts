/**
 * The behaviour every `ConfirmationStore` keeps: the in-memory store runs it in node and the D1
 * store in workerd (packages/db). Codes start `cfm_c_`.
 */
import type { ConfirmationStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

const code = (id: string, expiresAt = 100, bound: Record<string, unknown> | null = null) => ({
  id,
  principalId: 'usr_ada',
  tool: 'submit_cart',
  inputDigest: 'digest-1',
  createdAt: 0,
  expiresAt,
  bound,
});

export function describeConfirmationStoreContract(
  name: string,
  make: () => Promise<ConfirmationStore>,
) {
  describe(`${name}: the confirmation store contract`, () => {
    it('uses a code once, for its caller, tool and input, before it expires', async () => {
      const s = await make();
      await s.issue(code('cfm_c_1', 100, { version: 3 }));
      expect(await s.redeem('cfm_c_1', 'usr_other', 'submit_cart', 'digest-1', 50)).toBeNull();
      expect(await s.redeem('cfm_c_1', 'usr_ada', 'cancel_cart', 'digest-1', 50)).toBeNull();
      expect(await s.redeem('cfm_c_1', 'usr_ada', 'submit_cart', 'digest-2', 50)).toBeNull();
      expect(await s.redeem('cfm_c_1', 'usr_ada', 'submit_cart', 'digest-1', 50)).toEqual({
        bound: { version: 3 },
      });
      expect(await s.redeem('cfm_c_1', 'usr_ada', 'submit_cart', 'digest-1', 51)).toBeNull();
      await s.issue(code('cfm_c_2', 100));
      expect(await s.redeem('cfm_c_2', 'usr_ada', 'submit_cart', 'digest-1', 100)).toBeNull();
      expect(await s.redeem('cfm_c_none', 'usr_ada', 'submit_cart', 'digest-1', 0)).toBeNull();
    });

    it('prunes codes that expired before a time', async () => {
      const s = await make();
      await s.issue(code('cfm_c_old', 10));
      await s.issue(code('cfm_c_new', 1_000));
      expect(await s.prune(500)).toBeGreaterThanOrEqual(1);
      await s.issue(code('cfm_c_old', 10));
    });
  });
}
