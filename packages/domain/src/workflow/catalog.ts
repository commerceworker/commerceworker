/**
 * The node catalog model: each node type's metadata, its config fields and its output branches.
 * The admin builds its palette and inspector forms from this; the application pairs each type with
 * an executor. Config fields are the single source of truth for validation.
 *
 * - field validation is hand-written `check` functions (the domain has no dependencies);
 * - there is no plugin `provider` field kind (plugin node types are deferred);
 * - picker kinds `contentType`, `field` and `release` serve the inspector;
 * - categories are editorial (`content` acts on entries).
 *
 * The catalog itself (`NODE_SPECS`) lives in `nodes.ts`.
 */

import { cloneJson } from './graph-types';
import { logicIssues } from './logic';

export type NodeCategory = 'trigger' | 'content' | 'control' | 'ai';

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  trigger: 'Triggers',
  content: 'Content',
  control: 'Control',
  ai: 'AI',
};

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'select'
  | 'duration'
  /** A JSON Logic expression evaluated against the run context. */
  | 'logic'
  | 'json'
  | 'list'
  /** A content type apiId (the inspector renders a picker). */
  | 'contentType'
  /** A field apiId of the workflow's content types. */
  | 'field'
  /** A release id. */
  | 'release';

export interface ConfigField {
  key: string;
  label: string;
  kind: FieldKind;
  hint?: string;
  required?: boolean;
  options?: string[];
  default?: unknown;
  /**
   * Overrides the kind's validation, for structured `json` fields.
   * Returns error messages; empty when the value is acceptable.
   */
  check?: (value: unknown) => string[];
}

export interface NodeSpec {
  type: string;
  category: NodeCategory;
  label: string;
  description: string;
  /** lucide-react icon name. */
  icon: string;
  fields: ConfigField[];
  /** Output branches. A function when they depend on config (the AI router's routes). */
  outputs: string[] | ((config: Record<string, unknown>) => string[]);
  /** Has a saga compensation (run in reverse if the run later fails). */
  rollback?: boolean;
  /** Waits for a human or an external event. */
  waits?: boolean;
  /** `control.loop` only: has the extra "next" input for back-edges. */
  loop?: boolean;
  retries?: number;
  /** Errors that span fields, after each field passes its own check. */
  validate?: (config: Record<string, unknown>) => string[];
}

/** A spec's output branches for `config`. */
export function specOutputs(spec: NodeSpec, config: Record<string, unknown> = {}): string[] {
  return typeof spec.outputs === 'function' ? spec.outputs(config) : spec.outputs;
}

/** Config with every missing field filled from its spec default. */
export function specDefaults(
  spec: NodeSpec | undefined,
  config: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of spec?.fields ?? []) {
    if (f.default !== undefined) out[f.key] = cloneJson(f.default);
  }
  return { ...out, ...config };
}

export const DURATION_RE = /^\s*(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*$/i;

const UNIT_MS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_536_000_000,
};

/** "2 days" → 172800000. Throws on anything else. */
export function durationMs(d: string): number {
  const m = DURATION_RE.exec(d);
  const unit = m?.[2] ? UNIT_MS[m[2].toLowerCase()] : undefined;
  if (!m || unit === undefined) throw new Error(`Invalid duration “${d}”`);
  return Number(m[1]) * unit;
}

export function stringList(v: unknown, fallback: string[]): string[] {
  if (Array.isArray(v)) {
    const xs = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    if (xs.length) return xs.map((x) => x.trim());
  }
  return fallback;
}

/** The kind's own validation, as hand checks. */
function kindCheck(f: ConfigField, v: unknown): string[] {
  switch (f.kind) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? [] : ['Expected a number'];
    case 'boolean':
      return typeof v === 'boolean' ? [] : ['Expected true or false'];
    case 'select':
      return typeof v === 'string' && (f.options ?? []).includes(v)
        ? []
        : [`Expected one of ${(f.options ?? []).join(', ')}`];
    case 'duration':
      return typeof v === 'string' && DURATION_RE.test(v)
        ? []
        : ['Use e.g. "30 seconds", "2 days"'];
    case 'list':
      return Array.isArray(v) &&
        v.length > 0 &&
        v.every((x) => typeof x === 'string' && x.length > 0)
        ? []
        : ['Expected a list of at least one non-empty string'];
    case 'logic':
      return logicIssues(v);
    case 'json':
      return [];
    default:
      return typeof v === 'string' ? [] : ['Expected text'];
  }
}

/** Checks config (defaults already filled in) against a spec's fields, then its own `validate`. */
export function validateFields(spec: NodeSpec, merged: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const f of spec.fields) {
    const v = merged[f.key];
    if (v === undefined || v === '') {
      if (f.required) errors.push(`${f.label} is required`);
      continue;
    }
    const issues = f.check ? f.check(v) : kindCheck(f, v);
    if (issues.length) errors.push(`${f.label}: ${issues[0] ?? 'invalid'}`);
  }
  if (!errors.length && spec.validate) errors.push(...spec.validate(merged));
  return errors;
}
