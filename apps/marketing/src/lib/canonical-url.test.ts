import { describe, expect, it } from 'vitest';
import { joinCanonical } from './canonical-url';

describe('joinCanonical', () => {
  it('strips trailing slash from base and joins path', () => {
    expect(joinCanonical('https://example.com/', '/features')).toBe('https://example.com/features');
  });

  it('adds leading slash when missing', () => {
    expect(joinCanonical('https://example.com', 'features')).toBe('https://example.com/features');
  });
});
