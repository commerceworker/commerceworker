import { InMemoryObjectBucket } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  deletedKey,
  reconcileCopies,
  reconcileExtras,
  replicateDelete,
  replicateObject,
  SOURCE_ETAG,
  summarize,
} from '../src/commerce/object-replica';

const meta = { contentType: 'text/html', customMetadata: { kind: 'invoice' } };
const setup = () => {
  const primary = new InMemoryObjectBucket();
  const replica = new InMemoryObjectBucket();
  return { primary, replica };
};

describe('copying an object to the replica', () => {
  it('copies bytes, content type and metadata, and records the source etag', async () => {
    const { primary, replica } = setup();
    await primary.write('orders/o1/inv.html', 'body', meta);
    expect(await replicateObject(primary, replica, 'orders/o1/inv.html')).toBe('copied');
    const copy = await replica.head('orders/o1/inv.html');
    expect(copy).toMatchObject({ size: 4, contentType: 'text/html' });
    expect(copy?.customMetadata).toEqual({
      kind: 'invoice',
      [SOURCE_ETAG]: (await primary.head('orders/o1/inv.html'))!.etag,
    });
  });

  it('is idempotent: a replay finds the copy current and writes nothing', async () => {
    const { primary, replica } = setup();
    await primary.write('k', 'body', {});
    await replicateObject(primary, replica, 'k');
    const etag = (await replica.head('k'))!.etag;
    expect(await replicateObject(primary, replica, 'k')).toBe('current');
    expect((await replica.head('k'))!.etag).toBe(etag);
  });

  it('refreshes a copy whose source was overwritten', async () => {
    const { primary, replica } = setup();
    await primary.write('k', 'one', {});
    await replicateObject(primary, replica, 'k');
    await primary.write('k', 'two!', {});
    expect(await replicateObject(primary, replica, 'k')).toBe('copied');
    expect(replica.text('k')).toBe('two!');
  });

  it('does nothing for an object that is already gone, or a key it does not mirror', async () => {
    const { primary, replica } = setup();
    expect(await replicateObject(primary, replica, 'gone')).toBe('gone');
    await primary.write('health/x', 'x', {});
    expect(await replicateObject(primary, replica, 'health/x')).toBe('skipped');
    // A raw channel intake body holds buyer details and expires in days: never copied.
    await primary.write('intake/shopify/2026-01-01/x', 'x', {});
    expect(await replicateObject(primary, replica, 'intake/shopify/2026-01-01/x')).toBe('skipped');
    expect(await replica.head('intake/shopify/2026-01-01/x')).toBeNull();
    expect(replica.objects.size).toBe(0);
  });

  it('copies a locked key once and holds, rather than overwrite, one that differs', async () => {
    const { primary, replica } = setup();
    replica.lock('audit/');
    await primary.write('audit/2026/a.ndjson', 'a', {});
    expect(await replicateObject(primary, replica, 'audit/2026/a.ndjson')).toBe('copied');
    expect(await replicateObject(primary, replica, 'audit/2026/a.ndjson')).toBe('current');
    await primary.write('audit/2026/a.ndjson', 'changed', {});
    expect(await replicateObject(primary, replica, 'audit/2026/a.ndjson')).toBe('held');
    expect(replica.text('audit/2026/a.ndjson')).toBe('a');
  });
});

describe('a delete in the primary', () => {
  it('moves the copy to deleted/<date>/ with its metadata, and a replay finds it absent', async () => {
    const { primary, replica } = setup();
    await primary.write('orders/o1/inv.html', 'body', meta);
    await replicateObject(primary, replica, 'orders/o1/inv.html');
    await primary.remove('orders/o1/inv.html');
    expect(await replicateDelete(primary, replica, 'orders/o1/inv.html', '2026-11-12')).toBe(
      'moved',
    );
    expect(await replica.head('orders/o1/inv.html')).toBeNull();
    const moved = deletedKey('2026-11-12', 'orders/o1/inv.html');
    expect(moved).toBe('deleted/2026-11-12/orders/o1/inv.html');
    expect(replica.text(moved)).toBe('body');
    expect((await replica.head(moved))?.contentType).toBe('text/html');
    expect(await replicateDelete(primary, replica, 'orders/o1/inv.html', '2026-11-12')).toBe(
      'absent',
    );
  });

  it('leaves a key written again alone, so a late delete event cannot remove current data', async () => {
    const { primary, replica } = setup();
    await primary.write('k', 'new', {});
    await replicateObject(primary, replica, 'k');
    expect(await replicateDelete(primary, replica, 'k', '2026-11-12')).toBe('recreated');
    expect(replica.text('k')).toBe('new');
  });

  it('moves nothing under a lock, and never mirrors health/ or its own prefixes', async () => {
    const { primary, replica } = setup();
    replica.lock('audit/', 'plugins/');
    await primary.write('plugins/x/abc.json', '{}', {});
    await replicateObject(primary, replica, 'plugins/x/abc.json');
    await primary.remove('plugins/x/abc.json');
    expect(await replicateDelete(primary, replica, 'plugins/x/abc.json', '2026-11-12')).toBe(
      'locked',
    );
    expect(replica.text('plugins/x/abc.json')).toBe('{}');
    expect(await replicateDelete(primary, replica, 'deleted/2026-11-12/k', '2026-11-12')).toBe(
      'skipped',
    );
  });

  it('propagates a failure so the queue retries the event', async () => {
    const { primary, replica } = setup();
    replica.lock('orders/');
    await primary.write('orders/o/a', 'a', {});
    await replicateObject(primary, replica, 'orders/o/a');
    await primary.remove('orders/o/a');
    await expect(replicateDelete(primary, replica, 'orders/o/a', '2026-11-12')).rejects.toThrow(
      'locked',
    );
  });
});

describe('the nightly reconcile', () => {
  it('copies what is missing or stale, page by page, and flags extras without moving them', async () => {
    const { primary, replica } = setup();
    for (const k of ['orders/a', 'orders/b', 'orders/c', 'health/h']) await primary.write(k, k, {});
    await replicateObject(primary, replica, 'orders/a');
    await primary.write('orders/a', 'newer', {}); // stale
    await replica.write('orders/zz', 'orphan', {}); // an event that never moved it
    await replica.write('deleted/2026-11-01/old', 'x', {}); // the replica's own

    let cursor: string | undefined;
    let copied = 0;
    let scanned = 0;
    do {
      const page = await reconcileCopies(primary, replica, cursor, 2);
      copied += page.copied;
      scanned += page.scanned;
      cursor = page.cursor;
    } while (cursor);
    expect({ copied, scanned }).toEqual({ copied: 3, scanned: 3 });

    const found: string[] = [];
    let at: string | undefined;
    do {
      const page = await reconcileExtras(primary, replica, at, 2);
      found.push(...page.extras);
      at = page.cursor;
    } while (at);
    expect(found).toEqual(['orders/zz']);
    expect(replica.text('orders/zz')).toBe('orphan');
    expect(replica.text('orders/a')).toBe('newer');
  });

  it('reports a failed key and goes on with the page', async () => {
    const { primary, replica } = setup();
    replica.lock('orders/b'); // refuses a write over an existing copy
    await primary.write('orders/a', 'a', {});
    await primary.write('orders/b', 'b', {});
    await replica.write('orders/b', 'old', {});
    const page = await reconcileCopies(primary, replica, undefined);
    expect(page.copied).toBe(1);
    expect(page.failed).toEqual([{ key: 'orders/b', error: 'orders/b is locked' }]);
  });

  it('summarizes: clean, repaired, or needing attention', () => {
    const run = { date: '2026-11-12', startedAt: 't0', finishedAt: 't1' };
    const none = { scanned: 5, copied: 0, held: [], failed: [] };
    expect(summarize(run, none, { scanned: 5, keys: [] })).toMatchObject({
      outcome: 'clean',
      primary: 5,
      replica: 5,
    });
    expect(summarize(run, { ...none, copied: 2 }, { scanned: 5, keys: [] }).outcome).toBe(
      'repaired',
    );
    expect(summarize(run, none, { scanned: 6, keys: ['x'] })).toMatchObject({
      outcome: 'attention',
      extras: { count: 1, sample: ['x'] },
    });
  });
});
