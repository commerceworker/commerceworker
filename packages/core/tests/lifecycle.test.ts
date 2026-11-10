import { describe, expect, it } from 'vitest';
import {
  COMPANY_LIFECYCLE,
  COMPANY_STATUSES,
  defineLifecycle,
  type Lifecycle,
  LifecycleError,
  MEMBER_LIFECYCLE,
  MEMBER_STATUSES,
} from '../src';

/**
 * Every lifecycle in core is held to the same two rules: each state can be reached from where it
 * starts, and a terminal state leads nowhere. A new lifecycle is added to this list.
 */
const LIFECYCLES: { name: string; lifecycle: Lifecycle<string>; start: string; final: string[] }[] =
  [
    {
      name: 'company',
      lifecycle: COMPANY_LIFECYCLE,
      start: 'pending',
      final: ['rejected', 'closed'],
    },
    { name: 'member', lifecycle: MEMBER_LIFECYCLE, start: 'invited', final: ['removed'] },
  ];

describe.each(LIFECYCLES)('the $name lifecycle', ({ lifecycle, start, final }) => {
  it('reaches every state from where it starts', () => {
    expect([...lifecycle.reachable(start)].sort()).toEqual([...lifecycle.states].sort());
  });

  it('leads nowhere from a terminal state, and only from those', () => {
    expect(lifecycle.states.filter((s) => lifecycle.terminal(s)).sort()).toEqual([...final].sort());
    for (const s of final) {
      expect(lifecycle.next(s)).toEqual([]);
      expect([...lifecycle.reachable(s)]).toEqual([s]);
      for (const to of lifecycle.states) expect(lifecycle.can(s, to)).toBe(false);
    }
  });

  it('only moves between states it names, and never to itself', () => {
    for (const from of lifecycle.states)
      for (const to of lifecycle.next(from)) {
        expect(lifecycle.states).toContain(to);
        expect(to).not.toBe(from);
      }
  });
});

describe('the statuses', () => {
  it('are the lifecycles’ states, in one place', () => {
    expect([...COMPANY_LIFECYCLE.states]).toEqual([...COMPANY_STATUSES]);
    expect([...MEMBER_LIFECYCLE.states]).toEqual([...MEMBER_STATUSES]);
  });

  it('move as the plan says', () => {
    const company = (a: string, b: string) => COMPANY_LIFECYCLE.can(a as never, b as never);
    expect(company('pending', 'active')).toBe(true);
    expect(company('pending', 'rejected')).toBe(true);
    expect(company('pending', 'suspended')).toBe(false);
    expect(company('active', 'suspended')).toBe(true);
    expect(company('suspended', 'active')).toBe(true);
    expect(company('active', 'closed')).toBe(true);
    expect(company('suspended', 'closed')).toBe(true);
    expect(company('active', 'pending')).toBe(false);
    const member = (a: string, b: string) => MEMBER_LIFECYCLE.can(a as never, b as never);
    expect(member('invited', 'active')).toBe(true);
    expect(member('invited', 'removed')).toBe(true);
    expect(member('invited', 'inactive')).toBe(false);
    expect(member('active', 'inactive')).toBe(true);
    expect(member('inactive', 'active')).toBe(true);
    expect(member('active', 'removed')).toBe(true);
    expect(member('inactive', 'removed')).toBe(true);
    expect(member('active', 'invited')).toBe(false);
  });
});

describe('defineLifecycle', () => {
  const toy = defineLifecycle<string>({ a: ['b'], b: ['a', 'c'], c: [], orphan: ['a'] });

  it('answers can, next and terminal', () => {
    expect(toy.can('a', 'b')).toBe(true);
    expect(toy.can('a', 'c')).toBe(false);
    expect(toy.can('a', 'a')).toBe(false);
    expect(toy.next('b')).toEqual(['a', 'c']);
    expect(toy.terminal('c')).toBe(true);
    expect(toy.terminal('a')).toBe(false);
  });

  it('asserts a move with an error that names it', () => {
    expect(() => toy.assert('a', 'b')).not.toThrow();
    expect(() => toy.assert('c', 'a')).toThrow(LifecycleError);
    expect(() => toy.assert('c', 'a')).toThrow("Can't go from c to a.");
  });

  it('finds what is reachable, loops and unreachable states included', () => {
    expect([...toy.reachable('a')].sort()).toEqual(['a', 'b', 'c']);
    // A state nothing leads to is reachable only from itself: the generic check catches it.
    expect(toy.reachable('a').has('orphan')).toBe(false);
  });
});
