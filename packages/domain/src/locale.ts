import { type FieldIssue, ValidationError } from './errors';
import type { EntryFields, LocaleCode, LocalizedValue } from './types';

/** Which way a locale's text runs: the admin sets it as `dir` on that locale's inputs. */
export type TextDirection = 'ltr' | 'rtl';
export const TEXT_DIRECTIONS: readonly TextDirection[] = ['ltr', 'rtl'];

/**
 * What a space says about one of its locales beyond its place in the fallback chain. Every key is
 * optional, and a locale with no settings is delivered, in the direction its language is written.
 */
export interface LocaleSettings {
  /**
   * False keeps the locale out of Delivery: editors still write and preview it, but no delivered
   * response, fallback or sitemap alternate carries it until it is turned on. The default locale
   * is always delivered.
   */
  readonly delivered?: boolean;
  /** Absent: from the language (`rtlByLanguage`). */
  readonly direction?: TextDirection;
}

/**
 * Locale configuration for a space: the default locale plus an optional
 * fallback chain. When a value is missing in a requested locale, resolution
 * walks the fallback chain (and finally the default locale).
 */
export interface LocaleConfig {
  readonly defaultLocale: LocaleCode;
  readonly locales: readonly LocaleCode[];
  /** locale -> the locale to fall back to (null = no further fallback). */
  readonly fallbacks?: Readonly<Record<LocaleCode, LocaleCode | null>>;
  /** Per-locale settings (delivered, direction); a locale absent here takes the defaults. */
  readonly localeSettings?: Readonly<Record<LocaleCode, LocaleSettings>>;
}

/** Languages written right to left (ISO 639 codes), for a locale whose direction isn't set. */
const RTL_LANGUAGES = new Set([
  'ar',
  'arc',
  'ckb',
  'dv',
  'fa',
  'he',
  'iw',
  'ks',
  'nqo',
  'ps',
  'sd',
  'syr',
  'ug',
  'ur',
  'yi',
]);
/** Scripts written right to left (ISO 15924), when a tag names one: `ku-Arab`, `pa-Arab`. */
const RTL_SCRIPTS = new Set(['arab', 'hebr', 'thaa', 'syrc', 'nkoo', 'adlm', 'rohg']);

/** The direction a BCP-47 tag's language (or script, when it names one) is written in. */
export function rtlByLanguage(locale: LocaleCode): boolean {
  const [language = '', ...rest] = locale.toLowerCase().split(/[-_]/);
  const script = rest.find((part) => part.length === 4);
  return script ? RTL_SCRIPTS.has(script) : RTL_LANGUAGES.has(language);
}

/** Whether Delivery serves `locale`: the default always; any other unless turned off. */
export function isLocaleDelivered(config: LocaleConfig, locale: LocaleCode): boolean {
  return locale === config.defaultLocale || config.localeSettings?.[locale]?.delivered !== false;
}

/** Which way `locale`'s text runs: as set, else as its language is written. */
export function localeDirection(config: LocaleConfig, locale: LocaleCode): TextDirection {
  return config.localeSettings?.[locale]?.direction ?? (rtlByLanguage(locale) ? 'rtl' : 'ltr');
}

/** Every locale of the space with its settings resolved (delivered, direction), in order. */
export function resolvedLocaleSettings(
  config: LocaleConfig,
): Record<LocaleCode, Required<LocaleSettings>> {
  return Object.fromEntries(
    config.locales.map((l) => [
      l,
      { delivered: isLocaleDelivered(config, l), direction: localeDirection(config, l) },
    ]),
  );
}

/**
 * The space as Delivery sees it: only its delivered locales, and each fallback re-pointed past the
 * ones that aren't (`fr-CA → fr → en` with `fr` undelivered is `fr-CA → en`), so no chain reaches
 * an undelivered locale's values. The settings ride along, so a request naming an undelivered
 * locale can still be told apart from an unknown one.
 */
export function deliveredLocaleConfig<T extends LocaleConfig>(config: T): T {
  const undelivered = config.locales.filter((l) => !isLocaleDelivered(config, l));
  if (undelivered.length === 0) return config;
  const skip = new Set(undelivered);
  const next = (from: LocaleCode | null | undefined): LocaleCode | null => {
    const seen = new Set<LocaleCode>();
    let at = from ?? null;
    while (at && skip.has(at) && !seen.has(at)) {
      seen.add(at);
      at = config.fallbacks?.[at] ?? null;
    }
    return at && !skip.has(at) ? at : null;
  };
  const fallbacks = config.fallbacks
    ? Object.fromEntries(
        Object.entries(config.fallbacks)
          .filter(([from]) => !skip.has(from))
          .map(([from, to]) => [from, next(to)]),
      )
    : undefined;
  return {
    ...config,
    locales: config.locales.filter((l) => !skip.has(l)),
    ...(fallbacks ? { fallbacks } : {}),
  };
}

/** A per-locale value without the locales Delivery doesn't serve. */
export function withoutUndeliveredLocales<V>(
  value: Readonly<Record<LocaleCode, V>>,
  config: LocaleConfig,
): Record<LocaleCode, V> {
  if (!config.localeSettings) return { ...value };
  return Object.fromEntries(
    Object.entries(value).filter(([locale]) => isLocaleDelivered(config, locale)),
  );
}

/**
 * Checks per-locale settings against the space's locales: each names one of them, says
 * `delivered` as a boolean and `direction` as `ltr` or `rtl`, and the default locale stays
 * delivered (every fallback chain ends there). Throws `ValidationError` naming each problem.
 */
export function assertLocaleSettings(
  config: Pick<LocaleConfig, 'defaultLocale' | 'locales'>,
  settings: Readonly<Record<string, unknown>>,
): Record<LocaleCode, LocaleSettings> {
  const issues: FieldIssue[] = [];
  const out: Record<LocaleCode, LocaleSettings> = {};
  for (const [locale, raw] of Object.entries(settings)) {
    const field = `localeSettings.${locale}`;
    if (!config.locales.includes(locale)) {
      issues.push({ field, message: `"${locale}" is not one of this space's locales` });
      continue;
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      issues.push({ field, message: 'Settings are an object: { delivered?, direction? }' });
      continue;
    }
    const { delivered, direction, ...rest } = raw as Record<string, unknown>;
    for (const key of Object.keys(rest)) {
      issues.push({ field: `${field}.${key}`, message: 'Not a locale setting' });
    }
    if (delivered !== undefined && typeof delivered !== 'boolean') {
      issues.push({ field: `${field}.delivered`, message: 'true or false' });
    } else if (delivered === false && locale === config.defaultLocale) {
      issues.push({
        field: `${field}.delivered`,
        message: 'The default locale is always delivered: every fallback ends there',
      });
    }
    if (direction !== undefined && !TEXT_DIRECTIONS.includes(direction as TextDirection)) {
      issues.push({ field: `${field}.direction`, message: 'ltr or rtl' });
    }
    out[locale] = {
      ...(typeof delivered === 'boolean' ? { delivered } : {}),
      ...(direction !== undefined ? { direction: direction as TextDirection } : {}),
    };
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return out;
}

/** Builds the ordered fallback chain for a requested locale (most specific first). */
export function fallbackChain(config: LocaleConfig, requested: LocaleCode): LocaleCode[] {
  const chain: LocaleCode[] = [];
  const seen = new Set<LocaleCode>();
  let current: LocaleCode | null = requested;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = config.fallbacks?.[current] ?? null;
  }
  if (!seen.has(config.defaultLocale)) chain.push(config.defaultLocale);
  return chain;
}

/** Resolves a single localized value following the fallback chain. */
export function resolveLocalizedValue(
  value: LocalizedValue,
  config: LocaleConfig,
  requested: LocaleCode,
): unknown {
  for (const locale of fallbackChain(config, requested)) {
    if (value[locale] !== undefined && value[locale] !== null) return value[locale];
  }
  return undefined;
}

/**
 * Flattens an entry's fields to a single requested locale, applying fallback.
 * Fields with no resolvable value are omitted. Used by Delivery/Preview when a
 * caller requests `?locale=`.
 */
export function resolveFieldsForLocale(
  fields: EntryFields,
  config: LocaleConfig,
  requested: LocaleCode,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [apiId, localized] of Object.entries(fields)) {
    const resolved = resolveLocalizedValue(localized, config, requested);
    if (resolved !== undefined) out[apiId] = resolved;
  }
  return out;
}
