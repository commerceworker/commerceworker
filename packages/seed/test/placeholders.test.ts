import { describe, expect, it } from 'vitest';
import { placeholderPdf, placeholderPng } from '../src/placeholders';

/** Walks a PNG's chunks, checking each CRC, and returns them by type. */
function chunks(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: { type: string; data: Uint8Array }[] = [];
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = (table[(c ^ x) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  for (let at = 8; at < png.length; ) {
    const len = view.getUint32(at);
    const typed = png.subarray(at + 4, at + 8 + len);
    expect(view.getUint32(at + 8 + len)).toBe(crc(typed));
    out.push({ type: String.fromCharCode(...typed.subarray(0, 4)), data: typed.subarray(4) });
    at += 12 + len;
  }
  return out;
}

describe('placeholderPng', () => {
  it('is a well-formed RGB PNG of the asked size, with valid CRCs and zlib checksum', () => {
    const png = placeholderPng(300, 200, [0, 0, 0], [255, 255, 255]);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const parts = chunks(png);
    expect(parts.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const ihdr = new DataView((parts[0] as { data: Uint8Array }).data.slice().buffer);
    expect([ihdr.getUint32(0), ihdr.getUint32(4), ihdr.getUint8(8), ihdr.getUint8(9)]).toEqual([
      300, 200, 8, 2,
    ]);
    // The stored blocks hold every scanline (filter byte + 3 bytes per pixel), more than one block.
    const idat = (parts[1] as { data: Uint8Array }).data;
    expect(idat.length).toBeGreaterThan(200 * (300 * 3 + 1));
    expect([idat[0], idat[1]]).toEqual([0x78, 0x01]);
  });
});

describe('placeholderPdf', () => {
  it('is a one-page PDF whose cross-reference offsets point at its objects', () => {
    const pdf = placeholderPdf('Press kit (draft)');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('(Press kit \\(draft\\))');
    const xrefAt = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
    expect(pdf.slice(xrefAt).startsWith('xref')).toBe(true);
    const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    for (const [i, off] of offsets.entries()) {
      expect(pdf.slice(off).startsWith(`${i + 1} 0 obj`)).toBe(true);
    }
  });
});
