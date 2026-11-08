/**
 * Placeholder files for the demo assets, generated in code so the repo carries no binary fixtures
 * and the seed needs no dependencies: a real PNG (so the media library shows it and image
 * transforms can resize it) and a minimal one-page PDF.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A zlib stream of stored (uncompressed) deflate blocks: valid, and needs no compressor. */
function zlibStored(data: Uint8Array): Uint8Array {
  const MAX = 65535;
  const parts: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  const blocks = Math.max(1, Math.ceil(data.length / MAX));
  for (let i = 0; i < blocks; i++) {
    const block = data.subarray(i * MAX, (i + 1) * MAX);
    const len = block.length;
    const last = i === blocks - 1 ? 1 : 0;
    parts.push(Uint8Array.of(last, len & 0xff, len >>> 8, ~len & 0xff, (~len >>> 8) & 0xff), block);
  }
  parts.push(Uint8Array.from(u32(adler32(data))));
  return concat(parts);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typed = concat([Uint8Array.from(type, (c) => c.charCodeAt(0)), data]);
  return concat([Uint8Array.from(u32(data.length)), typed, Uint8Array.from(u32(crc32(typed)))]);
}

type Rgb = readonly [number, number, number];

/**
 * A `width`×`height` RGB PNG: a diagonal gradient from `from` to `to`, so each demo image is
 * recognisably its own.
 */
export function placeholderPng(width: number, height: number, from: Rgb, to: Rgb): Uint8Array {
  const row = width * 3 + 1;
  const raw = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const t = (x / Math.max(1, width - 1) + y / Math.max(1, height - 1)) / 2;
      const at = y * row + 1 + x * 3;
      for (let c = 0; c < 3; c++) {
        raw[at + c] = Math.round(
          (from[c] as number) + ((to[c] as number) - (from[c] as number)) * t,
        );
      }
    }
  }
  const header = Uint8Array.from([...u32(width), ...u32(height), 8, 2, 0, 0, 0]);
  return concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', header),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** A one-page PDF that says `title`. ASCII only (anything else becomes `?`). */
export function placeholderPdf(title: string): string {
  const safe = title.replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = `BT /F1 24 Tf 72 720 Td (${safe}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}
