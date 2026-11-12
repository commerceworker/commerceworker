/**
 * The hourly check that an order the database calls `running` still has a Workflow going. A
 * Workflow instance that errored or was terminated (by an operator, or by Workflows itself) leaves
 * its order running in D1 for good: nothing reports, nothing fails it. Each mismatch is logged as
 * `order_workflow_mismatch` at error level, which Workers Issues turns into an alert, so a stranded
 * order pages someone instead of waiting for its buyer to ask.
 */
import { ops } from './metrics';
import { instanceIdFor } from './orders';
import { orderRecords } from './wire';

/** The most orders checked in an hour: each is a Workflow call, and Workers caps subrequests. */
export const SWEEP_CAP = 200;
/** A row quieter than this is worth a look; a newer one may be a report still on its way. */
export const SWEEP_QUIET_MS = 15 * 60_000;

/** Instance statuses a running order may have: the Workflow is going, or about to. */
const LIVE = new Set(['queued', 'running', 'waiting', 'waitingForPause', 'paused']);

export async function sweepOrderInstances(
  env: Env,
  now = Date.now(),
  cap = SWEEP_CAP,
): Promise<{ checked: number; mismatched: number; errors: number }> {
  const counts = { checked: 0, mismatched: 0, errors: 0 };
  const started = Date.now();
  const running = await orderRecords(env).staleRunning(now - SWEEP_QUIET_MS, cap);
  ops().d1('order_sweep', Date.now() - started);
  for (const o of running) {
    const instanceId = o.instanceId ?? instanceIdFor(o.id);
    counts.checked++;
    let status: string;
    try {
      status = (await (await env.ORDER_WORKFLOW.get(instanceId)).status()).status;
    } catch (err) {
      // Only a definite not-found means there is no instance; anything else is Workflows being
      // unreachable, which says nothing about the order.
      if (!/not[_ ]found/i.test(err instanceof Error ? err.message : String(err))) {
        counts.errors++;
        console.warn(JSON.stringify({ type: 'order_workflow_check_failed', orderId: o.id }), err);
        continue;
      }
      status = 'unknown';
    }
    if (LIVE.has(status)) continue;
    counts.mismatched++;
    console.error(
      JSON.stringify({
        type: 'order_workflow_mismatch',
        orderId: o.id,
        instanceId,
        order: 'running',
        workflow: status,
      }),
    );
  }
  // The cap is a bound, not a verdict: say so when orders were left for the next hour.
  if (running.length === cap)
    console.warn(JSON.stringify({ type: 'order_workflow_sweep_capped', cap }));
  return counts;
}
