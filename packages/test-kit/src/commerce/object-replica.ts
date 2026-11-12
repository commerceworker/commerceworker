/**
 * The object bucket port in memory: keys in a map, listed in key order, with an etag that is a
 * hash-free counter so a rewrite changes it. The contract in ./object-replica-contract.ts holds it
 * to the same behaviour as the R2 adapter. `lock` makes a prefix refuse an overwrite or a delete,
 * as a bucket lock does.
 */
import type {
  ObjectBucket,
  ObjectContent,
  ObjectInfo,
  ObjectWrite,
} from '@commerceworker/ports/commerce';

interface Held {
  bytes: Uint8Array;
  etag: string;
  contentType?: string;
  customMetadata?: Record<string, string>;
}

export class InMemoryObjectBucket implements ObjectBucket {
  readonly objects = new Map<string, Held>();
  private locked: string[] = [];
  private writes = 0;

  lock(...prefixes: string[]) {
    this.locked.push(...prefixes);
  }

  private info(key: string, o: Held): ObjectInfo {
    return {
      key,
      size: o.bytes.byteLength,
      etag: o.etag,
      ...(o.contentType ? { contentType: o.contentType } : {}),
      ...(o.customMetadata && Object.keys(o.customMetadata).length
        ? { customMetadata: o.customMetadata }
        : {}),
    };
  }

  async head(key: string) {
    const o = this.objects.get(key);
    return o ? this.info(key, o) : null;
  }

  async read(key: string): Promise<ObjectContent | null> {
    const o = this.objects.get(key);
    return o
      ? { ...this.info(key, o), body: new Response(o.bytes.slice()).body as ReadableStream }
      : null;
  }

  async write(key: string, body: ReadableStream | ArrayBuffer | string, meta: ObjectWrite) {
    if (this.objects.has(key) && this.locked.some((p) => key.startsWith(p)))
      throw new Error(`${key} is locked`);
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    this.objects.set(key, {
      bytes,
      etag: `etag-${++this.writes}`,
      ...(meta.contentType ? { contentType: meta.contentType } : {}),
      ...(meta.customMetadata ? { customMetadata: { ...meta.customMetadata } } : {}),
    });
  }

  async remove(key: string) {
    if (this.objects.has(key) && this.locked.some((p) => key.startsWith(p)))
      throw new Error(`${key} is locked`);
    this.objects.delete(key);
  }

  async list({
    prefix = '',
    cursor,
    limit = 1000,
  }: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }) {
    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix) && (cursor === undefined || k > cursor))
      .sort();
    const page = keys.slice(0, limit);
    return {
      objects: page.map((k) => this.info(k, this.objects.get(k)!)),
      ...(keys.length > page.length ? { cursor: page[page.length - 1] } : {}),
    };
  }

  /** Test helper: the text of a stored object. */
  text(key: string) {
    const o = this.objects.get(key);
    return o && new TextDecoder().decode(o.bytes);
  }
}
