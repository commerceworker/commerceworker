/**
 * Aldermoor: the fictional global professional-services firm the enterprise starter is written
 * for. Every name, person, office, client and figure here is invented; the `aldermoor.example`
 * domain is reserved (RFC 2606) so no link, email or webhook can ever reach a real host.
 *
 * The model follows how a large multi-market firm runs its site: one global English master,
 * markets that roll pages out and override fields, a few locale-only pages (an imprint, a state
 * privacy notice), a strategy sub-brand with its own disclaimer, and editorial, legal, brand,
 * newsroom, localization and careers teams with their own approvals.
 */

export const BRAND = {
  name: 'Aldermoor',
  legalName: 'Aldermoor Global Limited',
  subBrand: 'Aldermoor Vantage',
  tagline: 'Clarity for what comes next',
  domain: 'aldermoor.example',
  site: 'https://www.aldermoor.example',
  hooks: 'https://hooks.aldermoor.example',
  apps: 'https://apps.aldermoor.example',
  careersAts: 'https://careers.aldermoor.example',
} as const;

/** A display phone number as E.164 (`+44 20 7946 0100` → `+442079460100`), as the phone preset wants. */
export const e164 = (display: string) => display.replace(/[^+0-9]/g, '');

export const BRAND_EMAIL = (local: string) => `${local}@${BRAND.domain}`;

/** The space's own locale, every market the brand writes for, and where each falls back. */
export const DEFAULT_LOCALE = 'en-US';

/**
 * Markets. Full translations fall back to the global English; regional variants fall back to
 * their language (fr-CA reads fr-FR before English). Japan and the Gulf fall back to nothing: a
 * page not rolled out there is missing, not silently English, as the market sites behave. Italian
 * is being prepared: editors write and preview it, Delivery never serves it.
 */
export const ENTERPRISE_LOCALES = [
  'en-US',
  'en-GB',
  'de-DE',
  'de-CH',
  'fr-FR',
  'fr-CA',
  'es-ES',
  'es-MX',
  'pt-BR',
  'ja-JP',
  'zh-CN',
  'ar-AE',
  'it-IT',
] as const;
export type BrandLocale = (typeof ENTERPRISE_LOCALES)[number];

export const ENTERPRISE_FALLBACKS: Readonly<Record<string, string | null>> = {
  'en-GB': 'en-US',
  'de-DE': 'en-US',
  'de-CH': 'de-DE',
  'fr-FR': 'en-US',
  'fr-CA': 'fr-FR',
  'es-ES': 'en-US',
  'es-MX': 'es-ES',
  'pt-BR': 'en-US',
  'zh-CN': 'en-US',
  'ja-JP': null,
  'ar-AE': null,
  'it-IT': 'en-US',
};

export const UNDELIVERED_LOCALES = ['it-IT'] as const;
export const RTL_LOCALES = ['ar-AE'] as const;

/** Translations of one value, keyed by locale; `en` is the global master. */
export type Tr = { readonly en: string } & Partial<Record<Exclude<BrandLocale, 'en-US'>, string>>;

/**
 * A localized field value for the space: the master under the space's default locale (its own
 * translation when the default isn't English), and every other translation the space has a locale
 * for. Locales the space doesn't carry are dropped, so the starter installs into any locale set.
 */
export function loc(
  tr: Tr | string,
  space: { defaultLocale: string; locales: readonly string[] },
): Record<string, string> {
  const t: Tr = typeof tr === 'string' ? { en: tr } : tr;
  const byLocale = t as unknown as Record<string, string | undefined>;
  const out: Record<string, string> = {
    [space.defaultLocale]: byLocale[space.defaultLocale] ?? t.en,
  };
  for (const [key, value] of Object.entries(t)) {
    const locale = key === 'en' ? 'en-US' : key;
    if (value === undefined || locale === space.defaultLocale) continue;
    if (space.locales.includes(locale)) out[locale] = value;
  }
  return out;
}

/**
 * A localized value built per locale from a translated string: a hero, an SEO block or a quote
 * whose text is translated but whose shape is the same in every market.
 */
export function locBuild<T>(
  tr: Tr | string,
  space: { defaultLocale: string; locales: readonly string[] },
  build: (value: string, locale: string) => T,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(loc(tr, space)).map(([locale, value]) => [locale, build(value, locale)]),
  );
}

/** The value under the default locale only: how a non-localized field is written. */
export function one<T>(value: T, space: { defaultLocale: string }): Record<string, T> {
  return { [space.defaultLocale]: value };
}
