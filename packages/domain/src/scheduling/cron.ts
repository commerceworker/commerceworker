/**
 * Minimal, dependency-free 5-field cron (minute hour day-of-month month
 * day-of-week), evaluated in UTC. Supports `*`, numbers, lists (`,`), ranges
 * (`-`), and steps (`*​/n`, `a-b/n`). Day-of-month and day-of-week follow the
 * classic vixie-cron rule: when BOTH are restricted, a date matching EITHER
 * fires. Month is 1–12; day-of-week 0–6 with both 0 and 7 meaning Sunday.
 */

import { ValidationError } from '../errors';

const invalid = (message: string) => new ValidationError([{ field: 'cron', message }]);

interface CronSpec {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

function parseField(spec: string, min: number, max: number, field: string): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined || rangePart === undefined || rangePart === '') {
      throw invalid(`Invalid cron ${field} field: "${spec}"`);
    }
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw invalid(`Invalid cron ${field} step: "${spec}"`);
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b, more] = rangePart.split('-');
      // Empty endpoints reject negative values ('-5' would split to ['', '5']
      // and Number('') is 0, silently parsing as the range 0-5).
      if (more !== undefined || a === '' || b === '' || a === undefined || b === undefined) {
        throw invalid(`Invalid cron ${field} range: "${spec}"`);
      }
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      hi = stepPart === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw invalid(`Invalid cron ${field} value: "${spec}" (allowed ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw invalid(
      `Invalid cron expression "${expr}": expected 5 fields (minute hour day-of-month month day-of-week)`,
    );
  }
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const daysOfWeek = parseField(dow, 0, 7, 'day-of-week');
  // 7 is an alias for Sunday (0).
  if (daysOfWeek.has(7)) {
    daysOfWeek.delete(7);
    daysOfWeek.add(0);
  }
  return {
    minutes: parseField(minute, 0, 59, 'minute'),
    hours: parseField(hour, 0, 23, 'hour'),
    daysOfMonth: parseField(dom, 1, 31, 'day-of-month'),
    months: parseField(month, 1, 12, 'month'),
    daysOfWeek,
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  };
}

/** Validates a cron expression, throwing ValidationError when malformed. */
export function assertValidCron(expr: string): void {
  parseCron(expr);
}

function dayMatches(spec: CronSpec, date: Date): boolean {
  const domOk = spec.daysOfMonth.has(date.getUTCDate());
  const dowOk = spec.daysOfWeek.has(date.getUTCDay());
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

// ~5 years of day-steps upper-bounds any satisfiable expression (worst
// realistic gap is Feb 29 ≈ 4 years); anything longer is unsatisfiable
// (e.g. day-of-month 31 in February).
const MAX_ITERATIONS = 5 * 366 * 24 * 60;

/**
 * The next instant strictly after `after` matching the expression (UTC).
 * Throws ValidationError for malformed or unsatisfiable expressions.
 */
export function nextCronOccurrence(expr: string, after: Date): Date {
  const spec = parseCron(expr);
  const c = new Date(after.getTime());
  c.setUTCSeconds(0, 0);
  c.setUTCMinutes(c.getUTCMinutes() + 1);
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (!spec.months.has(c.getUTCMonth() + 1)) {
      // First minute of the next month.
      c.setUTCMonth(c.getUTCMonth() + 1, 1);
      c.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(spec, c)) {
      c.setUTCDate(c.getUTCDate() + 1);
      c.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hours.has(c.getUTCHours())) {
      c.setUTCHours(c.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!spec.minutes.has(c.getUTCMinutes())) {
      c.setUTCMinutes(c.getUTCMinutes() + 1);
      continue;
    }
    return c;
  }
  throw invalid(`Cron expression "${expr}" never matches (unsatisfiable)`);
}
