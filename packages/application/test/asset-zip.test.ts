import { crc32 } from 'node:zlib';
import { ConflictError, NotFoundError, ValidationError } from '@commerceworker/domain';
import {
  FakeAssetZipStarter,
  FakeBlobStore,
  FakeWorkflowSteps,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  addToAssetCollection,
  Crc32,
  consumeEvent,
  createAsset,
  createAssetCollection,
  createSpace,
  getAssetZip,
  MAX_ACTIVE_ZIPS,
  planZip,
  requestAssetZip,
  runAssetZip,
  sweepExpiredZips,
  uniqueZipNames,
  zipDirectoryBytes,
  zipObjectKey,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

/** A minimal ZIP reader: every entry's name, flags, sizes, CRC and bytes, from the directory. */
function readZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.byteLength - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const entries: { name: string; crc: number; size: number; flags: number; data: Uint8Array }[] =
    [];
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    expect(method).toBe(0);
    // The local header, then the bytes, then the data descriptor repeating the CRC and sizes.
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(dataAt, dataAt + size);
    expect(view.getUint32(dataAt + size, true)).toBe(0x08074b50);
    expect(view.getUint32(dataAt + size + 4, true)).toBe(crc);
    expect(view.getUint32(dataAt + size + 8, true)).toBe(size);
    entries.push({ name, crc, size, flags, data });
    at += 46 + nameLength + extra;
  }
  return entries;
}

const bytesOf = (text: string) => new TextEncoder().encode(text);

describe('zip downloads', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;
  let blob: FakeBlobStore;
  let clock: FixedClock;
  const upload = async (fileName: string, body?: Uint8Array) => {
    const { asset } = await createAsset(ctx, blob, scope, { fileName, contentType: 'image/png' });
    if (body) await blob.put(asset.r2Key ?? '', body, 'image/png');
    return asset;
  };
  const build = async (jobId: string, partBytes?: number, steps = new FakeWorkflowSteps(clock)) =>
    steps.run(() =>
      runAssetZip(steps, ctx, blob, { scope, jobId }, partBytes ? { partBytes } : {}),
    );

  beforeEach(async () => {
    store = new InMemoryContentStore();
    blob = new FakeBlobStore();
    clock = new FixedClock();
    ctx = { store, clock, ids: new SequenceIdGenerator('z') };
    await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('builds a valid archive of the selection, parts split mid-file, CRCs carried over', async () => {
    // Files long enough that 64-byte parts split them, and one empty file.
    const a = await upload('a.png', bytesOf('A'.repeat(150)));
    const b = await upload('b.png', bytesOf('the quick brown fox '.repeat(9)));
    const empty = await upload('empty.png', new Uint8Array(0));
    const job = await requestAssetZip(ctx, scope, {
      assetIds: [a.id, b.id, empty.id],
      name: 'Pick',
    });
    expect(job).toMatchObject({ status: 'pending', fileName: 'Pick.zip' });
    expect(store.allEvents().at(-1)).toMatchObject({ type: 'asset_zip.requested', jobId: job.id });

    const outcome = await build(job.id, 64);
    expect(outcome).toMatchObject({ status: 'complete', value: { status: 'completed' } });
    const done = await getAssetZip(ctx, blob, scope, job.id);
    expect(done).toMatchObject({ status: 'completed', fileCount: 3 });
    expect(done.partsDone).toBe(done.partCount);
    expect(done.partCount).toBeGreaterThan(4);
    expect(done.downloadUrl).toContain(zipObjectKey(scope, job));

    const archive = blob.bytes(zipObjectKey(scope, job));
    expect(archive?.byteLength).toBe(done.totalBytes);
    const entries = readZip(archive as Uint8Array);
    expect(entries.map((e) => e.name)).toEqual(['a.png', 'b.png', 'empty.png']);
    for (const e of entries) {
      // Our CRC agrees with zlib's over the very bytes that landed in the archive.
      expect(e.crc).toBe(crc32(e.data));
      expect(e.flags & 0x0008).toBe(0x0008);
    }
    expect(new TextDecoder().decode(entries[1]?.data)).toBe('the quick brown fox '.repeat(9));
    // Ranged reads only, each a part's slice: never a whole file into memory.
    expect(blob.rangesRead.every((r) => Number(r.split('+')[1]) <= 64)).toBe(true);
  });

  it('replays to the same archive after a crash between parts', async () => {
    const a = await upload('a.png', bytesOf('x'.repeat(200)));
    const job = await requestAssetZip(ctx, scope, { assetIds: [a.id] });
    const steps = new FakeWorkflowSteps(clock);
    const first = await build(job.id, 64, steps);
    // The same instance again (a replay): every finished step comes from the journal.
    const executed = steps.executed.length;
    const again = await build(job.id, 64, steps);
    expect(again).toEqual(first);
    expect(steps.executed.length).toBe(executed);
    expect(readZip(blob.bytes(zipObjectKey(scope, job)) as Uint8Array)[0]?.size).toBe(200);
  });

  it('keeps the plan out of step state, however long the names, and removes it once built', async () => {
    const long = `${'é'.repeat(190)}.png`;
    const assets = [];
    for (let i = 0; i < 40; i++) assets.push(await upload(long, bytesOf(`f${i}`)));
    const job = await requestAssetZip(ctx, scope, { assetIds: assets.map((x) => x.id) });
    const steps = new FakeWorkflowSteps(clock);
    await build(job.id, 64, steps);
    const plan = steps.journal.get('plan');
    // The step's result is the plan's size only: a thousand such names would pass 1 MiB.
    expect(plan).toMatchObject({ ok: true, value: { ok: { files: 40 } } });
    expect(JSON.stringify(plan).length).toBeLessThan(200);
    expect(blob.keys().some((k) => k.endsWith('/plan.json'))).toBe(false);
    expect(readZip(blob.bytes(zipObjectKey(scope, job)) as Uint8Array)).toHaveLength(40);
  });

  it('zips a collection in its order, and names repeated file names apart', async () => {
    const one = await upload('logo.png', bytesOf('one'));
    const two = await upload('logo.png', bytesOf('two'));
    const c = await createAssetCollection(ctx, scope, { name: 'Brand kit' });
    await addToAssetCollection(ctx, scope, c.id, [two.id, one.id]);
    const job = await requestAssetZip(ctx, scope, { collectionId: c.id });
    expect(job.fileName).toBe('Brand kit.zip');
    await build(job.id);
    const entries = readZip(blob.bytes(zipObjectKey(scope, job)) as Uint8Array);
    expect(entries.map((e) => [e.name, new TextDecoder().decode(e.data)])).toEqual([
      ['logo.png', 'two'],
      ['logo (2).png', 'one'],
    ]);
  });

  it('fails the job, with a reason, when nothing has bytes or a file changes meanwhile', async () => {
    const ghost = await upload('never-uploaded.png');
    const job = await requestAssetZip(ctx, scope, { assetIds: [ghost.id] });
    expect(await build(job.id)).toMatchObject({ value: { status: 'failed' } });
    expect(await getAssetZip(ctx, blob, scope, job.id)).toMatchObject({
      status: 'failed',
      error: 'None of the selected assets has a file to zip',
    });

    const a = await upload('a.png', bytesOf('y'.repeat(100)));
    const changing = await requestAssetZip(ctx, scope, { assetIds: [a.id] });
    // Planned at 100 bytes; the file is replaced under the same key once the parts are read.
    const original = blob.openRange.bind(blob);
    blob.openRange = async (key, offset, length) => {
      await blob.put(key, bytesOf('short'), 'image/png');
      return original(key, offset, length);
    };
    expect(await build(changing.id)).toMatchObject({ value: { status: 'failed' } });
    expect((await getAssetZip(ctx, blob, scope, changing.id)).error).toMatch(/changed/);
    // The upload it started was discarded.
    expect(blob.aborted).toHaveLength(1);
    expect(blob.uploadsInProgress.size).toBe(0);
  });

  it('refuses an empty selection, both sources, and an unknown or empty collection', async () => {
    await expect(requestAssetZip(ctx, scope, { assetIds: [] })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      requestAssetZip(ctx, scope, { assetIds: ['a'], collectionId: 'c' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(requestAssetZip(ctx, scope, { collectionId: 'nope' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const empty = await createAssetCollection(ctx, scope, { name: 'Empty' });
    await expect(requestAssetZip(ctx, scope, { collectionId: empty.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('starts one Workflow per job from its event, even redelivered; fails it with none bound', async () => {
    const a = await upload('a.png', bytesOf('a'));
    const job = await requestAssetZip(ctx, scope, { assetIds: [a.id] });
    const event = store.allEvents().at(-1);
    if (event?.type !== 'asset_zip.requested') throw new Error('no event');
    const starter = new FakeAssetZipStarter();
    const deps = { sender: { send: async () => ({ ok: true, status: 200 }) }, assetZip: starter };
    await consumeEvent(ctx, deps as never, event);
    await consumeEvent(ctx, deps as never, event);
    expect(starter.started).toEqual([{ scope, jobId: job.id }]);

    const other = await requestAssetZip(ctx, scope, { assetIds: [a.id] });
    const second = store.allEvents().at(-1);
    if (second?.type !== 'asset_zip.requested') throw new Error('no event');
    await consumeEvent(ctx, { sender: deps.sender } as never, second);
    expect((await getAssetZip(ctx, blob, scope, other.id)).status).toBe('failed');
  });

  it('completes on a retried complete step whose upload had already been assembled', async () => {
    const a = await upload('a.png', bytesOf('z'.repeat(50)));
    const job = await requestAssetZip(ctx, scope, { assetIds: [a.id] });
    // The first write of `completed` fails after R2 assembled the archive: the step retries, R2 no
    // longer has the upload, and the archive found at its planned length counts as done.
    const update = store.assetZips.update.bind(store.assetZips);
    let failed = false;
    store.assetZips.update = async (sc, id, patch) => {
      if (patch.status === 'completed' && !failed) {
        failed = true;
        throw new Error('D1 blip');
      }
      return update(sc, id, patch);
    };
    expect(await build(job.id)).toMatchObject({ value: { status: 'completed' } });
    expect((await getAssetZip(ctx, blob, scope, job.id)).status).toBe('completed');
  });

  it('builds at most three zips at once per environment', async () => {
    const a = await upload('a.png', bytesOf('a'));
    for (let i = 0; i < MAX_ACTIVE_ZIPS; i++)
      await requestAssetZip(ctx, scope, { assetIds: [a.id] });
    await expect(requestAssetZip(ctx, scope, { assetIds: [a.id] })).rejects.toBeInstanceOf(
      ConflictError,
    );
    // One finishing frees a slot.
    const [first] = await store.assetZips.list(scope, 10);
    await store.assetZips.update(scope, first?.id ?? '', { status: 'completed' });
    await expect(requestAssetZip(ctx, scope, { assetIds: [a.id] })).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('sweeps archives a day old: the object and the job', async () => {
    const a = await upload('a.png', bytesOf('a'));
    const job = await requestAssetZip(ctx, scope, { assetIds: [a.id] });
    await build(job.id);
    expect(blob.keys()).toContain(zipObjectKey(scope, job));
    expect(await sweepExpiredZips(ctx, blob)).toEqual({ removed: 0, failed: 0 });
    clock.advance(24 * 60 * 60 * 1000 + 1);
    // Past expiry, no download URL is handed out even before the sweep runs.
    expect((await getAssetZip(ctx, blob, scope, job.id)).downloadUrl).toBeUndefined();
    expect(await sweepExpiredZips(ctx, blob)).toEqual({ removed: 1, failed: 0 });
    expect(blob.keys()).not.toContain(zipObjectKey(scope, job));
    await expect(getAssetZip(ctx, blob, scope, job.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('zip format', () => {
  it('computes CRC-32 as zlib does, resumable across chunks', () => {
    const data = bytesOf('The quick brown fox jumps over the lazy dog');
    expect(Crc32.update(data)).toBe(crc32(data));
    const split = Crc32.update(data.subarray(10), Crc32.update(data.subarray(0, 10)));
    expect(split).toBe(crc32(data));
  });

  it('names entries apart and never lets one escape its folder', () => {
    expect(uniqueZipNames(['a.png', 'A.png', '../x', 'a.png', '..', 'b'])).toEqual([
      'a.png',
      'A (2).png',
      '.._x',
      'a (3).png',
      '_',
      'b',
    ]);
  });

  it('writes Zip64 records for a file past 4 GiB and offsets past it', () => {
    const big = 5 * 1024 ** 3;
    const plan = planZip(
      [
        { name: 'big.mov', key: 'k1', size: big },
        { name: 'after.txt', key: 'k2', size: 10 },
      ],
      new Date('2026-01-01T00:00:00Z'),
    );
    const second = plan.entries[1];
    expect(second?.offset).toBeGreaterThan(0xffff_ffff);
    const tail = zipDirectoryBytes(
      plan,
      new Map([
        [0, 1],
        [1, 2],
      ]),
    );
    const view = new DataView(tail.buffer);
    // First record: sizes 0xFFFFFFFF with a Zip64 extra carrying them.
    expect(view.getUint32(20, true)).toBe(0xffff_ffff);
    expect(view.getUint16(46 + 7, true)).toBe(0x0001);
    expect(Number(view.getBigUint64(46 + 7 + 4, true))).toBe(big);
    // The end: a Zip64 end record and locator, then the classic record pointing at them.
    const end = tail.byteLength - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint32(end + 16, true)).toBe(0xffff_ffff);
    expect(view.getUint32(end - 20, true)).toBe(0x07064b50);
    expect(view.getUint32(end - 20 - 56, true)).toBe(0x06064b50);
    expect(Number(view.getBigUint64(end - 20 - 56 + 48, true))).toBe(plan.cdOffset);
    expect(plan.length).toBe(plan.cdOffset + tail.byteLength);
  });
});
