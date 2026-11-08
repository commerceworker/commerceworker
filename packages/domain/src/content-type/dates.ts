import type { DateFormat } from './field';

/**
 * Date values by format. Each format has one written form, so values sort and compare as the
 * same kind of thing on every surface (see `DATE_FORMATS`).
 */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/** The written form of each format, for an error and an editor's hint. */
export const DATE_FORMAT_EXAMPLES: Readonly<Record<DateFormat, string>> = {
  date: 'YYYY-MM-DD',
  datetime: 'YYYY-MM-DDThh:mm',
  time: 'hh:mm',
};

/** Why a Date value is not of its field's format, or null when it is. */
export function dateValueProblem(value: unknown, format: DateFormat | undefined): string | null {
  if (format === undefined) {
    return typeof value !== 'string' || Number.isNaN(Date.parse(value))
      ? 'Expected an ISO-8601 date string'
      : null;
  }
  if (typeof value !== 'string') return 'Expected a date string';
  return dateSortKey(value, format) === null
    ? `Expected a ${format === 'datetime' ? 'date and time' : format} (${DATE_FORMAT_EXAMPLES[format]})`
    : null;
}

/**
 * A Date value as a number that orders like the value: milliseconds for a date or date and time,
 * seconds into the day for a time. Null when the value is not of the format (a calendar date that
 * does not exist, such as 2026-02-30, included).
 */
export function dateSortKey(value: string, format: DateFormat | undefined): number | null {
  if (format === 'time') {
    const m = TIME.exec(value);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0) : null;
  }
  if (format === 'date') {
    const m = DATE.exec(value);
    if (!m) return null;
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    // Date.UTC rolls 2026-02-30 over into March; a real date reads back the same.
    return new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
  }
  if (format === 'datetime' && !DATETIME.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
