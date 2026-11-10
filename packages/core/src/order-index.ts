/**
 * The orders index row an order's state projects to: what the orders list, the overview and the
 * reports read without opening every order. Pure: the OrderAgent derives it after each change and
 * writes it through the order records port (@commerceworker/ports/commerce) only when it differs.
 */
import type { OrderState } from './api';
import { approvalWaitingFor } from './b2b/approvals';
import { orderReason } from './reasons';
import type { FlowVersion } from './types';

export type OrderIndexRow = {
  status: string;
  total: number;
  fxRate: number;
  customerId: string | null;
  title: string;
  instanceId: string | null;
  generation: number;
  /** The open waits' titles, joined with ` · `. */
  waitingOn: string | null;
  /** The labels of the steps holding the open waits. */
  waitingAt: string | null;
  /** When the oldest open wait began. */
  waitingSince: number | null;
  /** When the soonest open wait times out; null for a timer. */
  waitingDue: number | null;
  /** What the open waits are on: `person:<role>`, `event:<name>` or `timer`. */
  waitingFor: string | null;
  /** For an order that ended badly: the labels of the steps that failed (or the end it reached). */
  stoppedAt: string | null;
  /** Why an order that ended badly ended, capped to one line. */
  reason: string | null;
};

/** The index row for an order with an order; `flow` is the version it is pinned to. */
export function orderIndexRow(
  s: OrderState & { order: NonNullable<OrderState['order']> },
  flow: Pick<FlowVersion, 'nodes'> | null,
): OrderIndexRow {
  const label = (nodeId: string) => flow?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
  // A timer (control.wait) holds the order without a PendingWait; its node is marked waiting.
  const timers = s.waits.length
    ? []
    : Object.entries(s.nodes).filter(([, r]) => r.status === 'waiting');
  // When the soonest open wait times out. A timer has no deadline, so it is never overdue.
  const dues = s.waits.flatMap((w) => (w.deadline ? [w.deadline] : []));
  const ended = ['failed', 'rolled_back', 'declined', 'cancelled'].includes(s.status);
  // Where an order that ended badly stopped: the steps that failed, or else the end it reached
  // (an end step can fail the order and roll it back, e.g. "Out of stock").
  const failedSteps = Object.entries(s.nodes).filter(([, r]) => r.status === 'failed' || r.error);
  const endsReached = Object.entries(s.nodes).filter(
    ([id, r]) =>
      r.status === 'succeeded' && flow?.nodes.find((n) => n.id === id)?.type === 'control.end',
  );
  const failed = (failedSteps.length ? failedSteps : endsReached).map(([id]) => label(id));
  return {
    status: s.status,
    total: s.order.total,
    fxRate: s.order.fxRate ?? 1,
    customerId: s.order.customerId ?? null,
    title: s.order.title ?? '',
    instanceId: s.instanceId,
    generation: s.generation,
    waitingOn: s.waits.map((w) => w.title).join(' · ') || null,
    waitingAt:
      [...s.waits.map((w) => label(w.nodeId)), ...timers.map(([id]) => label(id))].join(' · ') ||
      null,
    waitingSince: s.waits.length
      ? Math.min(...s.waits.map((w) => w.since))
      : timers.length
        ? Math.min(...timers.map(([, r]) => r.startedAt ?? s.updatedAt))
        : null,
    waitingDue: dues.length ? Math.min(...dues) : null,
    waitingFor:
      [
        ...s.waits.map((w) =>
          w.kind === 'approval' ? approvalWaitingFor(w) : `event:${w.event ?? ''}`,
        ),
        ...timers.map(() => 'timer'),
      ].join(' · ') || null,
    stoppedAt: ended && failed.length ? failed.join(' · ') : null,
    // Shown on one line in the overview and the list; orders that ended before reasons were
    // capped are capped here when they next sync.
    reason: ended && s.reason ? orderReason(s.reason) : null,
  };
}
