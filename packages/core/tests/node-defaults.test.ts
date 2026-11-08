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
