/** Number, money and time formatting shared by the admin and the storefront's cart. */

/** Whole quantities with thousands separators: 25000 → "25,000". */
export const count = (n: number) => new Intl.NumberFormat('en-US').format(n);

/** "1 line" / "3 lines" / "1,200 lines". */
export const plural = (n: number, one: string, many = `${one}s`) =>
  `${count(n)} ${n === 1 ? one : many}`;

export function money(n: number | null | undefined, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(n ?? 0);
}

/**
 * A date's fields by type ("month", "hour", "dayPeriod", …). The formatters below lay the fields out
 * themselves: ICU versions differ on the punctuation between them (", " or " at " between the date
 * and the time, a narrow no-break space before AM), and the server's ICU need not be the browser's,
 * so a whole-string format can differ between the server render and the hydrating one.
 */
function fields(ms: number, options: Intl.DateTimeFormatOptions) {
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(ms);
  return Object.fromEntries(parts.map((p) => [p.type, p.value])) as Partial<
    Record<Intl.DateTimeFormatPartTypes, string>
  >;
}

/**
 * "Oct 13, 2026, 4:46 AM". Pass `timeZone` to pin the zone (server rendering uses UTC, so the
 * markup matches during hydration); omit it for the viewer's own zone. See `useDateTime`.
 */
export function dateTime(ms: number, timeZone?: string) {
  const f = fields(ms, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
  const s = `${f.month} ${f.day}, ${f.year}, ${f.hour}:${f.minute} ${f.dayPeriod}`;
  return timeZone === 'UTC' ? `${s} UTC` : s;
}

/** "2:05 PM", or "Thu 2:05 PM" with `weekday`; laid out like `dateTime`. */
export function clock(ms: number, timeZone?: string, weekday = false) {
  const f = fields(ms, {
    ...(weekday ? { weekday: 'short' } : {}),
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
  return `${weekday ? `${f.weekday} ` : ''}${f.hour}:${f.minute} ${f.dayPeriod}`;
}

export function ago(ms: number | null | undefined, now = Date.now()) {
  if (!ms) return '—';
  const s = Math.round((now - ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Time remaining until a deadline: "in 42m", "in 3h", or "overdue". */
export function until(ms: number | null | undefined, now = Date.now()) {
  if (!ms) return '';
  const s = Math.round((ms - now) / 1000);
  if (s <= 0) return 'overdue';
  if (s < 60) return `in ${s}s`;
  if (s < 120) return `in 1m ${s - 60}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}
