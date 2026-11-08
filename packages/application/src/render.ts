import {
  type EntryFields,
  type LocaleConfig,
  resolveFieldsForLocale,
} from '@commerceworker/domain';
import type { SpaceConfig } from '@commerceworker/ports';

const toLocaleConfig = (s: SpaceConfig): LocaleConfig => ({
  defaultLocale: s.defaultLocale,
  locales: s.locales,
  fallbacks: s.fallbacks,
});

/**
 * Renders entry fields for delivery. With no locale, the full per-locale maps
 * are returned. With a locale, each field is flattened to its resolved value
 * (following the space's fallback chain) — the lightweight shape channels want.
 */
export function renderFields(
  fields: EntryFields,
  space: SpaceConfig,
  locale?: string,
): EntryFields | Record<string, unknown> {
  if (!locale) return fields;
  return resolveFieldsForLocale(fields, toLocaleConfig(space), locale);
}
