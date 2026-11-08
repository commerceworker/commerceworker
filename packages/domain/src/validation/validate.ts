import type { ContentType } from '../content-type/content-type';
import { dateSortKey, dateValueProblem } from '../content-type/dates';
import {
  BLOCK_KEY,
  BLOCK_TYPE_KEY,
  type ComponentVariant,
  type DateFormat,
  type FieldDefinition,
  type FieldValidations,
  optionValue,
  ruleMessage,
  unsafeRegexReason,
} from '../content-type/field';
import { fieldState, sameFieldValue, valuesForRules } from '../content-type/field-rules';
import { isSlug } from '../content-type/slug';
import { type FieldIssue, ValidationError } from '../errors';
import { validateRichText } from '../rich-text/rich-text';
import { canonicalUrlIssue, SEO_FIELDS } from '../seo/seo';
import type { EntryFields, LocaleCode } from '../types';

export interface ValidationContext {
  readonly defaultLocale: LocaleCode;
  /** Locale codes permitted in the space. */
  readonly locales: readonly LocaleCode[];
  /**
   * The values this write replaces: the entry's current version on an update, the type's defaults
   * on a create. Given, a field its rules disable must keep its value here. Left out by a reader
   * that judges stored content rather than an edit (a snapshot, an import, a merge), which has no
   * change to refuse.
   */
  readonly previous?: EntryFields;
}

/** The stored value a disabled field must keep, when the write is an edit; undefined when not. */
type Kept = { readonly value: unknown } | undefined;

const DISABLED_MESSAGE = 'Field is read-only while its rules disable it; it keeps its stored value';

/** Max serialized size of a single JSON field value (per locale). */
const MAX_JSON_FIELD_BYTES = 256 * 1024;

/**
 * The longest value a `regexp` rule is run against. Patterns are screened when a type is saved
 * (`unsafeRegexReason`), but a backtracking engine can still go quadratic on a crafted value; past
 * this length the value fails validation instead of being matched.
 */
export const MAX_REGEXP_INPUT = 10_000;

/**
 * Validates a full set of entry field values against a content type. Returns
 * the issues found (empty when valid). This is the single source of truth used
 * by both human API writes and AI-generated content, so an agent can never
 * produce an entry a human couldn't.
 */
export function validateEntryFields(
  contentType: ContentType,
  fields: EntryFields,
  ctx: ValidationContext,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const definedByApiId = new Map(contentType.fields.map((f) => [f.apiId, f]));

  // Reject values for fields not in the schema.
  for (const apiId of Object.keys(fields)) {
    if (!definedByApiId.has(apiId)) {
      issues.push({ field: apiId, message: `Unknown field "${apiId}"` });
    }
  }

  // What the rules read in each locale, built once per locale and only when some field has rules.
  const ruled = contentType.fields.some((f) => f.rules !== undefined);
  const ruleValues = new Map<LocaleCode, Record<string, unknown>>();
  const stateIn = (field: FieldDefinition, locale: LocaleCode) => {
    if (!ruled) return { hidden: false, disabled: false };
    let at = ruleValues.get(locale);
    if (!at) {
      at = valuesForRules(contentType.fields, fields, locale, ctx.defaultLocale);
      ruleValues.set(locale, at);
    }
    return fieldState(field, at);
  };

  for (const field of contentType.fields) {
    const localized = fields[field.apiId] ?? {};
    const targetLocales = field.localized ? ctx.locales : [ctx.defaultLocale];

    for (const locale of targetLocales) {
      const value = localized[locale];
      const state = stateIn(field, locale);
      const kept: Kept = ctx.previous ? { value: ctx.previous[field.apiId]?.[locale] } : undefined;
      if (state.disabled && kept && !sameFieldValue(value, kept.value)) {
        issues.push({ field: field.apiId, locale, message: DISABLED_MESSAGE });
        continue;
      }
      if (value === undefined || value === null) {
        // Required is enforced on the default locale only; other locales are
        // optional and resolve via the fallback chain at delivery time. A field
        // its rules hide is not required: nobody can see it to fill it.
        if (field.required && locale === ctx.defaultLocale && !state.hidden) {
          issues.push({ field: field.apiId, locale, message: 'Field is required' });
        }
        continue;
      }
      validateValue(field, value, locale, issues, field.apiId, kept);
    }

    // A non-localized field must not carry values under non-default locales.
    if (!field.localized) {
      for (const locale of Object.keys(localized)) {
        if (locale !== ctx.defaultLocale) {
          issues.push({
            field: field.apiId,
            locale,
            message: 'Field is not localized; only the default locale is allowed',
          });
        }
      }
    }
  }

  return issues;
}

/** Convenience wrapper that throws a ValidationError when issues exist. */
export function assertEntryFieldsValid(
  contentType: ContentType,
  fields: EntryFields,
  ctx: ValidationContext,
): void {
  const issues = validateEntryFields(contentType, fields, ctx);
  if (issues.length > 0) throw new ValidationError(issues);
}

/**
 * Validates one value against one field definition.
 *
 * `path` is what an issue is reported against. For a top-level field that is
 * just its apiId, but inside a component it becomes `hero.cta.label` or
 * `cards[2].title` — an editor looking at a list of eight cards needs to be
 * told which one is wrong, not that something somewhere is.
 */
function validateValue(
  field: FieldDefinition,
  value: unknown,
  locale: LocaleCode,
  issues: FieldIssue[],
  path: string,
  kept?: Kept,
): void {
  const push = (message: string): void => {
    issues.push({ field: path, locale, message });
  };
  const v = field.validations;

  switch (field.type) {
    case 'Slug': {
      if (typeof value !== 'string') {
        push('Expected a string');
        return;
      }
      checkSize(value.length, v, push, 'length');
      // Slugs are normalized on write, so anything reaching here that is not
      // already a slug means normalization was bypassed — report it rather
      // than silently storing a value that will break a URL.
      if (!isSlug(value)) {
        push('Must be lowercase letters, digits and single hyphens');
      }
      break;
    }
    case 'Symbol':
    case 'Text': {
      if (typeof value !== 'string') {
        push('Expected a string');
        return;
      }
      checkSize(value.length, v, push, 'length');
      checkIn(value, v, push);
      if (v?.regexp) {
        // Defence in depth: patterns are screened at content-type authoring time
        // (unsafeRegexReason), but a bad/unsafe pattern here must surface as a
        // validation issue, never an uncaught 500.
        const reason = unsafeRegexReason(v.regexp.pattern, v.regexp.flags);
        if (reason) {
          push(`Invalid pattern: ${reason}`);
        } else if (value.length > MAX_REGEXP_INPUT) {
          // Bounds the cost of any pattern the screen let through, a stored one included.
          push(`Too long to check against its pattern (at most ${MAX_REGEXP_INPUT} characters)`);
        } else if (!new RegExp(v.regexp.pattern, v.regexp.flags).test(value)) {
          push(ruleMessage(v, 'regexp') ?? `Does not match pattern /${v.regexp.pattern}/`);
        }
      }
      break;
    }
    case 'Integer':
    case 'Number': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        push('Expected a number');
        return;
      }
      if (field.type === 'Integer' && !Number.isInteger(value)) push('Expected an integer');
      checkRange(value, v, push);
      checkIn(value, v, push);
      break;
    }
    case 'Boolean':
      if (typeof value !== 'boolean') push('Expected a boolean');
      break;
    case 'Date': {
      const problem = dateValueProblem(value, field.format);
      if (problem) push(problem);
      else checkDateRange(value as string, field.format, v, push);
      break;
    }
    case 'Location': {
      const loc = value as { lat?: unknown; lon?: unknown };
      if (typeof loc?.lat !== 'number' || typeof loc?.lon !== 'number') {
        push('Expected { lat: number, lon: number }');
      }
      break;
    }
    case 'JSON': {
      if (typeof value !== 'object' || value === null) {
        push('Expected a JSON object');
        break;
      }
      // Cap the serialized size so a single field can't store an unbounded blob.
      try {
        if (JSON.stringify(value).length > MAX_JSON_FIELD_BYTES) {
          push(`JSON value exceeds ${MAX_JSON_FIELD_BYTES} bytes`);
        }
      } catch {
        push('JSON value is not serializable');
      }
      break;
    }
    case 'RichText': {
      for (const issue of validateRichText(value)) push(issue);
      break;
    }
    case 'Link':
      if (!isLink(value)) push('Expected a link { id, linkType }');
      break;
    case 'Component': {
      validateComponent(field.fields ?? [], value, locale, issues, path, push, kept);
      break;
    }
    case 'Seo': {
      // A component of fixed shape; the canonical URL's form is the one rule a field can't say.
      validateComponent(SEO_FIELDS, value, locale, issues, path, push);
      const canonical = (value as { canonicalUrl?: unknown } | null)?.canonicalUrl;
      if (typeof canonical === 'string') {
        const issue = canonicalUrlIssue(canonical);
        if (issue) issues.push({ field: `${path}.canonicalUrl`, locale, message: issue });
      }
      break;
    }
    case 'Array': {
      if (!Array.isArray(value)) {
        push('Expected an array');
        return;
      }
      checkSize(value.length, v, push, 'item count');
      const itemType = field.items?.type;
      const variants = itemType === 'Component' ? field.items?.variants : undefined;
      if (variants) {
        validateBlocks(variants, value, locale, issues, path);
        break;
      }
      value.forEach((item, index) => {
        if (itemType === 'Link' && !isLink(item))
          push('Array item must be a link { id, linkType }');
        if (itemType === 'Symbol' && typeof item !== 'string') push('Array item must be a string');
        // The other scalars report against the element, so "the third date" is sayable. Element
        // rules (`items.validations`) are stored but not enforced per element yet.
        const problem = scalarItemProblem(itemType, field.items?.format, item);
        if (problem) issues.push({ field: `${path}[${index}]`, locale, message: problem });
        if (itemType === 'Component') {
          // Indexed, so "the third card is missing its title" is sayable.
          const at = `${path}[${index}]`;
          validateComponent(field.items?.fields ?? [], item, locale, issues, at, (m) =>
            issues.push({ field: at, locale, message: m }),
          );
        }
      });
      break;
    }
  }
}

/**
 * Validates a component value: an object keyed by the nested field apiIds.
 *
 * Nested fields carry no locale of their own — the component field decides
 * that once — so every leaf is checked under the locale its container was
 * checked under.
 */
function validateComponent(
  nested: readonly FieldDefinition[],
  value: unknown,
  locale: LocaleCode,
  issues: FieldIssue[],
  path: string,
  push: (message: string) => void,
  kept?: Kept,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    push('Expected an object of nested field values');
    return;
  }
  const values = value as Record<string, unknown>;
  const defined = new Set(nested.map((f) => f.apiId));
  for (const key of Object.keys(values)) {
    if (!defined.has(key)) {
      issues.push({ field: `${path}.${key}`, locale, message: `Unknown field "${key}"` });
    }
  }

  // A component's own fields: what is stored for it, when this is an edit of a single component
  // (an Array's elements carry no `kept`, so `disable` never applies inside one).
  const keptValues =
    kept && typeof kept.value === 'object' && kept.value !== null && !Array.isArray(kept.value)
      ? (kept.value as Record<string, unknown>)
      : {};
  for (const f of nested) {
    const at = `${path}.${f.apiId}`;
    const nestedValue = values[f.apiId];
    // Rules read the siblings inside this component value.
    const state = fieldState(f, values);
    const nestedKept: Kept = kept ? { value: keptValues[f.apiId] } : undefined;
    if (state.disabled && nestedKept && !sameFieldValue(nestedValue, nestedKept.value)) {
      issues.push({ field: at, locale, message: DISABLED_MESSAGE });
      continue;
    }
    if (nestedValue === undefined || nestedValue === null) {
      // Required means required wherever the component appears — including in
      // the fourth item of a repeater, which is the case that would otherwise
      // slip through — unless the component's own rules hide the field.
      if (f.required && !state.hidden) {
        issues.push({ field: at, locale, message: 'Field is required' });
      }
      continue;
    }
    validateValue(f, nestedValue, locale, issues, at, nestedKept);
  }
}

/**
 * Validates the elements of a blocks field: each names a declared variant in
 * `_type` and is then checked as that variant's component.
 *
 * `_key` is not required here. It is assigned on write (`assignBlockKeys`), so
 * a value that has not been written yet (an AI draft, an import dry-run, the
 * editor's own pre-save check) is judged on its content alone. A key that is
 * present must be a non-empty string used once in the field value: two blocks
 * sharing a key would make every client that addresses a block by it (a
 * comment anchor, a live-preview patch) pick one of them at random.
 */
function validateBlocks(
  variants: readonly ComponentVariant[],
  items: readonly unknown[],
  locale: LocaleCode,
  issues: FieldIssue[],
  path: string,
): void {
  const keys = new Set<string>();
  items.forEach((item, index) => {
    const at = `${path}[${index}]`;
    const push = (message: string) => issues.push({ field: at, locale, message });
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      push('Expected a block object with a _type');
      return;
    }
    const { [BLOCK_TYPE_KEY]: type, [BLOCK_KEY]: key, ...values } = item as Record<string, unknown>;
    if (key !== undefined) {
      if (typeof key !== 'string' || key === '') push('_key must be a non-empty string');
      else if (keys.has(key)) push(`Duplicate _key "${key}"`);
      else keys.add(key);
    }
    if (typeof type !== 'string' || type === '') {
      push(`Block is missing _type (one of: ${variants.map((v) => v.apiId).join(', ')})`);
      return;
    }
    const variant = variants.find((v) => v.apiId === type);
    if (!variant) {
      push(`Unknown block type "${type}" (one of: ${variants.map((v) => v.apiId).join(', ')})`);
      return;
    }
    validateComponent(variant.fields, values, locale, issues, at, push);
  });
}

/** Why an element of a list of Text, Integer, Number or Date is not one, or null. */
function scalarItemProblem(
  type: string | undefined,
  format: DateFormat | undefined,
  item: unknown,
): string | null {
  switch (type) {
    case 'Text':
      return typeof item === 'string' ? null : 'Expected a string';
    case 'Integer':
      return typeof item === 'number' && Number.isInteger(item) ? null : 'Expected an integer';
    case 'Number':
      return typeof item === 'number' && Number.isFinite(item) ? null : 'Expected a number';
    case 'Date':
      return dateValueProblem(item, format);
    default:
      return null;
  }
}

function isLink(value: unknown): value is { id: string; linkType: string } {
  const l = value as { id?: unknown; linkType?: unknown };
  return typeof l?.id === 'string' && typeof l?.linkType === 'string';
}

// Each check reports the rule's custom message, when the definition gives one,
// in place of its default text: the author's wording is the instruction an
// editor (or agent) can act on, and the default is only a description of the rule.

function checkIn(
  value: string | number,
  v: FieldValidations | undefined,
  push: (m: string) => void,
) {
  // A list stored before options were checked may be anything; a non-list constrains nothing.
  if (!Array.isArray(v?.in)) return;
  const allowed = v.in.map(optionValue);
  if (!allowed.includes(value))
    push(ruleMessage(v, 'in') ?? `Value must be one of: ${allowed.join(', ')}`);
}

function checkDateRange(
  value: string,
  format: DateFormat | undefined,
  v: FieldValidations | undefined,
  push: (m: string) => void,
) {
  const range = v?.dateRange;
  if (!range) return;
  const at = dateSortKey(value, format);
  const min = typeof range.min === 'string' ? dateSortKey(range.min, format) : null;
  const max = typeof range.max === 'string' ? dateSortKey(range.max, format) : null;
  if (at === null) return;
  if (min !== null && at < min)
    push(ruleMessage(v, 'dateRange') ?? `Must be ${range.min} or later`);
  if (max !== null && at > max) {
    push(ruleMessage(v, 'dateRange') ?? `Must be ${range.max} or earlier`);
  }
}

function checkRange(value: number, v: FieldValidations | undefined, push: (m: string) => void) {
  const range = v?.range;
  if (range?.min !== undefined && value < range.min)
    push(ruleMessage(v, 'range') ?? `Must be >= ${range.min}`);
  if (range?.max !== undefined && value > range.max)
    push(ruleMessage(v, 'range') ?? `Must be <= ${range.max}`);
}

function checkSize(
  n: number,
  v: FieldValidations | undefined,
  push: (m: string) => void,
  label: string,
) {
  const size = v?.size;
  const custom = ruleMessage(v, 'size');
  if (size?.min !== undefined && n < size.min) push(custom ?? `${label} must be >= ${size.min}`);
  if (size?.max !== undefined && n > size.max) push(custom ?? `${label} must be <= ${size.max}`);
}
