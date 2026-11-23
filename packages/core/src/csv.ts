/**
 * CSV, as CommerceWorker reads and writes it: RFC 4180 records streamed from bytes (the catalog's
 * feeds and the admin's bulk imports read with it), and cells written so a spreadsheet opens them
 * as text, never as a formula. Pure, and zod-free, so any Worker can import it.
 */

/** A CSV record and the byte offset just past it (its line break included). */
export type CsvRecord = { record: string[]; end: number };

/** UTF-8 bytes of the UTF-16 code unit `c` (a surrogate pair counts 4 on its high half). */
const utf8Bytes = (c: number) =>
  c < 0x80
    ? 1
    : c < 0x800
      ? 2
      : c >= 0xd800 && c <= 0xdbff
        ? 4
        : c >= 0xdc00 && c <= 0xdfff
          ? 0
          : 3;

/**
 * RFC 4180 records from a byte stream: quoted fields, `""` escapes, CRLF or LF, a leading BOM.
 * Each record carries the byte offset just past it, counted from `start` (where the stream begins
 * in the file), so a reader can stop after any record and resume there with a range read
 * (stopping early cancels the stream). The
 * file must be UTF-8: invalid bytes would make the offsets wrong, so they fail the parse.
 */
export async function* csvRecords(
  stream: ReadableStream<Uint8Array>,
  start = 0,
): AsyncGenerator<CsvRecord, void, undefined> {
  // ignoreBOM keeps a BOM as a character, so its three bytes are counted like any other.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let field = '';
  let record: string[] = [];
  let quoted = false;
  // After a closing quote inside a quoted field: the next char decides (`"` escape or end).
  let quoteSeen = false;
  let started = false;
  let pendingCR = false;
  let bytes = start;
  let first = start === 0;
  let finished = false;
  const reader = stream.getReader();
  const endRecord = function* () {
    record.push(field);
    field = '';
    const r = record;
    record = [];
    started = false;
    if (!(r.length === 1 && r[0] === '')) yield { record: r, end: bytes };
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      let text: string;
      try {
        text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      } catch {
        throw new SyntaxError(`the file is not valid UTF-8 (near byte ${bytes})`);
      }
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        bytes += utf8Bytes(code);
        if (first) {
          first = false;
          if (code === 0xfeff) continue;
        }
        const ch = text[i] as string;
        if (pendingCR) {
          pendingCR = false;
          if (ch === '\n') continue;
        }
        if (quoted) {
          if (quoteSeen) {
            quoteSeen = false;
            if (ch === '"') {
              field += '"';
              continue;
            }
            quoted = false;
            // Fall through: the char after a closing quote is handled as unquoted.
          } else if (ch === '"') {
            quoteSeen = true;
            continue;
          } else {
            field += ch;
            continue;
          }
        }
        if (ch === '"' && !started) {
          quoted = true;
          started = true;
        } else if (ch === ',') {
          record.push(field);
          field = '';
          started = false;
        } else if (ch === '\n' || ch === '\r') {
          if (ch === '\r') {
            pendingCR = true;
            // A CRLF record ends after its LF: count it now, so `end` lands past the line break.
            if (text[i + 1] === '\n') {
              bytes += 1;
              i++;
              pendingCR = false;
            }
          }
          yield* endRecord();
        } else {
          field += ch;
          started = true;
        }
      }
      if (done) break;
    }
    finished = true;
    if (quoted && !quoteSeen) throw new SyntaxError('unterminated quoted field at end of file');
    if (field !== '' || record.length) yield* endRecord();
  } finally {
    // Stopped early (a chunk is full, or an error): cancel the rest of the stream.
    if (finished) reader.releaseLock();
    else await reader.cancel().catch(() => {});
  }
}

/**
 * One cell as CSV writes it. Quoted when it holds a comma, quote or line break (quotes doubled).
 * A cell a spreadsheet would read as a formula (starting `=`, `+`, `-`, `@`, a tab or a carriage
 * return) is prefixed with `'`, so an exported name like `=HYPERLINK(…)` stays text: OWASP's
 * guidance for CSV injection. A number is written as itself; a negative one keeps its sign, since
 * it's a number, not text a formula could hide in.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV line, CRLF-terminated as RFC 4180 writes it. */
export const csvLine = (cells: readonly (string | number | boolean | null | undefined)[]) =>
  `${cells.map(csvCell).join(',')}\r\n`;

/** A header row mapped to the columns a kind of file knows, or why it can't be read. */
export type CsvColumns = { ok: true; columns: Map<string, number> } | { ok: false; error: string };

/**
 * Maps a header row to column positions. Names are trimmed and matched without regard to case.
 * Every `required` column must be there; a column that is neither required nor `optional`, or one
 * named twice, is refused, so a misspelled column is said rather than silently ignored.
 */
export function csvColumns(
  record: readonly string[],
  required: readonly string[],
  optional: readonly string[] = [],
): CsvColumns {
  const known = new Map([...required, ...optional].map((c) => [c.toLowerCase(), c]));
  const columns = new Map<string, number>();
  for (const [i, raw] of record.entries()) {
    const name = raw.trim();
    if (!name) continue;
    const column = known.get(name.toLowerCase());
    if (!column)
      return {
        ok: false,
        error: `Unknown column "${name}". The columns are ${[...required, ...optional].join(', ')}.`,
      };
    if (columns.has(column)) return { ok: false, error: `The column "${column}" appears twice.` };
    columns.set(column, i);
  }
  const missing = required.filter((c) => !columns.has(c));
  if (missing.length)
    return {
      ok: false,
      error: `Missing ${missing.length === 1 ? 'the column' : 'the columns'} ${missing.join(', ')}.`,
    };
  return { ok: true, columns };
}
