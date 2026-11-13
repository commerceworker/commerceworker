import { describe, expect, it } from 'vitest';
import { isEmail } from '../src';

describe('isEmail', () => {
  it('accepts one @ with a dotted domain and refuses the rest', () => {
    for (const ok of ['a@b.c', 'a.b+c@d.e.f', 'a@.b.c']) expect(isEmail(ok), ok).toBe(true);
    for (const bad of ['', 'a@b', 'a@@b.c', '@b.c', 'a@b.', 'a@.b', 'a b@c.d', 'a@b .c']) {
      expect(isEmail(bad), bad).toBe(false);
    }
  });

  it('runs in linear time on a hostile string', () => {
    const start = performance.now();
    expect(isEmail(`!@${'!.'.repeat(50_000)}`)).toBe(true);
    expect(isEmail(`!@${'!'.repeat(100_000)}`)).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
