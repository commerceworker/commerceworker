/**
 * The confirmations port (`ConfirmationStore`, @commerceworker/ports/commerce) on D1: the
 * `action_confirmations` table. Moved here from the engine. A code's use is one guarded update.
 * The contract in @commerceworker/test-kit/commerce holds this and the in-memory store to the same
 * behaviour.
 */
import type { ConfirmationStore } from '@commerceworker/ports/commerce';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { createDb } from './index';
import { actionConfirmations } from './schema';

export function d1ConfirmationStore(d1: D1Database): ConfirmationStore {
  const d = createDb(d1);
  return {
    async issue(c) {
      await d
        .insert(actionConfirmations)
        .values({ ...c, bound: c.bound ? JSON.stringify(c.bound) : null });
    },

    async redeem(code, principalId, tool, inputDigest, now) {
      const used = await d
        .update(actionConfirmations)
        .set({ usedAt: now })
        .where(
          and(
            eq(actionConfirmations.id, code),
            eq(actionConfirmations.principalId, principalId),
            eq(actionConfirmations.tool, tool),
            eq(actionConfirmations.inputDigest, inputDigest),
            isNull(actionConfirmations.usedAt),
            gt(actionConfirmations.expiresAt, now),
          ),
        )
        .returning({ bound: actionConfirmations.bound });
      if (used.length !== 1) return null;
      const bound = used[0]!.bound;
      return { bound: bound ? (JSON.parse(bound) as Record<string, unknown>) : null };
    },

    async prune(before) {
      const gone = await d
        .delete(actionConfirmations)
        .where(lt(actionConfirmations.expiresAt, before))
        .returning({ id: actionConfirmations.id });
      return gone.length;
    },
  };
}
