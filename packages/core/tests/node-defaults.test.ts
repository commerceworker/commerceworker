import { describe, expect, it } from 'vitest';
import {
  durationField,
  durationMs,
  NODE_SPECS,
  nodeSpec,
  validateConfig,
  withDefaults,
} from '../src';

describe('node defaults', () => {
  it('gives waits their catalog timeout when the field is missing', () => {
    expect(withDefaults('control.approval', {}).timeout).toBe('2 days');
    expect(withDefaults('control.wait_event', { event: 'x' }).timeout).toBe('30 days');
    expect(withDefaults('control.wait', {}).duration).toBe('1 day');
  });

  it('runs a cleared duration field on its catalog default', () => {
    // The editor stores a cleared field as "", which validation accepts for an optional field.
    expect(validateConfig('control.approval', { timeout: '' })).toEqual([]);
    const at = (type: string, config: Record<string, unknown>, key: string) =>
      durationField(nodeSpec(type), withDefaults(type, config), key);
    expect(at('control.approval', { timeout: '' }, 'timeout')).toBe('2 days');
    expect(at('control.wait_event', { event: 'x', timeout: null }, 'timeout')).toBe('30 days');
    expect(at('control.wait', { duration: ' ' }, 'duration')).toBe('1 day');
    expect(at('control.approval', { timeout: '4 hours' }, 'timeout')).toBe('4 hours');
  });

  it('validates a calendar wait, which overrides the duration the catalog defaults', () => {
    expect(validateConfig('control.wait', { duration: '30 days' })).toEqual([]);
    expect(
      validateConfig('control.wait', { every: 'month', from: { var: 'order.createdAt' } }),
    ).toEqual([]);
    expect(validateConfig('control.wait', { every: 'month', count: 3 })).toEqual([]);
    expect(validateConfig('control.wait', { every: 'fortnight' })).toHaveLength(1);
    expect(validateConfig('control.wait', { every: 'week', count: 0 })).toEqual([
      'Periods: a whole number from 1 to 5200 weeks',
    ]);
    expect(validateConfig('control.wait', { every: 'week', count: 1.5 })).toHaveLength(1);
    // A hundred years of the unit is the most.
    expect(validateConfig('control.wait', { every: 'month', count: 1200 })).toEqual([]);
    expect(validateConfig('control.wait', { every: 'month', count: 5e6 })).toEqual([
      'Periods: a whole number from 1 to 1200 months',
    ]);
  });

  it("answers a cleared count with the wait's own message, not a schema error", () => {
    // The editor stores a cleared field as null (or "").
    for (const count of [null, '']) {
      expect(validateConfig('control.wait', { every: 'month', count })).toEqual([
        'Periods: a whole number from 1 to 1200 months',
      ]);
    }
    // Without `every` the count is unused.
    expect(validateConfig('control.wait', { count: null })).toEqual([]);
  });

  it('leaves a cleared field blank for the editor, which renders from withDefaults', () => {
    expect(withDefaults('control.approval', { timeout: '' }).timeout).toBe('');
  });

  it('refuses a duration with neither a value nor a default', () => {
    expect(() => durationField(nodeSpec('control.approval'), {}, 'nope')).toThrow(/no default/);
  });

  it('gives every built-in duration field a valid default, so runtimes need no fallback', () => {
    for (const spec of NODE_SPECS) {
      for (const f of spec.fields) {
        if (f.kind !== 'duration') continue;
        expect(typeof f.default, `${spec.type}.${f.key}`).toBe('string');
        expect(durationMs(f.default as string)).toBeGreaterThan(0);
      }
    }
  });
});
