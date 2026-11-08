import type { AssetFolder } from '@commerceworker/domain';
import { describe, expect, it } from 'vitest';
import {
  ASSET_BULK_JOB_THRESHOLD,
  activeFilterCount,
  addedSummary,
  allPages,
  assetLibraryQuery,
  assetSearchQuery,
  chunked,
  facetChips,
  fileSize,
  folderLabel,
  folderRows,
  ingestState,
  isoToLocalInput,
  localInputToIso,
  movedAnnouncement,
  moveItem,
  RIGHTS_EXPIRE_SOON_MS,
  rightsState,
  runBulk,
  runsAsJob,
  shareExpiresAt,
  timeUntil,
  zipPercent,
  zipRunning,
  zipSummary,
} from '~/cms/lib/assets';
import { bulkSummary, jobFailures } from '~/cms/lib/bulk-jobs';
import type { AssetZip } from '~/cms/lib/management';

const folder = (id: string, name: string, path: string, parentId?: string): AssetFolder => ({
  id,
  name,
  path,
  ...(parentId ? { parentId } : {}),
  createdAt: '',
  updatedAt: '',
});

describe('the asset library query', () => {
  it('names the folder and the filters, and nothing it was not asked for', () => {
    expect(assetLibraryQuery({ kind: 'all' }, {})).toEqual({ limit: 50 });
    expect(assetLibraryQuery({ kind: 'root' }, { kind: 'image' })).toEqual({
      limit: 50,
      folder: 'root',
      kind: 'image',
    });
    expect(
      assetLibraryQuery(
        { kind: 'folder', id: 'f1' },
        { status: 'archived', tag: 't1', sort: 'size-asc' },
      ),
    ).toEqual({
      limit: 50,
      folder: 'f1',
      status: 'archived',
      tag: 't1',
      sort: 'size',
      order: 'asc',
    });
  });

  it('counts the filters but not the sort', () => {
    expect(activeFilterCount({ sort: 'size-desc' })).toBe(0);
    expect(activeFilterCount({ kind: 'video', tag: 't' })).toBe(2);
  });
});

describe('the folder tree', () => {
  const folders = [
    folder('b', 'Brand', '/b/'),
    folder('l', 'Logos', '/b/l/', 'b'),
    folder('a', 'Archive 2024', '/a/'),
    folder('i', 'Icons', '/b/i/', 'b'),
  ];

  it('nests children under their parent, siblings by name', () => {
    expect(folderRows(folders).map((r) => `${r.depth}:${r.folder.name}`)).toEqual([
      '0:Archive 2024',
      '0:Brand',
      '1:Icons',
      '1:Logos',
    ]);
  });

  it('labels a folder with its ancestors', () => {
    expect(folderLabel(folders[1] as AssetFolder, folders)).toBe('Brand / Logos');
  });
});

describe('bulk actions', () => {
  it('runs every one, counting failures without stopping', async () => {
    const outcome = await runBulk(['a', 'b', 'c'], async (id) => {
      if (id === 'b') throw new Error('nope');
    });
    expect(outcome).toEqual({ done: 2, failed: 1, failures: [{ id: 'b', error: 'nope' }] });
    expect(bulkSummary('Published', outcome)).toBe('Published 2 of 3 assets; 1 failed');
    expect(bulkSummary('Archived', { done: 1, failed: 0 })).toBe('Archived 1 asset');
  });
});

describe('file sizes', () => {
  it('reads like a person would say them', () => {
    expect(fileSize(undefined)).toBe('—');
    expect(fileSize(512)).toBe('512 B');
    expect(fileSize(1536)).toBe('1.5 KB');
    expect(fileSize(25 * 1024 * 1024)).toBe('25 MB');
  });
});

describe('asset search', () => {
  it('searches what the folder and filter bar say, relevance first (no sort)', () => {
    expect(
      assetSearchQuery(
        'mug',
        { kind: 'folder', id: 'f1' },
        {
          kind: 'image',
          status: 'all',
          tag: 't1',
          sort: 'size-desc',
        },
      ),
    ).toEqual({ q: 'mug', limit: 100, folder: 'f1', kind: 'image', status: 'all', tag: 't1' });
    expect(assetSearchQuery('mug', { kind: 'root' }, {})).toEqual({
      q: 'mug',
      limit: 100,
      folder: 'root',
    });
  });

  it('names facet chips, most matches first, leaving out tags and folders it can’t name', () => {
    const chips = facetChips(
      { kind: { image: 1, document: 3 }, tag: { t1: 2, gone: 5 }, folder: { root: 1, f1: 4 } },
      [{ id: 't1', name: 'Hero' }],
      [folder('f1', 'Brand', '/f1/')],
    );
    expect(chips.kind.map((c) => [c.label, c.count])).toEqual([
      ['Documents', 3],
      ['Images', 1],
    ]);
    expect(chips.tag.map((c) => c.label)).toEqual(['Hero']);
    expect(chips.folder.map((c) => [c.value, c.label])).toEqual([
      ['f1', 'Brand'],
      ['root', 'Not in a folder'],
    ]);
  });

  it('says processing for pending and running ingest, failed with why, and nothing when done', () => {
    expect(ingestState({ ingestStatus: 'pending' })).toEqual({ state: 'processing' });
    expect(ingestState({ ingestStatus: 'processing' })).toEqual({ state: 'processing' });
    expect(ingestState({ ingestStatus: 'error', ingestError: 'boom' })).toEqual({
      state: 'failed',
      error: 'boom',
    });
    expect(ingestState({ ingestStatus: 'ready' })).toBeNull();
    expect(ingestState({})).toBeNull();
  });
});

describe('usage rights at a glance', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const at = (ms: number) => new Date(ms).toISOString();

  it('says expired, expiring within a week, embargoed, or nothing', () => {
    expect(rightsState(undefined, now)).toBeNull();
    expect(rightsState({ license: 'CC BY' }, now)).toBeNull();
    expect(rightsState({ expiresAt: at(now - 1) }, now)).toEqual({
      state: 'expired',
      at: at(now - 1),
    });
    expect(rightsState({ expiresAt: at(now + 3 * day) }, now)?.state).toBe('expiring');
    expect(rightsState({ expiresAt: at(now + RIGHTS_EXPIRE_SOON_MS) }, now)?.state).toBe(
      'expiring',
    );
    expect(rightsState({ expiresAt: at(now + RIGHTS_EXPIRE_SOON_MS + 1) }, now)).toBeNull();
    expect(rightsState({ embargoUntil: at(now + day) }, now)?.state).toBe('embargoed');
    expect(rightsState({ embargoUntil: at(now - day) }, now)).toBeNull();
    // Expired wins: an expired asset can't be delivered whatever its embargo says.
    expect(rightsState({ embargoUntil: at(now + day), expiresAt: at(now - day) }, now)?.state).toBe(
      'expired',
    );
  });

  it('says how long is left in words', () => {
    expect(timeUntil(now + 3 * day, now)).toBe('in 3 days');
    expect(timeUntil(now + 5 * 60 * 60 * 1000, now)).toBe('in 5 hours');
    expect(timeUntil(now + 60 * 60 * 1000, now)).toBe('in 1 hour');
    expect(timeUntil(now + 20 * 60 * 1000, now)).toBe('in 20 minutes');
    expect(timeUntil(now + 1000, now)).toBe('in 1 minute');
  });

  it('turns a date and time on the reader’s clock into an instant with a zone, and back', () => {
    expect(localInputToIso('')).toBeNull();
    const iso = localInputToIso('2026-01-31T09:30');
    expect(iso).toMatch(/^2026-01-3\dT\d{2}:30:00\.000Z$/);
    expect(isoToLocalInput(iso ?? undefined)).toBe('2026-01-31T09:30');
    expect(isoToLocalInput(undefined)).toBe('');
    expect(isoToLocalInput('not a date')).toBe('');
  });
});

describe('asset bulk jobs', () => {
  it('runs a selection bigger than one page as a job', () => {
    expect(runsAsJob(ASSET_BULK_JOB_THRESHOLD)).toBe(false);
    expect(runsAsJob(ASSET_BULK_JOB_THRESHOLD + 1)).toBe(true);
  });

  it('names a job’s failures by the asset name the report gives, else the id', () => {
    expect(
      jobFailures({
        job: {} as never,
        chunks: [
          {
            chunkId: 'c1',
            status: 'completed',
            attempts: 1,
            itemCount: 2,
            failures: [{ id: 'a1', error: 'embargoed', name: 'hero.jpg' }],
          },
          {
            chunkId: 'c2',
            status: 'completed',
            attempts: 2,
            itemCount: 1,
            failures: [{ id: 'a9', error: 'gone' }],
          },
        ],
      }),
    ).toEqual([
      { id: 'a1', name: 'hero.jpg', error: 'embargoed' },
      { id: 'a9', name: 'a9', error: 'gone' },
    ]);
  });

  it('names a failure the report left unnamed from the library before falling back to the id', () => {
    const report = {
      job: {} as never,
      chunks: [
        {
          chunkId: 'c1',
          status: 'failed' as const,
          attempts: 3,
          itemCount: 2,
          failures: [
            { id: 'a1', error: 'batch failed' },
            { id: 'a2', error: 'batch failed' },
          ],
        },
      ],
    };
    expect(jobFailures(report, new Map([['a1', 'Hero']])).map((f) => f.name)).toEqual([
      'Hero',
      'a2',
    ]);
  });
});

describe('collections', () => {
  it('splits a selection into requests the API takes', () => {
    expect(chunked(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(chunked([], 500)).toEqual([]);
  });

  it('follows every page of a list, and stops at its cap', async () => {
    const pages: Record<string, { items: number[]; nextCursor?: string }> = {
      '': { items: [1, 2], nextCursor: 'b' },
      b: { items: [3], nextCursor: 'c' },
      c: { items: [4] },
    };
    expect(
      await allPages((cursor) => Promise.resolve(pages[cursor ?? ''] ?? { items: [] })),
    ).toEqual([1, 2, 3, 4]);
    let calls = 0;
    const endless = () => {
      calls += 1;
      return Promise.resolve({ items: [calls], nextCursor: 'again' });
    };
    expect(await allPages(endless, 3)).toEqual([1, 2, 3]);
  });

  it('moves one item and keeps the rest in their order', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveItem(['a', 'b'], 1, 9)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });

  it('says where a move put an asset, counting from one', () => {
    expect(movedAnnouncement('Logo', 0, 4)).toBe('“Logo” moved to position 1 of 4');
  });

  it('sums up an add, naming what was already there and what is gone', () => {
    expect(addedSummary('Launch', { requested: 3, added: 3, skipped: 0 })).toBe(
      'Added 3 assets to “Launch”',
    );
    expect(addedSummary('Launch', { requested: 4, added: 1, skipped: 1 })).toBe(
      'Added 1 asset to “Launch”; 2 already in it, 1 no longer in the library',
    );
  });
});

describe('share link expiry', () => {
  const now = Date.parse('2026-11-01T12:00:00.000Z');
  it('counts a preset from now', () => {
    expect(shareExpiresAt('1d', '', now)).toBe('2026-11-02T12:00:00.000Z');
    expect(shareExpiresAt('7d', '', now)).toBe('2026-11-08T12:00:00.000Z');
    expect(shareExpiresAt('30d', '', now)).toBe('2026-12-01T12:00:00.000Z');
  });

  it('reads a custom date on the reader’s clock, and nothing from an empty one', () => {
    expect(shareExpiresAt('custom', '', now)).toBeNull();
    expect(shareExpiresAt('custom', '2026-11-05T09:30', now)).toBe(
      new Date('2026-11-05T09:30').toISOString(),
    );
  });
});

describe('zip progress', () => {
  const zip = (over: Partial<AssetZip>): AssetZip => ({
    id: 'z1',
    status: 'pending',
    source: { kind: 'selection', assetIds: ['a1'] },
    fileName: 'Launch.zip',
    partsDone: 0,
    createdAt: '',
    expiresAt: '',
    ...over,
  });

  it('runs until it is built or has failed', () => {
    expect(zipRunning(zip({ status: 'pending' }))).toBe(true);
    expect(zipRunning(zip({ status: 'running' }))).toBe(true);
    expect(zipRunning(zip({ status: 'completed' }))).toBe(false);
    expect(zipRunning(zip({ status: 'failed' }))).toBe(false);
  });

  it('counts parts written, from nothing until it is planned', () => {
    expect(zipPercent(zip({ status: 'running' }))).toBe(0);
    expect(zipPercent(zip({ status: 'running', partsDone: 3, partCount: 4 }))).toBe(75);
    expect(zipPercent(zip({ status: 'completed', partsDone: 0 }))).toBe(100);
  });

  it('says what it is doing in words', () => {
    expect(zipSummary(zip({}))).toBe('Preparing “Launch.zip”…');
    expect(zipSummary(zip({ status: 'running', fileCount: 12 }))).toBe(
      'Zipping 12 files into “Launch.zip”…',
    );
    expect(zipSummary(zip({ status: 'completed', fileCount: 1, totalBytes: 2048 }))).toBe(
      '“Launch.zip” is ready: 1 file, 2.0 KB',
    );
    expect(zipSummary(zip({ status: 'failed' }))).toBe('“Launch.zip” wasn’t built');
  });
});
