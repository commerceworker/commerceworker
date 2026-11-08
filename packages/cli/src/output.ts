/**
 * What a command hands back, and how the CLI prints it: one JSON document on stdout with `--json`
 * (for agents and scripts), a table or a few lines otherwise. Errors go to stderr either way, so
 * stdout only ever holds a command's result.
 */

/** Exit codes: stable, so a script or an agent can branch on them. */
export const EXIT = {
  ok: 0,
  /** The API refused, the network failed, or a check failed. */
  failure: 1,
  /** A bad command line, or a confirmation needed where nothing can be asked. */
  usage: 2,
  /** Not signed in, or the token was refused. */
  auth: 3,
  /** A plan holds a destructive change and `--allow-destructive` wasn't passed. */
  refused: 4,
} as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.failure,
    /** A stable machine-readable reason, printed in `--json` errors. */
    readonly code = 'error',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export const usageError = (message: string) => new CliError(message, EXIT.usage, 'usage');

/** A command's outcome: `json` is printed with `--json`, `human` without it. */
export interface Result {
  readonly json: unknown;
  readonly human: string;
  /** Non-zero to report a failure that still produced a result (a failed `doctor` check). */
  readonly exitCode?: number;
}

/** Fixed-width columns for terminal output; `—` for an empty cell. */
export function table<T extends object>(rows: readonly T[], columns: readonly string[]): string {
  if (rows.length === 0) return '(none)';
  const cell = (v: unknown) =>
    v === undefined || v === null || v === ''
      ? '—'
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v);
  const cells = rows.map((r) => columns.map((c) => cell((r as Record<string, unknown>)[c])));
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i]?.length ?? 0)));
  const line = (values: readonly string[]) =>
    values
      .map((v, i) => (i === values.length - 1 ? v : v.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(columns.map((c) => c.toUpperCase())), ...cells.map(line)].join('\n');
}

/** `key: value` lines, skipping empty values. */
export function pairs(values: object): string {
  const entries = Object.entries(values).filter(([, v]) => v !== undefined && v !== null);
  const width = Math.max(...entries.map(([k]) => k.length));
  return entries
    .map(([k, v]) => `${`${k}:`.padEnd(width + 2)}${Array.isArray(v) ? v.join(' ') : String(v)}`)
    .join('\n');
}
