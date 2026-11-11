import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIFECYCLES } from '../src';

const SRC = join(import.meta.dirname, '../src');
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith('.ts')
        ? [join(dir, e.name)]
        : [],
  );

describe('the lifecycle registry', () => {
  it('lists every lifecycle core defines, so the docs reference never misses one', () => {
    const defined = sources(SRC)
      .filter((f) => !f.endsWith('lifecycle.ts'))
      .flatMap((f) =>
        [...readFileSync(f, 'utf8').matchAll(/\bdefineLifecycle\s*[<(]/g)].map(() => f),
      );
    expect(LIFECYCLES).toHaveLength(defined.length);
    expect(new Set(LIFECYCLES.map((l) => l.lifecycle)).size).toBe(defined.length);
  });

  it('names each once, and each from a start that reaches every state', () => {
    expect(new Set(LIFECYCLES.map((l) => l.id)).size).toBe(LIFECYCLES.length);
    for (const { id, start, lifecycle } of LIFECYCLES) {
      expect(lifecycle.states, id).toContain(start);
      expect([...lifecycle.reachable(start)].sort(), id).toEqual([...lifecycle.states].sort());
      expect(
        lifecycle.states.some((s) => lifecycle.terminal(s)),
        id,
      ).toBe(true);
    }
  });

  it('labels every state of the lifecycles that have labels, and no other', () => {
    for (const { id, labels, lifecycle } of LIFECYCLES)
      if (labels) expect(Object.keys(labels).sort(), id).toEqual([...lifecycle.states].sort());
  });
});
