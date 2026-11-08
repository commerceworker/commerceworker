import { describe, expect, it } from 'vitest';
import {
  LOCALE_COOKIE,
  normalizeLocale,
  resolveLocale,
  tryLocaleFromCookie,
} from './resolve-locale';

describe('normalizeLocale', () => {
  it('accepts supported base languages', () => {
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('ES')).toBe('es');
    expect(normalizeLocale('es-MX')).toBe('es');
  });

  it('rejects unknown tags', () => {
    expect(normalizeLocale('fr')).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
  });
});

describe('resolveLocale', () => {
  it('prefers cw_locale cookie', () => {
    const req = new Request('https://example.com/', {
      headers: { cookie: `${LOCALE_COOKIE}=es; other=1` },
    });
    expect(resolveLocale(req)).toBe('es');
  });

  it('falls back to Accept-Language', () => {
    const req = new Request('https://example.com/', {
      headers: { 'accept-language': 'es-ES,en;q=0.9' },
    });
    expect(resolveLocale(req)).toBe('es');
  });

  it('defaults to en', () => {
    expect(resolveLocale(new Request('https://example.com/'))).toBe('en');
  });
});

describe('tryLocaleFromCookie', () => {
  it('parses document-style cookie header', () => {
    expect(tryLocaleFromCookie(`${LOCALE_COOKIE}=es; Path=/`)).toBe('es');
    expect(tryLocaleFromCookie('')).toBeNull();
  });
});
