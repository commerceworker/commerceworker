/**
 * Editorial policy rules for the `content.policy` node: the checks a publishing desk usually
 * enforces by hand (required fields, length limits, banned terms, alt text on images, enough
 * references, publishing hours), stored as data on the node. Pure: the application passes the
 * entry, the referenced assets' alt text and `now`.
 *
 * `evaluatePolicy` collects every failure rather than stopping at the first; untrusted rules are
 * checked by {@link parsePolicyRules}.
 */

import { richTextToPlainText } from '../rich-text/rich-text';
import type { EntryFields, LocalizedValue } from '../types';

export type PolicyRule =
  /** Each listed field has a non-empty value (in `locale`, else in any locale). */
  | { rule: 'required_fields'; fields: string[] }
  | { rule: 'min_words'; field: string; words: number }
  | { rule: 'max_words'; field: string; words: number }
  /** None of `terms` appears (case-insensitive, whole words) in `fields`, or in every text field. */
  | { rule: 'forbidden_terms'; terms: string[]; fields?: string[] }
  /** Every asset linked from `fields` (or from any field) has alt text. */
  | { rule: 'has_alt_text'; fields?: string[] }
  /** `field` links to at least `count` entries or assets. */
  | { rule: 'min_references'; field: string; count: number }
  | {
      rule: 'business_hours';
      /** Hours are [start, end) in `timeZone`; days are 0 (Sunday) to 6. */
      start: number;
      end: number;
      days: number[];
      timeZone: string;
    };

export const POLICY_RULES = [
  'required_fields',
  'min_words',
  'max_words',
  'forbidden_terms',
  'has_alt_text',
  'min_references',
  'business_hours',
] as const satisfies readonly PolicyRule['rule'][];

/** What the rules look at. */
export interface PolicySubject {
  fields: EntryFields;
  /** The locale to check; unset checks the first value present per field. */
  locale?: string;
  /** Alt text of the assets the entry links to, by asset id (absent: unknown asset). */
  assetAltText?: Record<string, LocalizedValue>;
}

export interface PolicyResult {
  pass: boolean;
  failures: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const nonEmptyStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.length > 0);
const optStrings = (v: unknown) => v === undefined || nonEmptyStrings(v);

/**
 * Validates untrusted rules and fills defaults (`business_hours` days Mon–Fri, `timeZone` UTC).
 * Hand-written, since the domain package has no schema library.
 */
export function parsePolicyRules(
  raw: unknown,
): { ok: true; rules: PolicyRule[] } | { ok: false; issues: string[] } {
  if (!Array.isArray(raw)) return { ok: false, issues: ['Expected a list of rules'] };
  const issues: string[] = [];
  const rules: PolicyRule[] = [];
  raw.forEach((r, i) => {
    const at = `Rule ${i + 1}`;
    if (!isRecord(r)) {
      issues.push(`${at}: expected an object`);
      return;
    }
    switch (r.rule) {
      case 'required_fields':
        if (!nonEmptyStrings(r.fields)) issues.push(`${at}: fields must list field ids`);
        else rules.push({ rule: r.rule, fields: r.fields });
        return;
      case 'min_words':
      case 'max_words':
        if (typeof r.field !== 'string' || !r.field) issues.push(`${at}: field is required`);
        else if (!isInt(r.words, r.rule === 'min_words' ? 0 : 1)) {
          issues.push(`${at}: words must be a whole number`);
        } else rules.push({ rule: r.rule, field: r.field, words: r.words });
        return;
      case 'forbidden_terms':
        if (!nonEmptyStrings(r.terms)) issues.push(`${at}: terms must list words`);
        else if (!optStrings(r.fields)) issues.push(`${at}: fields must list field ids`);
        else {
          rules.push({
            rule: r.rule,
            terms: r.terms,
            ...(r.fields ? { fields: r.fields as string[] } : {}),
          });
        }
        return;
      case 'has_alt_text':
        if (!optStrings(r.fields)) issues.push(`${at}: fields must list field ids`);
        else rules.push({ rule: r.rule, ...(r.fields ? { fields: r.fields as string[] } : {}) });
        return;
      case 'min_references':
        if (typeof r.field !== 'string' || !r.field) issues.push(`${at}: field is required`);
        else if (!isInt(r.count, 1)) issues.push(`${at}: count must be at least 1`);
        else rules.push({ rule: r.rule, field: r.field, count: r.count });
        return;
      case 'business_hours': {
        const days = r.days ?? [1, 2, 3, 4, 5];
        const timeZone = r.timeZone ?? 'UTC';
        if (!isInt(r.start, 0, 23)) issues.push(`${at}: start must be an hour from 0 to 23`);
        else if (!isInt(r.end, 1, 24)) issues.push(`${at}: end must be an hour from 1 to 24`);
        else if (!(Array.isArray(days) && days.every((d) => isInt(d, 0, 6)))) {
          issues.push(`${at}: days are 0 (Sunday) to 6`);
        } else if (typeof timeZone !== 'string' || !validTimeZone(timeZone)) {
          issues.push(`${at}: unknown time zone`);
        } else {
          rules.push({
            rule: r.rule,
            start: r.start,
            end: r.end,
            days: days as number[],
            timeZone,
          });
        }
        return;
      }
      default:
        issues.push(`${at}: rule must be one of ${POLICY_RULES.join(', ')}`);
    }
  });
  return issues.length ? { ok: false, issues } : { ok: true, rules };
}

function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localTime(now: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { day: WEEKDAY[get('weekday')] ?? 0, hour: Number(get('hour')) };
}

const empty = (v: unknown) =>
  v === undefined ||
  v === null ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0);

/** The value of a localized field in `locale`, else the first non-empty value. */
function fieldValue(fields: EntryFields, field: string, locale?: string): unknown {
  const lv = fields[field];
  if (!lv) return undefined;
  if (locale) return lv[locale];
  return Object.values(lv).find((v) => !empty(v));
}

/** Plain text of a value: strings as-is, rich text flattened, arrays of strings joined. */
function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').join(' ');
  return richTextToPlainText(v);
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every `{ id, linkType }` link inside a value, however deep (arrays, components, rich text).
 * Exported so the policy node can look up exactly the assets the rules will check.
 */
export function linksIn(v: unknown, out: { id: string; linkType: string }[] = []) {
  if (Array.isArray(v)) {
    for (const x of v) linksIn(x, out);
  } else if (isRecord(v)) {
    if (typeof v.id === 'string' && (v.linkType === 'Entry' || v.linkType === 'Asset')) {
      out.push({ id: v.id, linkType: v.linkType });
    } else {
      for (const x of Object.values(v)) linksIn(x, out);
    }
  }
  return out;
}

function check(rule: PolicyRule, s: PolicySubject, now: number): string | null {
  switch (rule.rule) {
    case 'required_fields': {
      const missing = rule.fields.filter((f) => empty(fieldValue(s.fields, f, s.locale)));
      return missing.length ? `Missing required fields: ${missing.join(', ')}` : null;
    }
    case 'min_words': {
      const n = wordCount(textOf(fieldValue(s.fields, rule.field, s.locale)));
      return n < rule.words ? `${rule.field} has ${n} words; at least ${rule.words} needed` : null;
    }
    case 'max_words': {
      const n = wordCount(textOf(fieldValue(s.fields, rule.field, s.locale)));
      return n > rule.words ? `${rule.field} has ${n} words; at most ${rule.words} allowed` : null;
    }
    case 'forbidden_terms': {
      const fields = rule.fields ?? Object.keys(s.fields);
      const text = fields.map((f) => textOf(fieldValue(s.fields, f, s.locale))).join('\n');
      const hit = rule.terms.filter((t) =>
        new RegExp(`(^|\\W)${escapeRe(t)}(?=\\W|$)`, 'i').test(text),
      );
      return hit.length ? `Contains forbidden terms: ${hit.join(', ')}` : null;
    }
    case 'has_alt_text': {
      const fields = rule.fields ?? Object.keys(s.fields);
      const assets = new Set<string>();
      for (const f of fields) {
        for (const v of Object.values(s.fields[f] ?? {})) {
          for (const l of linksIn(v)) if (l.linkType === 'Asset') assets.add(l.id);
        }
      }
      const missing = [...assets].filter((id) => {
        const alt = s.assetAltText?.[id];
        if (!alt) return true;
        return s.locale ? empty(alt[s.locale]) : Object.values(alt).every(empty);
      });
      return missing.length ? `Images without alt text: ${missing.join(', ')}` : null;
    }
    case 'min_references': {
      const ids = new Set(linksIn(fieldValue(s.fields, rule.field, s.locale)).map((l) => l.id));
      return ids.size < rule.count
        ? `${rule.field} links ${ids.size}; at least ${rule.count} needed`
        : null;
    }
    case 'business_hours': {
      const { day, hour } = localTime(now, rule.timeZone);
      const open = rule.days.includes(day) && hour >= rule.start && hour < rule.end;
      return open
        ? null
        : `Outside business hours (${rule.start}:00–${rule.end}:00 ${rule.timeZone})`;
    }
  }
}

/** Runs every rule and collects every failure, so the author hears about all of them at once. */
export function evaluatePolicy(
  rules: readonly PolicyRule[],
  subject: PolicySubject,
  now: number,
): PolicyResult {
  const failures = rules.map((r) => check(r, subject, now)).filter((f): f is string => f !== null);
  return { pass: failures.length === 0, failures };
}
