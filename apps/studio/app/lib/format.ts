/**
 * Status colours by token. Content statuses (draft, changed, published, archived, scheduled) and
 * run statuses (workflows, bulk jobs) share the same few: in progress, waiting, done, failed.
 */
export const STATUS_COLOR: Record<string, string> = {
  draft: 'var(--idle)',
  changed: 'var(--wait)',
  published: 'var(--ok)',
  archived: 'var(--idle)',
  scheduled: 'var(--run)',
  pending: 'var(--idle)',
  queued: 'var(--idle)',
  running: 'var(--run)',
  waiting: 'var(--wait)',
  succeeded: 'var(--ok)',
  completed: 'var(--ok)',
  declined: 'var(--idle)',
  failed: 'var(--bad)',
  skipped: 'var(--idle)',
  cancelled: 'var(--idle)',
  rolled_back: 'var(--undo)',
};

export const statusColor = (s: string | undefined) => STATUS_COLOR[s ?? 'pending'] ?? 'var(--idle)';

/** Sentence-case status for badges: "rolled_back" → "Rolled back". */
export const statusLabel = (s: string) => humanize(s);

/** Internal identifiers to operator words: "content_type" → "Content type", "en-US" → "En US". */
export function humanize(s: string | null | undefined) {
  if (!s) return '';
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** How an approval ended, in plain words: a timed-out one reads "Timed out". */
export function outcomeLabel(s: string | null | undefined) {
  return s === 'escalated' || s === 'timeout' ? 'Timed out' : humanize(s);
}

/** Whole quantities with thousands separators: 25000 → "25,000". */
export const count = (n: number) => new Intl.NumberFormat('en-US').format(n);

/** "1 entry" / "3 entries" (pass the plural). */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * "Oct 13, 2026, 4:46 AM". Pass `timeZone` to pin the zone (server rendering uses UTC, so the
 * markup matches during hydration); omit it for the viewer's own zone. See `useDateTime`.
 */
export function dateTime(ms: number, timeZone?: string) {
  const s = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(ms);
  return timeZone === 'UTC' ? `${s} UTC` : s;
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

/** A duration: "12ms", "12s", "3m", "2.5h", "4d". */
export function duration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}
