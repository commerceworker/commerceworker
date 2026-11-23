import { describe, expect, it } from 'vitest';
import { csvCell, csvColumns, csvLine, csvRecords } from '../src/csv';

const streamOf = (text: string) =>
  new Blob([text]).stream() as unknown as ReadableStream<Uint8Array>;

async function read(text: string) {
  const out: string[][] = [];
  for await (const r of csvRecords(streamOf(text))) out.push(r.record);
  return out;
}

describe('writing CSV', () => {
  it('quotes a cell with a comma, quote or line break, doubling its quotes', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(12.5)).toBe('12.5');
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell(true)).toBe('true');
  });

  it('keeps a cell a spreadsheet would run as a formula as text', () => {
    for (const formula of ['=HYPERLINK("x")', '+1+1', '-2+3', '@SUM(A1)', '\tx', '\rx'])
      expect(csvCell(formula).replace(/^"/, '')).toMatch(/^'/);
    expect(csvCell('=1,2')).toBe(`"'=1,2"`);
  });

  it('reads back what it wrote, line breaks and quotes included', async () => {
    const rows = [
      ['name', 'note'],
      ['Ada, Ltd', 'said "yes"\r\non two lines'],
      ['', 'last'],
    ];
    expect(await read(rows.map(csvLine).join(''))).toEqual(rows);
  });
});

describe('reading a header', () => {
  it('maps known columns without regard to case or spaces, in any order', () => {
    const h = csvColumns([' Email ', 'name', 'TIER'], ['name', 'email'], ['tier', 'id']);
    expect(h).toEqual({
      ok: true,
      columns: new Map([
        ['email', 0],
        ['name', 1],
        ['tier', 2],
      ]),
    });
  });

  it('refuses a missing, unknown or doubled column, naming it', () => {
    expect(csvColumns(['name'], ['name', 'email'])).toEqual({
      ok: false,
      error: 'Missing the column email.',
    });
    expect(csvColumns(['name', 'email', 'emial'], ['name', 'email'])).toMatchObject({
      ok: false,
      error: expect.stringContaining('Unknown column "emial"'),
    });
    expect(csvColumns(['name', 'Name', 'email'], ['name', 'email'])).toEqual({
      ok: false,
      error: 'The column "name" appears twice.',
    });
  });

  it('ignores a blank header cell, as a trailing comma leaves', () => {
    expect(csvColumns(['name', 'email', ''], ['name', 'email'])).toMatchObject({ ok: true });
  });
});
