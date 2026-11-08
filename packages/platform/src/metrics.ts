/**
 * Operational counters for the edge target — the Workers analogue of the Node
 * worker's Prometheus metrics (same `commerceworker_*` metric names, so dashboards and
 * alerts translate). Backed by a Workers Analytics Engine dataset when the
 * METRICS binding is present; otherwise each increment is emitted as a
 * structured JSON log line (queryable/alertable via Workers Logs).
 *
 * Analytics Engine data-point layout (stable per metric, filter on index1):
 *   index1  = metric name
 *   blob1   = metric name
 *   blob2.. = label values, in the emit call's insertion order
 *   double1 = increment value
 */
export interface EdgeMetrics {
  /** Increment `metric` by `value` (default 1) with optional labels. */
  count(metric: string, value?: number, labels?: Record<string, string>): void;
}

export function makeMetrics(dataset?: AnalyticsEngineDataset): EdgeMetrics {
  return {
    count(metric, value = 1, labels = {}) {
      // Metrics must never break the request/consumer path.
      try {
        if (dataset) {
          dataset.writeDataPoint({
            indexes: [metric],
            blobs: [metric, ...Object.values(labels)],
            doubles: [value],
          });
        } else {
          console.log(JSON.stringify({ metric, value, ...labels }));
        }
      } catch (err) {
        console.error('metric emit failed', { metric, err: String(err) });
      }
    },
  };
}
