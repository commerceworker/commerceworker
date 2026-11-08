import { describe, expect, it } from 'vitest';
import {
  assertLocaleSettings,
  deliveredLocaleConfig,
  fallbackChain,
  isLocaleDelivered,
  type LocaleConfig,
  localeDirection,
  resolvedLocaleSettings,
  resolveLocalizedValue,
  ValidationError,
  withoutUndeliveredLocales,
} from '../src/index';

const config: LocaleConfig = {
  defaultLocale: 'en',
  locales: ['en', 'fr', 'fr-CA', 'ar', 'he'],
  fallbacks: { 'fr-CA': 'fr', fr: 'en', ar: null },
  localeSettings: { fr: { delivered: false }, he: { direction: 'ltr' } },
};

describe('delivery locales', () => {
  it('delivers every locale but one turned off, and always the default', () => {
    expect(config.locales.filter((l) => isLocaleDelivered(config, l))).toEqual([
      'en',
      'fr-CA',
      'ar',
      'he',
    ]);
    expect(
      isLocaleDelivered({ ...config, localeSettings: { en: { delivered: false } } }, 'en'),
    ).toBe(true);
    // A locale the space doesn't have isn't "undelivered": it resolves as it always has.
    expect(isLocaleDelivered(config, 'de')).toBe(true);
  });

  it('re-points fallbacks past an undelivered locale, so no chain reaches its values', () => {
    const delivered = deliveredLocaleConfig(config);
    expect(delivered.locales).toEqual(['en', 'fr-CA', 'ar', 'he']);
    expect(fallbackChain(delivered, 'fr-CA')).toEqual(['fr-CA', 'en']);
    const value = { en: 'Hello', fr: 'Bonjour' };
    expect(resolveLocalizedValue(value, config, 'fr-CA')).toBe('Bonjour');
    expect(resolveLocalizedValue(value, delivered, 'fr-CA')).toBe('Hello');
    expect(withoutUndeliveredLocales(value, config)).toEqual({ en: 'Hello' });
    // Nothing turned off: the same config back.
    const all = { ...config, localeSettings: {} };
    expect(deliveredLocaleConfig(all)).toBe(all);
  });

  it('runs a locale right to left by its language unless set', () => {
    expect(localeDirection(config, 'ar')).toBe('rtl');
    expect(localeDirection(config, 'he')).toBe('ltr');
    expect(localeDirection(config, 'fr')).toBe('ltr');
    expect(localeDirection(config, 'pa-Arab')).toBe('rtl');
    expect(resolvedLocaleSettings(config)).toMatchObject({
      fr: { delivered: false, direction: 'ltr' },
      ar: { delivered: true, direction: 'rtl' },
    });
  });

  it('refuses settings for a locale the space lacks, an undelivered default, a bad value', () => {
    const issues = (settings: Record<string, unknown>) => {
      try {
        assertLocaleSettings(config, settings);
        return [];
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        return err.issues.map((i) => i.field);
      }
    };
    expect(
      issues({
        de: { delivered: false },
        en: { delivered: false },
        ar: { direction: 'up', colour: 'red' },
      }),
    ).toEqual([
      'localeSettings.de',
      'localeSettings.en.delivered',
      'localeSettings.ar.colour',
      'localeSettings.ar.direction',
    ]);
    expect(assertLocaleSettings(config, { fr: { delivered: true, direction: 'rtl' } })).toEqual({
      fr: { delivered: true, direction: 'rtl' },
    });
  });
});
