import type { EntryFields, LocaleCode, LocalizedValue } from '../types';
import type { ContentType } from './content-type';
import {
  BLOCK_KEY,
  blockVariants,
  type FieldDefinition,
  nestedFieldsFor,
  UNIQUE_FIELD_TYPES,
} from './field';
import { normalizeSlug } from './slug';

/**
 * Field-value transformations that sit between "what the caller sent" and
 * "what gets stored": defaults, slug normalization, and the unique claims an
 * entry stakes on write. Pure — the use-cases own persistence and the clock.
 */

/**
 * Applies `defaultValue` to fields the caller left out.
 *
 * Only on create. An update that omits a field is expressing "leave it alone",
 * and one that clears it is expressing "make it empty" — re-applying a default
 * in either case would override an editor's intent.
 *
 * A bare default fills every locale of a localized field; a `{ locale: value }`
 * map sets them individually, which is how a field gets different defaults per
 * market.
 */
export function applyDefaults(
  contentType: ContentType,
  fields: EntryFields,
  locales: readonly LocaleCode[],
  defaultLocale: LocaleCode,
): EntryFields {
  const out: EntryFields = { ...fields };
  for (const field of contentType.fields) {
    if (field.defaultValue !== undefined) {
      const existing = out[field.apiId];
      if (!existing || Object.keys(existing).length === 0) {
        const target = field.localized ? locales : [defaultLocale];
        out[field.apiId] = isLocaleMap(field.defaultValue, locales)
          ? { ...(field.defaultValue as LocalizedValue) }
          : Object.fromEntries(target.map((locale) => [locale, field.defaultValue]));
      }
    }

    // Defaults inside a component fill gaps in the objects that are there —
    // including every item of a repeater, which is where a default earns its
    // keep ("each new card starts as the primary variant"). A component the
    // author never supplied stays absent: materializing one from its nested
    // defaults would invent content nobody asked for.
    const localized = holdsComponents(field) ? out[field.apiId] : undefined;
    if (localized) {
      out[field.apiId] = Object.fromEntries(
        Object.entries(localized).map(([locale, value]) => [
          locale,
          withNestedDefaults(field, value),
        ]),
      );
    }
  }
  return out;
}

/** True when a field's values are components (one, or an array of them). */
function holdsComponents(field: FieldDefinition): boolean {
  return (
    field.type === 'Component' || (field.type === 'Array' && field.items?.type === 'Component')
  );
}

/**
 * Fills nested defaults in one value of a component-holding field: the
 * component itself, or each element of an array of them. A blocks element gets
 * its own variant's defaults; one naming no known variant is left alone for
 * validation to report.
 */
function withNestedDefaults(field: FieldDefinition, value: unknown): unknown {
  if (field.type === 'Component') return withComponentDefaults(field.fields ?? [], value);
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    const nested = nestedFieldsFor(field, item);
    return nested ? withComponentDefaults(nested, item) : item;
  });
}

/** Fills absent nested keys from their definitions' defaults, recursively. */
function withComponentDefaults(nested: readonly FieldDefinition[], value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const out = { ...(value as Record<string, unknown>) };
  for (const f of nested) {
    if (out[f.apiId] === undefined && f.defaultValue !== undefined) {
      out[f.apiId] = f.defaultValue;
    }
    if (!holdsComponents(f) || out[f.apiId] === undefined) continue;
    out[f.apiId] = withNestedDefaults(f, out[f.apiId]);
  }
  return out;
}

/**
 * Gives every blocks element that lacks one a `_key`, however deep the blocks
 * field sits; keys already present are kept, so a block keeps its identity
 * across edits and reorders. Ids come from the caller (`ctx.ids.newId`), so the
 * use-case stays deterministic under test. Values are copied, never mutated.
 *
 * Runs before validation on every entry write; a duplicate key the caller sent
 * is left for validation to refuse rather than silently re-keyed, since the
 * caller may be addressing one of the two by it.
 */
export function assignBlockKeys(
  contentType: ContentType,
  fields: EntryFields,
  newId: () => string,
): EntryFields {
  if (!contentType.fields.some(mayHoldBlocks)) return fields;
  const out: EntryFields = { ...fields };
  for (const field of contentType.fields) {
    const localized = out[field.apiId];
    if (!localized || !mayHoldBlocks(field)) continue;
    out[field.apiId] = Object.fromEntries(
      Object.entries(localized).map(([locale, value]) => [locale, keyed(field, value, newId)]),
    );
  }
  return out;
}

/** True when a blocks field sits at or anywhere under `field`. */
export function mayHoldBlocks(field: FieldDefinition): boolean {
  if (blockVariants(field)) return true;
  if (field.type === 'Component') return (field.fields ?? []).some(mayHoldBlocks);
  if (field.type === 'Array' && field.items?.type === 'Component') {
    return (field.items.fields ?? []).some(mayHoldBlocks);
  }
  return false;
}

function keyed(field: FieldDefinition, value: unknown, newId: () => string): unknown {
  if (field.type === 'Component') return keyedComponent(field.fields ?? [], value, newId);
  if (!Array.isArray(value)) return value;
  const variants = blockVariants(field);
  return value.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
    const nested = nestedFieldsFor(field, item);
    const filled = nested ? keyedComponent(nested, item, newId) : item;
    if (!variants) return filled;
    const key = (item as Record<string, unknown>)[BLOCK_KEY];
    return typeof key === 'string' && key !== ''
      ? filled
      : { ...(filled as Record<string, unknown>), [BLOCK_KEY]: newId() };
  });
}

function keyedComponent(
  nested: readonly FieldDefinition[],
  value: unknown,
  newId: () => string,
): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const out = { ...(value as Record<string, unknown>) };
  for (const f of nested) {
    if (out[f.apiId] !== undefined && mayHoldBlocks(f))
      out[f.apiId] = keyed(f, out[f.apiId], newId);
  }
  return out;
}

/**
 * True when a default looks like a per-locale map rather than a plain value.
 *
 * Checked against the space's locales, not merely "is an object": a JSON field
 * whose default is `{ theme: 'dark' }` must not be mistaken for a locale map
 * and silently torn apart.
 */
function isLocaleMap(value: unknown, locales: readonly LocaleCode[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length > 0 && keys.every((k) => locales.includes(k));
}

/**
 * Normalizes every Slug field in place, so a caller can send a title and get a
 * usable slug. Idempotent, so it is safe on every write.
 */
export function normalizeSlugFields(contentType: ContentType, fields: EntryFields): EntryFields {
  const out: EntryFields = { ...fields };
  for (const field of contentType.fields) {
    if (field.type !== 'Slug') continue;
    const values = out[field.apiId];
    if (!values) continue;
    out[field.apiId] = Object.fromEntries(
      Object.entries(values).map(([locale, value]) => [
        locale,
        typeof value === 'string' ? normalizeSlug(value) : value,
      ]),
    );
  }
  return out;
}

/**
 * One value an entry claims exclusively, compared per locale.
 *
 * Scoped by content type as well as field: two types may each define a `slug`,
 * and a post named "about" must not stop a page being named "about".
 */
export interface UniqueClaim {
  readonly contentTypeApiId: string;
  readonly fieldApiId: string;
  readonly locale: LocaleCode;
  /** Stringified for comparison — uniqueness is per rendered value. */
  readonly value: string;
}

/**
 * The claims an entry stakes given its fields.
 *
 * Empty and null values are skipped: "no value" is not a value, and treating
 * it as one would let a single entry with an empty slug block every other
 * entry from having one. An entry of a singleton type also stakes
 * {@link singletonClaim}.
 */
export function uniqueClaims(contentType: ContentType, fields: EntryFields): UniqueClaim[] {
  const claims: UniqueClaim[] = contentType.singleton ? [singletonClaim(contentType.apiId)] : [];
  for (const field of contentType.fields) {
    if (!field.unique || !UNIQUE_FIELD_TYPES.includes(field.type)) continue;
    const values = fields[field.apiId];
    if (!values) continue;
    for (const [locale, value] of Object.entries(values)) {
      if (value === null || value === undefined || value === '') continue;
      claims.push({
        contentTypeApiId: contentType.apiId,
        fieldApiId: field.apiId,
        locale,
        value: String(value),
      });
    }
  }
  return claims;
}

/**
 * The field name a singleton's one entry claims under. A field apiId starts with a letter, so no
 * field can ever claim it.
 */
export const SINGLETON_CLAIM_FIELD = '$singleton';

/**
 * The claim every entry of a singleton type stakes: the same value for all of them, so the
 * database's unique index on claims admits one entry at a time (outside the trash, which releases
 * claims), whatever the race.
 */
export function singletonClaim(contentTypeApiId: string): UniqueClaim {
  return { contentTypeApiId, fieldApiId: SINGLETON_CLAIM_FIELD, locale: '', value: '' };
}

/** True when the content type declares any unique field at all. */
export function hasUniqueFields(contentType: ContentType): boolean {
  return contentType.fields.some((f) => f.unique && UNIQUE_FIELD_TYPES.includes(f.type));
}
