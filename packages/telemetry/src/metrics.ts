/**
 * Operational metrics for the app Workers (web, engine, storefront), written to the deployment's
 * Analytics Engine dataset (`METRICS`, one dataset for all three, named by `scripts/fleet.ts`).
 * They are on for every deployment: a data point is a non-blocking write with no cost on the
 * request path, and detection has nothing to read without them (docs/operations.md, "Metrics").
 *
 * One data point per event, in a fixed layout so a query never has to guess:
 *   index1  = event (`request`, `step_failed`, `d1`, `failover`, `reconcile_mismatch`), the sampling key
 *   blob1   = event
 *   blob2   = app (`web`, `engine`, `storefront`)
 *   blob3   = what: the route group, node type, D1 path or failover kind
 *   blob4   = status class (`2xx`..`5xx`) for `request`, empty otherwise
 *   double1 = 1 (a count; sum it)
 *   double2 = milliseconds for `request` and `d1`, 0 otherwise
 *
 * Writing never blocks and never throws: a metric that can't be written is dropped.
 */

/** The part of an Analytics Engine dataset binding the writer uses (the Workers type is a global). */
export interface MetricsSink {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

export type MetricsApp = 'web' | 'engine' | 'storefront';

/**
 * What a failover counter counts: the model's heuristic answered, the gateway route's second
 * model answered, a DOCS read was served from its replica, a transactional email was refused or
 * failed. Each is working as designed and still a sign something upstream is down.
 */
export type Failover = 'ai_heuristic' | 'ai_fallback' | 'docs_replica_read' | 'email_failed';

export interface OpsMetrics {
  /** One request: its route group, status and time. */
  request(group: string, status: number, ms: number): void;
  /** An order's run failed at a node of this type (`run` when no node was to blame). */
  stepFailed(nodeType: string): void;
  /** One D1 round trip on a key path, in milliseconds. */
  d1(path: string, ms: number): void;
  failover(kind: Failover): void;
  /** A reconciliation found a difference it can't fix: what it was about (`stripe`, `intake`). */
  reconcileMismatch(what: string): void;
}

/** `2xx`, `5xx`: what an alert on the error rate groups by. */
export const statusClass = (status: number) => `${Math.floor(status / 100)}xx`;

/**
 * The group a path belongs to: the first entry whose prefix matches on a whole segment, else
 * `fallback`. Groups, not paths, so ids in a URL never become a label.
 */
export function routeGroup(
  pathname: string,
  groups: readonly (readonly [prefix: string, group: string])[],
  fallback = 'app',
): string {
  for (const [prefix, group] of groups)
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return group;
  return fallback;
}

export function opsMetrics(sink: MetricsSink | undefined, app: MetricsApp): OpsMetrics {
  const write = (event: string, what: string, statusKind: string, ms: number) => {
    if (!sink) return;
    try {
      sink.writeDataPoint({
        indexes: [event],
        blobs: [event, app, what, statusKind],
        doubles: [1, ms],
      });
    } catch (err) {
      // A warning, not an error: an error-level line is an alert, and a metric isn't worth one.
      try {
        console.warn('metric write failed', { event, err: String(err) });
      } catch {}
    }
  };
  return {
    request: (group, status, ms) => write('request', group, statusClass(status), ms),
    stepFailed: (nodeType) => write('step_failed', nodeType, '', 0),
    d1: (path, ms) => write('d1', path, '', ms),
    failover: (kind) => write('failover', kind, '', 0),
    reconcileMismatch: (what) => write('reconcile_mismatch', what, '', 0),
  };
}
