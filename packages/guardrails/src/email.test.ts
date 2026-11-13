import { describe, expect, it } from 'vitest';
import { containsEmail } from './email';

// The pattern containsEmail replaced. It backtracks polynomially on hostile text, so it only
// runs here, on short inputs, as the oracle the scanner has to agree with.
const OLD = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i;

const TABLE: [string, boolean][] = [
  ['', false],
  ['jane@example.com', true],
  ['mail jane@example.com now', true],
  ['a.b+c@mail.example.co.', true],
  ['_a@b.cc', true],
  ['-a@b.cc', true],
  ['a@b.c', false],
  ['a@b', false],
  ['@b.cc', false],
  ['a@@b.cc', false],
  ['a@b.cc1', false],
  ['a@b.cc_', false],
  ['a@b.cc-', true],
  ['a@b.c1.ee', true],
  ['a@.cc', false],
  ['a@b..cc', true],
  ['x@y.zz@', true],
  ['José@example.com', false],
  ['a@é.cc', false],
];

describe('containsEmail', () => {
  it.each(TABLE)('%j', (input, expected) => {
    expect(OLD.test(input)).toBe(expected);
    expect(containsEmail(input)).toBe(expected);
  });

  it('agrees with the pattern on random short text', () => {
    const alphabet = ['a', 'Z', '1', '_', '.', '-', '%', '+', '@', ' ', 'é', 'c', 'o'];
    let seed = 20261113;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let i = 0; i < 30000; i++) {
      const len = next() % 20;
      let s = '';
      for (let j = 0; j < len; j++) s += alphabet[next() % alphabet.length];
      expect(containsEmail(s), JSON.stringify(s)).toBe(OLD.test(s));
    }
  });

  it('finishes hostile 100k inputs in well under a second', () => {
    const n = 100_000;
    for (const text of [
      'a'.repeat(n),
      'a.'.repeat(n / 2),
      `${'a%'.repeat(n / 2)}@${'b'.repeat(n / 2)}`,
      `${'a.'.repeat(n / 4)}@${'b.'.repeat(n / 4)}`,
      'a@'.repeat(n / 2),
      `a@${'b.c'.repeat(n / 3)}`,
      `a@${'b-'.repeat(n / 2)}`,
    ]) {
      const t0 = performance.now();
      containsEmail(text);
      expect(performance.now() - t0).toBeLessThan(500);
    }
  });
});
