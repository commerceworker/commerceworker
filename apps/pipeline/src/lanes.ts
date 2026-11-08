/**
 * Runs `work` over `items` with up to `concurrency` lanes at once, where items sharing a lane key
 * run one after another in their original order. A queue batch's events for different entries are
 * independent (each one waits mostly on I/O: D1, KV, the search shard, the live hub), while one
 * entry's publish and unpublish must not overtake each other.
 */
export async function runInLanes<T>(
  items: readonly T[],
  laneOf: (item: T) => string,
  work: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  const lanes = new Map<string, T[]>();
  for (const item of items) {
    const key = laneOf(item);
    const lane = lanes.get(key);
    if (lane) lane.push(item);
    else lanes.set(key, [item]);
  }
  const queue = [...lanes.values()];
  const runner = async () => {
    for (let lane = queue.shift(); lane; lane = queue.shift()) {
      for (const item of lane) await work(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, runner),
  );
}
