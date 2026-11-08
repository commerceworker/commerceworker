import type { EntryFields, LocaleCode } from '../types';
import type { FieldDefinition } from './field';

/**
 * Conditional field rules: a field hidden or disabled while a sibling's value matches.
 *
 * Rules are evaluated here, in the domain, so every surface agrees on them: validation skips
 * `required` on a hidden field and refuses a change to a disabled one, whether the write comes
 * from the admin, the HTTP API, an MCP agent or a model; the admin draws the same answer live.
 *
 * A condition reads the values being written, never what was stored, so the form and the save
 * judge the same thing. It reads a sibling's raw value, whether or not that sibling is itself
 * hidden: visibility is a matter of presentation and of `required`, not of what is stored, which
 * also means rules can never chase each other in a cycle.
 */

/** What a matching rule does to its field. */
export const RULE_ACTIONS = ['hide', 'disable'] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

/**
 * How a condition compares the sibling's value:
 * - `eq`, `ne`: equal or not to `value` (a string, number or boolean);
 * - `in`: one of `value` (a list of strings or numbers);
 * - `empty`, `notEmpty`: no value (absent, null, '', or an empty list or object), or some;
 * - `gt`, `lt`: greater or less than `value`, for a number sibling only.
 */
export const RULE_OPERATORS = ['eq', 'ne', 'in', 'empty', 'notEmpty', 'gt', 'lt'] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

export type RuleValue = string | number | boolean | readonly (string | number)[];

export interface FieldCondition {
  /**
   * The sibling the condition reads: the apiId of another field at the same level, or a dot path
   * into a sibling Component's fields (`hero.style`).
   */
  readonly field: string;
  readonly operator: RuleOperator;
  /** What the sibling is compared with; absent for `empty` and `notEmpty`. */
  readonly value?: RuleValue;
}

/** Hide or disable the field while `when` matches. */
export interface FieldRule {
  readonly action: RuleAction;
  readonly when: FieldCondition;
}

/** Most rules one field carries. */
export const MAX_FIELD_RULES = 10;
/** Most values an `in` condition lists. */
const MAX_IN_VALUES = 100;
/** Longest text a condition compares with. */
const MAX_RULE_TEXT = 200;

/** A field's effective state under its rules. */
export interface FieldState {
  readonly hidden: boolean;
  readonly disabled: boolean;
}

const OPEN: FieldState = { hidden: false, disabled: false };

/**
 * The sibling a dot path names, from the definitions at the field's own level: each segment but
 * the last steps into a Component sibling. Undefined when the path names nothing.
 */
export function ruleTarget(
  siblings: readonly FieldDefinition[],
  path: string,
): FieldDefinition | undefined {
  let level: readonly FieldDefinition[] | undefined = siblings;
  let found: FieldDefinition | undefined;
  for (const segment of path.split('.')) {
    if (!level) return undefined;
    found = level.find((f) => f.apiId === segment);
    if (!found) return undefined;
    level = found.type === 'Component' ? found.fields : undefined;
  }
  return found;
}

/** The value at a dot path within one level's values (a component object, or an entry's locale). */
export function ruleValueAt(values: Readonly<Record<string, unknown>>, path: string): unknown {
  let value: unknown = values;
  for (const segment of path.split('.')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

/** Whether a value counts as no value: absent, null, blank text, or an empty list or object. */
export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** Whether a condition holds for the sibling's value. */
export function conditionMatches(condition: FieldCondition, value: unknown): boolean {
  const target = condition.value;
  switch (condition.operator) {
    case 'eq':
      return value === target;
    case 'ne':
      return value !== target;
    case 'in':
      return Array.isArray(target) && (target as readonly unknown[]).includes(value);
    case 'empty':
      return isEmptyValue(value);
    case 'notEmpty':
      return !isEmptyValue(value);
    case 'gt':
      return typeof value === 'number' && typeof target === 'number' && value > target;
    case 'lt':
      return typeof value === 'number' && typeof target === 'number' && value < target;
    default:
      return false;
  }
}

/**
 * A field's state under its rules, given the values at its level. A rule that is malformed (a
 * definition stored by hand, say) matches nothing, so it can only ever leave a field open.
 */
export function fieldState(
  field: Pick<FieldDefinition, 'rules'>,
  values: Readonly<Record<string, unknown>>,
): FieldState {
  const rules: unknown = field.rules;
  if (!Array.isArray(rules) || rules.length === 0) return OPEN;
  let hidden = false;
  let disabled = false;
  for (const rule of rules as FieldRule[]) {
    const when = rule?.when;
    if (typeof when?.field !== 'string') continue;
    if (!conditionMatches(when, ruleValueAt(values, when.field))) continue;
    if (rule.action === 'hide') hidden = true;
    else if (rule.action === 'disable') disabled = true;
  }
  return hidden || disabled ? { hidden, disabled } : OPEN;
}

/**
 * One locale of an entry as its top-level rules read it: each field's value in that locale, or in
 * the default locale for a field that is not localized (it has no other).
 */
export function valuesForRules(
  fields: readonly FieldDefinition[],
  values: EntryFields,
  locale: LocaleCode,
  defaultLocale: LocaleCode,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    out[f.apiId] = values[f.apiId]?.[f.localized ? locale : defaultLocale];
  }
  return out;
}

/** The state of every top-level field of a type in one locale. */
export function fieldStates(
  fields: readonly FieldDefinition[],
  values: EntryFields,
  locale: LocaleCode,
  defaultLocale: LocaleCode,
): Map<string, FieldState> {
  const at = valuesForRules(fields, values, locale, defaultLocale);
  return new Map(fields.map((f) => [f.apiId, fieldState(f, at)]));
}

/**
 * Values with every hidden or disabled top-level field left out, in the default locale: what a
 * model's draft may keep. Hidden values would be content nobody sees, and a disabled field takes
 * no new value. Leaving a value out can open or close another field (a rule on `notEmpty`), so
 * the closed set is recomputed from what remains until it settles. Rules that never settle (two
 * fields each hidden while the other holds a value) leave out every field any pass closed: more
 * rather than less, and the same answer whichever pass the loop stopped on.
 */
export function withoutClosedFields(
  fields: readonly FieldDefinition[],
  values: EntryFields,
  defaultLocale: LocaleCode,
): EntryFields {
  const keep = (shut: ReadonlySet<string>): EntryFields =>
    Object.fromEntries(Object.entries(values).filter(([apiId]) => !shut.has(apiId)));
  const seen = new Set<string>();
  let out: EntryFields = values;
  let closed: string | undefined;
  for (let pass = 0; pass <= fields.length; pass++) {
    const states = fieldStates(fields, out, defaultLocale, defaultLocale);
    const shut = new Set([...states].filter(([, s]) => s.hidden || s.disabled).map(([id]) => id));
    for (const id of shut) seen.add(id);
    const key = [...shut].sort().join(',');
    if (key === closed) return out;
    closed = key;
    out = keep(shut);
  }
  return keep(seen);
}

/**
 * The proposed values (a model's, say) that may be written over `stored`: each for a field the
 * type's rules leave open once the proposal is in place. Filling one field can hide or disable
 * another (a rule on `notEmpty`), so they are judged together, as they will be stored.
 */
export function openProposals(
  fields: readonly FieldDefinition[],
  stored: EntryFields,
  proposed: EntryFields,
  defaultLocale: LocaleCode,
): EntryFields {
  const open = withoutClosedFields(fields, { ...stored, ...proposed }, defaultLocale);
  return Object.fromEntries(Object.entries(proposed).filter(([apiId]) => apiId in open));
}

/** Equal as values: deep, ignoring key order, with absent and null the same. */
export function sameFieldValue(a: unknown, b: unknown): boolean {
  if (a === undefined || a === null) return b === undefined || b === null;
  if (b === undefined || b === null) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameFieldValue(x, b[i]));
  }
  if (typeof a === 'object') {
    if (typeof b !== 'object' || Array.isArray(b)) return false;
    const ak = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] != null);
    const bk = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] != null);
    return (
      ak.length === bk.length &&
      ak.every((k) =>
        sameFieldValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return a === b;
}

/**
 * Why a rule is unusable, or null when it is fine. `siblings` is the level the field sits at;
 * `inList` says the field is part of an Array's element, where `disable` cannot hold (elements are
 * added, removed and reordered, so an element's field has no stored value to keep).
 */
export function ruleProblem(
  rule: unknown,
  field: Pick<FieldDefinition, 'apiId'>,
  siblings: readonly FieldDefinition[],
  inList: boolean,
): string | null {
  if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
    return 'a rule is { action, when: { field, operator, value? } }';
  }
  const { action, when } = rule as { action?: unknown; when?: unknown };
  if (!(RULE_ACTIONS as readonly unknown[]).includes(action)) {
    return `a rule's action is one of: ${RULE_ACTIONS.join(', ')}`;
  }
  if (action === 'disable' && inList) {
    return 'a field inside an Array element cannot be disabled: an element has no stored value to keep';
  }
  if (typeof when !== 'object' || when === null || Array.isArray(when)) {
    return "a rule's when is { field, operator, value? }";
  }
  const { field: path, operator, value } = when as Record<string, unknown>;
  if (typeof path !== 'string' || path === '') return "a rule's when.field names a sibling field";
  if (path.split('.')[0] === field.apiId) return 'a rule cannot read its own field';
  const target = ruleTarget(siblings, path);
  if (!target) return `rule field "${path}" is not a sibling field (or a component's field)`;
  if (target.type === 'Component')
    return `rule field "${path}" is a component: name one of its fields`;
  if (!(RULE_OPERATORS as readonly unknown[]).includes(operator)) {
    return `a rule's operator is one of: ${RULE_OPERATORS.join(', ')}`;
  }
  const scalar = (v: unknown) =>
    (typeof v === 'string' && v.length <= MAX_RULE_TEXT) ||
    (typeof v === 'number' && Number.isFinite(v));
  switch (operator) {
    case 'empty':
    case 'notEmpty':
      return value === undefined ? null : `"${operator}" takes no value`;
    case 'eq':
    case 'ne':
      return scalar(value) || typeof value === 'boolean'
        ? null
        : `"${operator}" compares with a string (at most ${MAX_RULE_TEXT} characters), a number or a boolean`;
    case 'in':
      return Array.isArray(value) &&
        value.length > 0 &&
        value.length <= MAX_IN_VALUES &&
        value.every(scalar)
        ? null
        : `"in" lists 1 to ${MAX_IN_VALUES} strings or numbers`;
    default:
      if (target.type !== 'Integer' && target.type !== 'Number') {
        return `"${operator}" compares numbers: "${path}" is a ${target.type} field`;
      }
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `"${operator}" compares with a number`;
  }
}

const quote = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/** A condition in words: `status is "sold"`, `price is more than 100`. */
export function describeCondition(when: FieldCondition): string {
  switch (when.operator) {
    case 'eq':
      return `${when.field} is ${quote(when.value)}`;
    case 'ne':
      return `${when.field} is not ${quote(when.value)}`;
    case 'in':
      return `${when.field} is one of ${(Array.isArray(when.value) ? when.value : []).map(quote).join(', ')}`;
    case 'empty':
      return `${when.field} is empty`;
    case 'notEmpty':
      return `${when.field} is not empty`;
    case 'gt':
      return `${when.field} is more than ${quote(when.value)}`;
    case 'lt':
      return `${when.field} is less than ${quote(when.value)}`;
    default:
      return when.field;
  }
}

/**
 * A field's rules in one line, for a model or a reader: `hidden when status is "draft"; read-only
 * when locked is not empty`. Undefined when it has none. It quotes author text (the values a
 * condition compares with), so a prompt carries it as data, like field guidance.
 */
export function describeFieldRules(field: Pick<FieldDefinition, 'rules'>): string | undefined {
  const rules: unknown = field.rules;
  if (!Array.isArray(rules) || rules.length === 0) return undefined;
  const parts = (rules as FieldRule[])
    .filter((r) => typeof r?.when?.field === 'string')
    .map(
      (r) => `${r.action === 'disable' ? 'read-only' : 'hidden'} when ${describeCondition(r.when)}`,
    );
  return parts.length ? parts.join('; ') : undefined;
}
