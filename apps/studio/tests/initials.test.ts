import { describe, expect, it } from 'vitest';
import { initials } from '~/lib/initials';

describe('initials', () => {
  it('takes the first and last of a name', () => {
    expect(initials('Ada Byron Lovelace', 'a@example.com')).toBe('AL');
  });
  it('takes one letter from a single name', () => {
    expect(initials('ada', 'a@example.com')).toBe('A');
  });
  it('falls back to the email when there is no name', () => {
    expect(initials(null, 'sam@example.com')).toBe('S');
    expect(initials('  ', 'sam@example.com')).toBe('S');
  });
  it('keeps a letter outside the basic plane whole', () => {
    expect(initials('𝒜da', 'a@example.com')).toBe('𝒜');
  });
});
