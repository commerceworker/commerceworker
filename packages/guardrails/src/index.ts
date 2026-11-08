import {
  GUARDRAIL_MAX_CHECKS,
  GUARDRAIL_MAX_REGEX_PATTERN_LENGTH,
  GUARDRAIL_MAX_SCAN_BYTES,
} from './constants';

export {
  GUARDRAIL_MAX_CHECKS,
  GUARDRAIL_MAX_REGEX_PATTERN_LENGTH,
  GUARDRAIL_MAX_SCAN_BYTES,
} from './constants';

export {
  guardrailPolicyPutBodySchema,
  guardrailPolicyRecordSchema,
} from './schema';

export type GuardrailAction = 'block' | 'warn' | 'log' | 'none';

export type GuardrailCheckType = 'pii' | 'prompt-injection' | 'regex';

export interface GuardrailCheck {
  type: GuardrailCheckType;
  target: 'input' | 'output' | 'both';
  /** For type === 'regex': pattern source (case-insensitive flag applied). */
  pattern?: string;
}

export interface GuardrailPolicy {
  checks: GuardrailCheck[];
  defaultAction: GuardrailAction;
}

const DEFAULT_POLICY: GuardrailPolicy = { checks: [], defaultAction: 'log' };

const PII_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, label: 'SSN pattern detected' },
  { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, label: 'Card number pattern detected' },
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i, label: 'Email address detected' },
];

const INJECTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, label: 'Prompt injection phrase' },
  { pattern: /disregard\s+(all\s+)?(above|previous)/i, label: 'Prompt injection phrase' },
  { pattern: /\n\s*system\s*:/i, label: 'System prompt override attempt' },
];

/** Truncates to at most `maxBytes` UTF-8 bytes (best-effort; avoids huge scans). */
export function truncateScanText(
  input: string,
  maxBytes: number = GUARDRAIL_MAX_SCAN_BYTES,
): string {
  if (maxBytes <= 0) return '';
  const enc = new TextEncoder();
  const buf = enc.encode(input);
  if (buf.length <= maxBytes) return input;
  return new TextDecoder('utf-8').decode(buf.subarray(0, maxBytes));
}

function checkPii(text: string, direction: 'input' | 'output'): string[] {
  const hits: string[] = [];
  for (const { pattern, label } of PII_PATTERNS) {
    if (pattern.test(text)) hits.push(`pii:${direction}:${label}`);
  }
  return hits;
}

function checkInjection(text: string, direction: 'input' | 'output'): string[] {
  const hits: string[] = [];
  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(text)) hits.push(`prompt-injection:${direction}:${label}`);
  }
  return hits;
}

function checkRegex(text: string, source: string, direction: 'input' | 'output'): string[] {
  if (source.length > GUARDRAIL_MAX_REGEX_PATTERN_LENGTH) return [];
  try {
    const re = new RegExp(source, 'i');
    if (re.test(text)) return [`regex:${direction}:${source}`];
  } catch {
    /* invalid pattern — skip */
  }
  return [];
}

function normalizeAction(a: unknown): GuardrailAction {
  if (a === 'block' || a === 'warn' || a === 'log' || a === 'none') return a;
  return 'log';
}

function normalizeCheck(item: unknown): GuardrailCheck | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  const type = o.type;
  const target = o.target;
  if (type !== 'pii' && type !== 'prompt-injection' && type !== 'regex') return null;
  if (target !== 'input' && target !== 'output' && target !== 'both') return null;
  if (type === 'regex') {
    if (typeof o.pattern !== 'string') return null;
    const pattern = o.pattern.slice(0, GUARDRAIL_MAX_REGEX_PATTERN_LENGTH).trim();
    if (!pattern) return null;
    return { type, target, pattern };
  }
  return { type, target };
}

function normalizePolicyRecord(v: unknown): GuardrailPolicy {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return DEFAULT_POLICY;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.checks)) return DEFAULT_POLICY;
  const checks: GuardrailCheck[] = [];
  for (const item of o.checks.slice(0, GUARDRAIL_MAX_CHECKS)) {
    const c = normalizeCheck(item);
    if (c) checks.push(c);
  }
  return { checks, defaultAction: normalizeAction(o.defaultAction) };
}

/**
 * Parse a tenant guardrail policy from JSON text, a parsed object (e.g. control-plane jsonb), or null.
 */
export function parsePolicyJson(raw: unknown): GuardrailPolicy {
  if (raw == null) return DEFAULT_POLICY;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return DEFAULT_POLICY;
    try {
      return normalizePolicyRecord(JSON.parse(s) as unknown);
    } catch {
      return DEFAULT_POLICY;
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return normalizePolicyRecord(raw);
  }
  return DEFAULT_POLICY;
}

export interface GuardrailResult {
  passed: boolean;
  violations: string[];
  action: GuardrailAction;
}

export function evaluateGuardrails(
  policy: GuardrailPolicy,
  slices: { inputText?: string; outputText?: string },
): GuardrailResult {
  const inputText = truncateScanText(slices.inputText ?? '');
  const outputText = truncateScanText(slices.outputText ?? '');

  const violations: string[] = [];

  for (const check of policy.checks) {
    const runInput = check.target === 'input' || check.target === 'both' ? inputText : '';
    const runOutput = check.target === 'output' || check.target === 'both' ? outputText : '';

    if (check.type === 'pii') {
      if (runInput) violations.push(...checkPii(runInput, 'input'));
      if (runOutput) violations.push(...checkPii(runOutput, 'output'));
    }
    if (check.type === 'prompt-injection') {
      if (runInput) violations.push(...checkInjection(runInput, 'input'));
      if (runOutput) violations.push(...checkInjection(runOutput, 'output'));
    }
    if (check.type === 'regex' && check.pattern) {
      if (runInput) violations.push(...checkRegex(runInput, check.pattern, 'input'));
      if (runOutput) violations.push(...checkRegex(runOutput, check.pattern, 'output'));
    }
  }

  if (violations.length === 0) {
    return { passed: true, violations: [], action: 'none' };
  }

  return { passed: false, violations, action: policy.defaultAction };
}
