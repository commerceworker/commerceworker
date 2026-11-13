import { describe, expect, it } from 'vitest';
import { evaluateGuardrails } from './index';

// The pattern the system-override check replaced: quadratic on a long run of line breaks, so it
// only runs here, on short inputs, as the oracle.
const OLD = /\n\s*system\s*:/i;
const policy = {
  checks: [{ type: 'prompt-injection' as const, target: 'input' as const }],
  defaultAction: 'block' as const,
};
const flagged = (text: string) =>
  evaluateGuardrails(policy, { inputText: text }).violations.some((v) =>
    v.includes('System prompt override'),
  );

describe('system prompt override', () => {
  it('agrees with the pattern on random short text', () => {
    const parts = ['\n', ' ', '\t', 'system', 'SYSTEM', ':', 'a', 'systems', ' '];
    let seed = 7;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let i = 0; i < 20000; i++) {
      let s = '';
      for (let j = next() % 8; j > 0; j--) s += parts[next() % parts.length];
      expect(flagged(s), JSON.stringify(s)).toBe(OLD.test(s));
    }
  });

  it('finishes hostile 512 KiB inputs in well under a second', () => {
    for (const text of [
      '\n'.repeat(512 * 1024),
      `${'system'.repeat(80_000)}`,
      `\n${' '.repeat(512 * 1024)}system`,
    ]) {
      const t0 = performance.now();
      flagged(text);
      expect(performance.now() - t0).toBeLessThan(500);
    }
  });
});
