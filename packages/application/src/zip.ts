/**
 * A streaming ZIP writer whose whole layout is known before a byte is read.
 *
 * Entries are stored (method 0, no compression): asset files are mostly already compressed
 * (images, video, PDF), deflating them costs CPU for little, and stored entries make every
 * offset a function of the files' sizes alone. So the archive's length, and which bytes of which
 * file land in each fixed-size part, are computed once ({@link planZip}); any part can then be
 * written on its own ({@link zipPartSegments}), with no more in memory than that part and nothing
 * carried between parts but a running CRC-32 (each entry's CRC goes in a data descriptor after its
 * bytes, general-purpose bit 3, and in the central directory at the end).
 *
 * Zip64 (APPNOTE 4.5) where a value outgrows 32 bits: an entry of 4 GiB or more carries a Zip64
 * extra field and an 8-byte-size data descriptor; an offset past 4 GiB goes in the central
 * directory's Zip64 extra; and an archive whose directory sits past 4 GiB, or that holds more than
 * 65,535 entries, ends with a Zip64 end-of-central-directory record and locator.
 */

const U32 = 0xffff_ffff;
const UTF8 = new TextEncoder();
/** General purpose flags: sizes and CRC follow the data (bit 3); names are UTF-8 (bit 11). */
const FLAGS = 0x0808;

/** One file in a planned archive. Plain JSON: a plan is a Workflow step's result. */
export interface ZipPlanEntry {
  readonly name: string;
  /** Where its bytes are (a blob key) and how many there are. */
  readonly key: string;
  readonly size: number;
  /** Where its local header starts in the archive. */
  readonly offset: number;
}

export interface ZipPlan {
  readonly entries: readonly ZipPlanEntry[];
  /** Where the central directory starts, and the archive's whole length. */
  readonly cdOffset: number;
  readonly length: number;
  /** MS-DOS time and date every entry carries. */
  readonly dosTime: number;
  readonly dosDate: number;
}

const nameBytes = (name: string) => UTF8.encode(name);
const isZip64 = (size: number) => size >= U32;
const localHeaderLength = (e: Pick<ZipPlanEntry, 'name' | 'size'>) =>
  30 + nameBytes(e.name).byteLength + (isZip64(e.size) ? 20 : 0);
const descriptorLength = (size: number) => (isZip64(size) ? 24 : 16);

/** The central directory record's Zip64 extra field, for the values that outgrow 32 bits. */
function cdExtraLength(e: ZipPlanEntry): number {
  const data = (isZip64(e.size) ? 16 : 0) + (e.offset >= U32 ? 8 : 0);
  return data > 0 ? 4 + data : 0;
}

const cdRecordLength = (e: ZipPlanEntry) => 46 + nameBytes(e.name).byteLength + cdExtraLength(e);

function needsZip64End(entries: number, cdOffset: number, cdLength: number): boolean {
  return entries > 0xffff || cdOffset >= U32 || cdLength >= U32;
}

/** MS-DOS date and time (local fields read as UTC; two-second resolution; 1980 at the earliest). */
export function dosDateTime(at: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    dosTime: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    dosDate: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

/**
 * Names unique within the archive: a second `photo.jpg` becomes `photo (2).jpg`. Separators,
 * traversal and control characters are replaced, so no entry extracts outside its folder.
 */
export function uniqueZipNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    let base = '';
    for (const ch of raw.replace(/[/\\]/g, '_')) {
      const code = ch.codePointAt(0) ?? 0;
      base += code < 0x20 || code === 0x7f ? '_' : ch;
    }
    base = base.replace(/^\.+$/, '_').slice(0, 200) || 'file';
    const dot = base.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** Lays out an archive of `files` (names already unique), in order. */
export function planZip(
  files: readonly { readonly name: string; readonly key: string; readonly size: number }[],
  at: Date,
): ZipPlan {
  let offset = 0;
  const entries: ZipPlanEntry[] = files.map((f) => {
    const entry = { name: f.name, key: f.key, size: f.size, offset };
    offset += localHeaderLength(f) + f.size + descriptorLength(f.size);
    return entry;
  });
  const cdOffset = offset;
  const cdLength = entries.reduce((n, e) => n + cdRecordLength(e), 0);
  const tail = needsZip64End(entries.length, cdOffset, cdLength) ? 56 + 20 + 22 : 22;
  return { entries, cdOffset, length: cdOffset + cdLength + tail, ...dosDateTime(at) };
}

class Writer {
  private readonly view: DataView;
  private at = 0;
  readonly bytes: Uint8Array;
  constructor(length: number) {
    this.bytes = new Uint8Array(length);
    this.view = new DataView(this.bytes.buffer);
  }
  u16(v: number) {
    this.view.setUint16(this.at, v, true);
    this.at += 2;
  }
  u32(v: number) {
    this.view.setUint32(this.at, v >>> 0, true);
    this.at += 4;
  }
  u64(v: number) {
    this.view.setBigUint64(this.at, BigInt(v), true);
    this.at += 8;
  }
  raw(b: Uint8Array) {
    this.bytes.set(b, this.at);
    this.at += b.byteLength;
  }
}

function localHeader(e: ZipPlanEntry, plan: ZipPlan): Uint8Array {
  const name = nameBytes(e.name);
  const zip64 = isZip64(e.size);
  const w = new Writer(localHeaderLength(e));
  w.u32(0x04034b50);
  w.u16(zip64 ? 45 : 20);
  w.u16(FLAGS);
  w.u16(0); // stored
  w.u16(plan.dosTime);
  w.u16(plan.dosDate);
  // CRC and sizes follow the data (bit 3); a Zip64 entry says so with 0xFFFFFFFF and an extra.
  w.u32(0);
  w.u32(zip64 ? U32 : 0);
  w.u32(zip64 ? U32 : 0);
  w.u16(name.byteLength);
  w.u16(zip64 ? 20 : 0);
  w.raw(name);
  if (zip64) {
    w.u16(0x0001);
    w.u16(16);
    w.u64(0);
    w.u64(0);
  }
  return w.bytes;
}

function descriptor(e: ZipPlanEntry, crc: number): Uint8Array {
  const w = new Writer(descriptorLength(e.size));
  w.u32(0x08074b50);
  w.u32(crc);
  if (isZip64(e.size)) {
    w.u64(e.size);
    w.u64(e.size);
  } else {
    w.u32(e.size);
    w.u32(e.size);
  }
  return w.bytes;
}

function centralDirectory(plan: ZipPlan, crcs: ReadonlyMap<number, number>): Uint8Array {
  const cdLength = plan.entries.reduce((n, e) => n + cdRecordLength(e), 0);
  const zip64End = needsZip64End(plan.entries.length, plan.cdOffset, cdLength);
  const w = new Writer(plan.length - plan.cdOffset);
  plan.entries.forEach((e, i) => {
    const crc = crcs.get(i);
    if (crc === undefined) throw new Error(`zip entry ${i} has no CRC yet`);
    const name = nameBytes(e.name);
    const bigSize = isZip64(e.size);
    const bigOffset = e.offset >= U32;
    w.u32(0x02014b50);
    w.u16(45); // made by: 4.5, MS-DOS attributes
    w.u16(bigSize || bigOffset ? 45 : 20);
    w.u16(FLAGS);
    w.u16(0);
    w.u16(plan.dosTime);
    w.u16(plan.dosDate);
    w.u32(crc);
    w.u32(bigSize ? U32 : e.size);
    w.u32(bigSize ? U32 : e.size);
    w.u16(name.byteLength);
    w.u16(cdExtraLength(e));
    w.u16(0); // comment
    w.u16(0); // disk
    w.u16(0); // internal attributes
    w.u32(0); // external attributes
    w.u32(bigOffset ? U32 : e.offset);
    w.raw(name);
    if (cdExtraLength(e) > 0) {
      w.u16(0x0001);
      w.u16(cdExtraLength(e) - 4);
      if (bigSize) {
        w.u64(e.size);
        w.u64(e.size);
      }
      if (bigOffset) w.u64(e.offset);
    }
  });
  const count = plan.entries.length;
  if (zip64End) {
    const recordAt = plan.cdOffset + cdLength;
    w.u32(0x06064b50);
    w.u64(44); // size of the record after this field
    w.u16(45);
    w.u16(45);
    w.u32(0);
    w.u32(0);
    w.u64(count);
    w.u64(count);
    w.u64(cdLength);
    w.u64(plan.cdOffset);
    w.u32(0x07064b50);
    w.u32(0);
    w.u64(recordAt);
    w.u32(1);
  }
  w.u32(0x06054b50);
  w.u16(0);
  w.u16(0);
  w.u16(zip64End ? 0xffff : count);
  w.u16(zip64End ? 0xffff : count);
  w.u32(zip64End ? U32 : cdLength);
  w.u32(zip64End ? U32 : plan.cdOffset);
  w.u16(0); // comment
  return w.bytes;
}

/**
 * A run of an archive's bytes: literal bytes (a local header), a slice of one entry's file, or a
 * slice of a data descriptor or of the central directory, which need CRCs the file slices before
 * them produce ({@link zipDescriptorBytes}, {@link zipDirectoryBytes}).
 */
export type ZipSegment =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | {
      readonly kind: 'file' | 'descriptor';
      readonly entry: number;
      /** Offset in the file (or the descriptor) and how many of its bytes. */
      readonly from: number;
      readonly length: number;
    }
  | { readonly kind: 'directory'; readonly from: number; readonly length: number };

/** The segments that make up `[start, end)` of the archive, in order. */
export function zipPartSegments(plan: ZipPlan, start: number, end: number): ZipSegment[] {
  const out: ZipSegment[] = [];
  const take = (at: number, length: number, make: (from: number, to: number) => ZipSegment) => {
    const from = Math.max(start, at);
    const to = Math.min(end, at + length);
    if (from < to) out.push(make(from - at, to - at));
  };
  plan.entries.forEach((e, i) => {
    const entryEnd = e.offset + localHeaderLength(e) + e.size + descriptorLength(e.size);
    if (entryEnd <= start || e.offset >= end) return;
    const header = localHeader(e, plan);
    take(e.offset, header.byteLength, (f, t) => ({ kind: 'bytes', bytes: header.subarray(f, t) }));
    const dataAt = e.offset + header.byteLength;
    take(dataAt, e.size, (f, t) => ({ kind: 'file', entry: i, from: f, length: t - f }));
    take(dataAt + e.size, descriptorLength(e.size), (f, t) => ({
      kind: 'descriptor',
      entry: i,
      from: f,
      length: t - f,
    }));
  });
  take(plan.cdOffset, plan.length - plan.cdOffset, (f, t) => ({
    kind: 'directory',
    from: f,
    length: t - f,
  }));
  return out;
}

/** Entry `entry`'s data descriptor, once its CRC is known. */
export function zipDescriptorBytes(plan: ZipPlan, entry: number, crc: number): Uint8Array {
  const e = plan.entries[entry];
  if (!e) throw new Error(`zip entry ${entry} is not in the plan`);
  return descriptor(e, crc);
}

/** The central directory and end records, once every entry's CRC is known. */
export function zipDirectoryBytes(plan: ZipPlan, crcs: ReadonlyMap<number, number>): Uint8Array {
  return centralDirectory(plan, crcs);
}

let table: Uint32Array | undefined;
function crcTable(): Uint32Array {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/** CRC-32 (IEEE), resumable: `update(bytes, previous)` continues from a finished value. */
export const Crc32 = {
  update(bytes: Uint8Array, previous = 0): number {
    const t = crcTable();
    let c = (previous ^ U32) >>> 0;
    for (let i = 0; i < bytes.length; i++) {
      c = (t[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
    }
    return (c ^ U32) >>> 0;
  },
};
