import { describe, expect, it } from 'vitest';
import { JournaledMap } from '../src/journaled-map';

function seeded(): JournaledMap<string, { n: number; list: number[] }> {
  const m = new JournaledMap<string, { n: number; list: number[] }>();
  m.set('a', { n: 1, list: [1] });
  m.set('b', { n: 2, list: [2] });
  m.set('c', { n: 3, list: [3] });
  return m;
}

describe('JournaledMap', () => {
  it('rolls back sets, inserts, deletes and in-place mutation, keeping the key order', () => {
    const m = seeded();
    const j = m.begin();
    m.set('a', { n: 10, list: [] });
    m.get('b')?.list.push(20);
    m.delete('c');
    m.set('d', { n: 4, list: [4] });
    m.rollback(j);
    expect([...m]).toEqual([
      ['a', { n: 1, list: [1] }],
      ['b', { n: 2, list: [2] }],
      ['c', { n: 3, list: [3] }],
    ]);
  });

  it('rolls back a clear, and mutation of values reached by iterating', () => {
    const m = seeded();
    const j = m.begin();
    for (const v of m.values()) v.n += 100;
    m.clear();
    m.rollback(j);
    expect([...m.values()].map((v) => v.n)).toEqual([1, 2, 3]);
  });

  it('keeps what a committed transaction wrote, and records nothing once it closes', () => {
    const m = seeded();
    const j = m.begin();
    m.set('a', { n: 10, list: [] });
    m.commit(j);
    m.get('b')?.list.push(20);
    expect(m.get('a')?.n).toBe(10);
    expect(m.get('b')?.list).toEqual([2, 20]);
    expect(j.before.has('b')).toBe(false);
  });

  it('rolls back one of two open transactions to the state it began from', () => {
    const m = seeded();
    const first = m.begin();
    m.set('a', { n: 10, list: [] });
    const second = m.begin();
    m.set('b', { n: 20, list: [] });
    m.rollback(second);
    expect(m.get('a')?.n).toBe(10);
    expect(m.get('b')?.n).toBe(2);
    m.rollback(first);
    expect(m.get('a')?.n).toBe(1);
  });
});
