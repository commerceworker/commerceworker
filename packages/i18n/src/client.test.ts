// @vitest-environment jsdom
import type i18n from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { initClientI18n } from './client';

/**
 * `client.ts` is the browser bootstrap every React app initialises through, and the piece that
 * keeps `<html lang>` in step with the active locale (WCAG 2.2 A, 3.1.1 Language of Page). It runs
 * against a DOM, so these need a DOM (jsdom) rather than the package's default node environment.
 *
 * i18next is a module singleton: the whole file shares one initialised instance, which is why the
 * setup runs once in `beforeAll` and the re-entry case is asserted last.
 */
describe('initClientI18n', () => {
  let instance: typeof i18n;

  beforeAll(async () => {
    instance = await initClientI18n({
      resources: {
        en: { marketing: { greeting: 'Hello' } },
        es: { marketing: { greeting: 'Hola' } },
      },
      defaultNS: 'marketing',
      lng: 'en',
      // The detector reads cookie/localStorage/navigator, none of which this suite controls.
      enableDetector: false,
    });
  });

  it('initialises the shared instance with the requested language', () => {
    expect(instance.isInitialized).toBe(true);
    expect(instance.language).toBe('en');
    expect(instance.t('greeting')).toBe('Hello');
  });

  it('merges caller resources on top of the bundled namespaces', () => {
    // Caller-supplied namespace and a bundled one both resolve — the merge keeps both, rather
    // than the caller's `resources` replacing `baseResources` wholesale.
    expect(instance.getResourceBundle('en', 'marketing')).toMatchObject({ greeting: 'Hello' });
    expect(instance.getResourceBundle('en', 'storefront')).toHaveProperty('footerTagline');
  });

  it('stamps <html lang> with the initial locale', () => {
    expect(document.documentElement.lang).toBe('en');
  });

  it('follows a language change so the document never asserts the wrong language', async () => {
    await instance.changeLanguage('es');

    expect(document.documentElement.lang).toBe('es');
    expect(instance.t('greeting')).toBe('Hola');
  });

  it('reduces a regional tag to its base language for <html lang>', async () => {
    await instance.changeLanguage('es-MX');

    expect(document.documentElement.lang).toBe('es');
  });

  it('returns the existing instance instead of re-initialising', async () => {
    const again = await initClientI18n({ lng: 'en' });

    expect(again).toBe(instance);
  });
});
