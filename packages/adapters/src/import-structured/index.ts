import type { ImportSource, SourceReadResult, SourceRecord } from '@commerceworker/ports';
import { identify, MAX_PAYLOAD_BYTES, type StructuredSourceOptions, tooLarge } from './shared';
import { createWxrImportSource } from './wxr';

export { MAX_PAYLOAD_BYTES, type StructuredSourceOptions } from './shared';
export { createWxrImportSource, type WxrSourceOptions } from './wxr';

/**
 * Import sources for the shapes content actually arrives in: a spreadsheet
 * exported as CSV, a JSON array from someone's old API, and a WordPress export.
 *
 * None of them knows anything about content types. A source's whole job is to turn
 * bytes into flat records and say what it could not read.
 */

/**
 * Reads a JSON array of objects, or an object wrapping one under `items`,
 * `records`, `data` or `results` — the four shapes an export API actually uses.
 */
export function createJsonImportSource(): ImportSource {
  return {
    id: 'json',
    name: 'JSON',
    async read(payload, options): Promise<SourceReadResult> {
      if (tooLarge(payload)) throw new Error(`Payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
      const opts = (options ?? {}) as StructuredSourceOptions;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch (err) {
        throw new Error(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }

      const rows = Array.isArray(parsed)
        ? parsed
        : (['items', 'records', 'data', 'results']
            .map((k) => (parsed as Record<string, unknown>)?.[k])
            .find(Array.isArray) as unknown[] | undefined);
      if (!rows) {
        throw new Error(
          'Expected a JSON array, or an object holding one under items/records/data/results',
        );
      }

      const warnings: string[] = [];
      const fields: string[] = [];
      const seenField = new Set<string>();
      const records: SourceRecord[] = [];

      rows.forEach((row, index) => {
        if (typeof row !== 'object' || row === null || Array.isArray(row)) {
          warnings.push(`Row ${index + 1} is not an object and was skipped`);
          return;
        }
        const values = flatten(row as Record<string, unknown>);
        for (const key of Object.keys(values)) {
          if (!seenField.has(key)) {
            seenField.add(key);
            fields.push(key);
          }
        }
        records.push({ externalId: identify(values, index, opts.identityField), values });
      });

      return { records, fields, warnings };
    },
  };
}

/**
 * Flattens one level of nesting into dotted keys.
 *
 * Exports routinely wrap values (`{ title: { rendered: "..." } }`), and a
 * mapping screen cannot offer a field it cannot name. Arrays and deeper
 * objects are left whole — a list is a value, not a set of columns.
 */
function flatten(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
        out[`${key}.${inner}`] = innerValue;
      }
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Reads RFC 4180 CSV: comma-separated, `"` quoting, `""` for a literal quote,
 * and newlines allowed inside quotes.
 *
 * Hand-rolled rather than taking a dependency — the format is small, and the
 * parts that go wrong (quoted newlines, CRLF, a trailing empty line) are
 * exactly the parts a two-line `split(',')` gets wrong.
 */
export function createCsvImportSource(): ImportSource {
  return {
    id: 'csv',
    name: 'CSV',
    async read(payload, options): Promise<SourceReadResult> {
      if (tooLarge(payload)) throw new Error(`Payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
      const opts = (options ?? {}) as StructuredSourceOptions;
      const rows = parseCsv(payload);
      const header = rows.shift();
      if (!header || header.length === 0) throw new Error('CSV has no header row');

      const warnings: string[] = [];
      const fields = header.map((h, i) => {
        const name = h.trim();
        // An unnamed column cannot be mapped, so it gets a name that says where
        // it is rather than being dropped from the chooser.
        if (!name) warnings.push(`Column ${i + 1} has no header; named "column${i + 1}"`);
        return name || `column${i + 1}`;
      });

      const records: SourceRecord[] = [];
      rows.forEach((row, index) => {
        if (row.length === 1 && row[0] === '') return; // trailing newline
        if (row.length !== fields.length) {
          warnings.push(
            `Row ${index + 1} has ${row.length} value(s) for ${fields.length} column(s); missing ones are empty`,
          );
        }
        const values: Record<string, unknown> = {};
        fields.forEach((field, i) => {
          values[field] = row[i] ?? '';
        });
        records.push({ externalId: identify(values, index, opts.identityField), values });
      });

      return { records, fields, warnings };
    },
  };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      // CR is dropped outright: a CRLF file must not import every value with a
      // trailing carriage return.
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Every source this adapter provides, by id. */
export function structuredImportSources(): Record<string, ImportSource> {
  const json = createJsonImportSource();
  const csv = createCsvImportSource();
  const wxr = createWxrImportSource();
  return { [json.id]: json, [csv.id]: csv, [wxr.id]: wxr };
}
