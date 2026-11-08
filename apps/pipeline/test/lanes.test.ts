import { describe, expect, it } from 'vitest';
import { runInLanes } from '../src/lanes';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('runInLanes', () => {
  it('keeps one lane in order while different lanes overlap, within the limit', async () => {
    const items = [
      { lane: 'a', n: 1 },
      { lane: 'b', n: 1 },
      { lane: 'a', n: 2 },
      { lane: 'c', n: 1 },
      { lane: 'a', n: 3 },
      { lane: 'b', n: 2 },
    ];
    const done: string[] = [];
    let running = 0;
    let peak = 0;
    await runInLanes(
      items,
      (i) => i.lane,
      async (i) => {
        running++;
        peak = Math.max(peak, running);
        await tick();
        done.push(`${i.lane}${i.n}`);
        running--;
      },
      2,
    );
    // Every item ran once; each lane in its original order.
    expect(done.sort()).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'c1']);
    const order = (lane: string) => done.filter((d) => d.startsWith(lane));
    expect(order('a')).toEqual(['a1', 'a2', 'a3']);
    expect(peak).toBe(2);
  });

  it('runs a lane strictly one item at a time', async () => {
    const log: string[] = [];
    await runInLanes(
      [1, 2, 3],
      () => 'same',
      async (n) => {
        log.push(`start ${n}`);
        await tick();
        log.push(`end ${n}`);
      },
      6,
    );
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
  });

  it('handles an empty batch', async () => {
    await expect(
      runInLanes(
        [],
        () => 'x',
        async () => {},
        4,
      ),
    ).resolves.toBeUndefined();
  });
});
