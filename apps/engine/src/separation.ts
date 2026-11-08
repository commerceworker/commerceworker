/**
 * Separation of duties on approvals: with the workspace's `approval_separation` setting on, the
 * principal who started an order may not decide its approvals (`ownOrderRefusal` in core). The
 * OrderAgent checks it on every decision; the RPC and the assistant check first, to answer in
 * their own terms. It also holds a claim with nothing to send back (`planReturn` in the assistant),
 * which refunds at once with no goods to check.
 */

import { APPROVAL_SEPARATION_KEY, ownOrderRefusal } from '@commerceworker/core';
import { orderRecords, workspaceStore } from './wire';

/** Why `deciderId` may not decide approvals on `orderId`, or null. */
export async function separationRefusal(
  env: Env,
  orderId: string,
  deciderId: string | undefined,
): Promise<string | null> {
  if (!deciderId) return null;
  const [setting, startedBy] = await Promise.all([
    workspaceStore(env).setting(APPROVAL_SEPARATION_KEY),
    orderRecords(env).startedBy(orderId),
  ]);
  return ownOrderRefusal(setting === 'on', startedBy, deciderId);
}
