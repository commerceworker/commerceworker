/**
 * Status vocabulary and number formatting for CommerceWorker's statuses. Every status maps to one Ledger status token (index.css), which
 * means one thing everywhere: `ok` succeeded or live, `wait` waits on a person, `run` is work in
 * progress or on a clock, `bad` failed, `undo` was rolled back, `idle` is at rest or ended
 * otherwise, `ai` is a model's work.
 */

export type Tone = 'ok' | 'wait' | 'bad' | 'undo' | 'idle' | 'run' | 'ai';

const TONE: Record<string, Tone> = {
  // Live, done, healthy.
  published: 'ok',
  active: 'ok',
  completed: 'ok',
  succeeded: 'ok',
  success: 'ok',
  delivered: 'ok',
  approved: 'ok',
  enabled: 'ok',
  merged: 'ok',
  live: 'ok',
  // Waits on a person: an edit not yet published, a review, a paused hook.
  changed: 'wait',
  pending: 'wait',
  in_review: 'wait',
  review: 'wait',
  waiting: 'wait',
  paused: 'wait',
  modified: 'wait',
  // In progress or on a clock.
  scheduled: 'run',
  running: 'run',
  queued: 'run',
  processing: 'run',
  publishing: 'run',
  in_progress: 'run',
  // At rest, or ended otherwise. A draft and an open release are the normal editable states; a
  // revoked or expired credential is a deliberate or lapsed end, not a fault.
  draft: 'idle',
  open: 'idle',
  archived: 'idle',
  revoked: 'idle',
  expired: 'idle',
  disabled: 'idle',
  cancelled: 'idle',
  canceled: 'idle',
  skipped: 'idle',
  idle: 'idle',
  added: 'idle',
  unchanged: 'idle',
  // Went badly.
  failed: 'bad',
  failure: 'bad',
  error: 'bad',
  rejected: 'bad',
  removed: 'bad',
  // Taken back.
  rolled_back: 'undo',
  reverted: 'undo',
  unpublished: 'undo',
  // A model's work, awaiting a person's decision: an agent run that stopped for review
  // (`needs_review`) or that moderation held reads as the model's, not as an ordinary wait.
  proposed: 'ai',
  needs_review: 'ai',
  held: 'ai',
  suggested: 'ai',
  generated: 'ai',
  agent: 'ai',
};

/** The Ledger token a status means; unknown statuses read as at rest. */
export const statusTone = (s: string | undefined): Tone => TONE[s ?? ''] ?? 'idle';

/** The CSS colour for a status, through its token so it switches with the theme. */
export const statusColor = (s: string | undefined) => `var(--${statusTone(s)})`;

/** Internal identifiers to editor words: "in_review" → "In review", "api-keys" → "Api keys". */
export function humanize(s: string | null | undefined) {
  if (!s) return '';
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Sentence-case status for badges: "rolled_back" → "Rolled back". */
export const statusLabel = (s: string) => humanize(s);

/** Past two digits a count is 99+, everywhere it's shown. */
export const countLabel = (n: number) => (n > 99 ? '99+' : String(n));

/** Whole quantities with thousands separators: 25000 → "25,000". */
export const count = (n: number) => new Intl.NumberFormat('en-US').format(n);

/** "1 entry" / "3 entries". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A timestamp (ms or ISO) as ms; null when missing or unreadable. */
export const toMs = (t: number | string | null | undefined) => {
  if (t == null || t === '') return null;
  const ms = typeof t === 'number' ? t : Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
};

/** "3m ago", "2h ago", "4d ago"; "just now" under five seconds; an em dash for nothing. */
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
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

/** A length of time: "850ms", "12s", "4m", "1.5h", "3d". */
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

/** A full local date and time, for a tooltip: "Oct 30, 2026, 2:05 PM". */
export const dateTime = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
