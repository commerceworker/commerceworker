import { describe, expect, it } from 'vitest';
import {
  entryReference,
  evaluateLogic,
  interpolate,
  logicHolds,
  logicIssues,
  type RunContext,
} from '../src/index';

const ctx: RunContext = {
  entry: {
    id: 'e1',
    contentTypeApiId: 'article',
    status: 'draft',
    title: 'Spring launch',
    tags: ['legal', 'news'],
    fields: { title: { 'en-US': 'Spring launch' } },
  },
  nodes: { validate: { valid: true, issues: [] } },
  vars: { cycle: 2, locales: ['de-DE', 'fr-FR'], i: 1, total: 1200 },
  input: { changedFields: ['body'] },
  now: 1_700_000_000_000,
  ref: 'Spring launch',
};

const ev = (e: unknown) => evaluateLogic(e, ctx);

describe('JSON Logic evaluator', () => {
  it('reads vars with paths, array indexes, defaults and computed paths', () => {
    expect(ev({ var: 'entry.contentTypeApiId' })).toBe('article');
    expect(ev({ var: 'vars.locales.0' })).toBe('de-DE');
    expect(ev({ var: ['vars.missing', 'fallback'] })).toBe('fallback');
    expect(ev({ var: 'vars.missing' })).toBeNull();
    expect(ev({ var: { cat: ['vars.locales.', { var: 'vars.i' }] } })).toBe('fr-FR');
  });

  it('compares (including the between forms)', () => {
    expect(ev({ '>': [{ var: 'vars.total' }, 1000] })).toBe(true);
    expect(ev({ '>=': [2, 2] })).toBe(true);
    expect(ev({ '<': [{ var: 'vars.cycle' }, 12] })).toBe(true);
    expect(ev({ '<': [1, 5, 3] })).toBe(false);
    expect(ev({ '<=': [1, 1, 3] })).toBe(true);
    expect(ev({ '==': [1, '1'] })).toBe(true);
    expect(ev({ '===': [1, '1'] })).toBe(false);
    expect(ev({ '!=': ['a', 'b'] })).toBe(true);
    expect(ev({ '!==': [1, 1] })).toBe(false);
  });

  it('does logic with JSON Logic truthiness', () => {
    expect(ev({ and: [true, 'x', 0] })).toBe(0);
    expect(ev({ or: [false, [], 'y'] })).toBe('y');
    expect(ev({ '!': [[]] })).toBe(true);
    expect(ev({ '!!': [{ var: 'entry.title' }] })).toBe(true);
    expect(ev({ '!!': [[]] })).toBe(false);
    expect(ev({ if: [false, 'a', true, 'b', 'c'] })).toBe('b');
    expect(ev({ if: [false, 'a', 'c'] })).toBe('c');
  });

  it('does arithmetic and strings', () => {
    expect(ev({ '+': [{ var: 'vars.cycle' }, 1] })).toBe(3);
    expect(ev({ '-': [5] })).toBe(-5);
    expect(ev({ '*': [2, 3, 4] })).toBe(24);
    expect(ev({ '/': [9, 3] })).toBe(3);
    expect(ev({ '%': [7, 3] })).toBe(1);
    expect(ev({ min: [3, 1, 2] })).toBe(1);
    expect(ev({ max: [3, 1, 2] })).toBe(3);
    expect(ev({ cat: ['a', 1, null] })).toBe('a1');
  });

  it('tests membership in arrays and strings', () => {
    expect(ev({ in: ['legal', { var: 'entry.tags' }] })).toBe(true);
    expect(ev({ in: ['sport', { var: 'entry.tags' }] })).toBe(false);
    expect(ev({ in: ['launch', { var: 'entry.title' }] })).toBe(true);
  });

  it('supports the custom len, now and days operations deterministically', () => {
    expect(ev({ len: [{ var: 'vars.locales' }] })).toBe(2);
    expect(ev({ len: ['abc'] })).toBe(3);
    expect(ev({ len: [5] })).toBe(0);
    expect(ev({ now: [] })).toBe(ctx.now);
    expect(ev({ days: [2] })).toBe(172_800_000);
    expect(ev({ '+': [{ now: [] }, { days: 1 }] })).toBe(ctx.now + 86_400_000);
  });

  it('lists missing paths', () => {
    expect(ev({ missing: ['entry.title', 'entry.slug'] })).toEqual(['entry.slug']);
  });

  it('passes non-logic values through', () => {
    expect(evaluateLogic(true, ctx)).toBe(true);
    expect(evaluateLogic(undefined, ctx)).toBeUndefined();
    expect(ev({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(ev(['x', { var: 'vars.cycle' }])).toEqual(['x', 2]);
  });

  it('throws on an unknown operator, and logicIssues finds it without running', () => {
    expect(() => ev({ nope: [1] })).toThrow('Unrecognized operation nope');
    expect(logicIssues({ and: [{ var: 'x' }, { nope: [1] }] })).toEqual([
      'Unknown operator “nope”',
    ]);
    expect(logicIssues({ '>': [{ var: 'x' }, 1] })).toEqual([]);
  });

  it('logicHolds is truthiness of the result', () => {
    expect(logicHolds({ in: ['legal', { var: 'entry.tags' }] }, ctx)).toBe(true);
    expect(logicHolds({ var: 'input.changedFields' }, ctx)).toBe(true);
    expect(logicHolds({ var: 'nodes.validate.issues' }, ctx)).toBe(false);
  });
});

describe('interpolate', () => {
  it('fills {{paths}}, leaves missing ones empty and JSON-encodes objects', () => {
    expect(interpolate('Review “{{ref}}” ({{ entry.id }})', ctx)).toBe(
      'Review “Spring launch” (e1)',
    );
    expect(interpolate('x{{vars.nope}}y', ctx)).toBe('xy');
    expect(interpolate('{{vars.locales}}', ctx)).toBe('["de-DE","fr-FR"]');
  });

  it('references an entry by title, else id', () => {
    expect(entryReference({ id: 'e1', title: 'T' })).toBe('T');
    expect(entryReference({ id: 'e1' })).toBe('e1');
  });
});
