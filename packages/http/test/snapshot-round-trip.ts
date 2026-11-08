/**
 * Shared by the HTTP and MCP snapshot round trips: seeds every section `exportSnapshot` writes,
 * runs the staged import jobs as the engine would, and reduces a snapshot to what an import must
 * carry across (ids where an import keeps them, names where it mints new ones).
 */
import {
  type AppContext,
  addToAssetCollection,
  createAsset,
  createAssetCollection,
  createAssetFolder,
  createConcept,
  createContentType,
  createEntry,
  createMenu,
  createRedirect,
  createScheme,
  createTag,
  createWorkflowDraft,
  importChunkRunner,
  publishContentType,
  runBulkChunk,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import type { BulkChunkDueEvent, Scope } from '@commerceworker/domain';
import type { BlobStore } from '@commerceworker/ports';
import type { InMemoryContentStore } from '@commerceworker/test-kit';

/** Gives every section of an export at least one item, so a dropped section shows as empty. */
export async function seedEverySection(ctx: AppContext, blob: BlobStore, scope: Scope) {
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'note',
    name: 'Note',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
    ],
  } as Parameters<typeof createContentType>[3]);
  await publishContentType(ctx, scope, 'note');
  await createEntry(ctx, scope, {
    contentTypeApiId: 'note',
    fields: { title: { 'en-US': 'Hello' } },
  });
  const folder = await createAssetFolder(ctx, scope, { name: 'Brand' });
  const { asset } = await createAsset(
    ctx,
    blob,
    scope,
    { fileName: 'logo.png', contentType: 'image/png' },
    { folderId: folder.id },
  );
  const collection = await createAssetCollection(ctx, scope, { name: 'Kit' });
  await addToAssetCollection(ctx, scope, collection.id, [asset.id]);
  const scheme = await createScheme(ctx, scope, { name: 'Topics' });
  await createConcept(ctx, scope, { schemeId: scheme.id, prefLabel: 'Science' });
  await createTag(ctx, scope, { name: 'news' });
  await createWorkflowDraft(ctx, scope, { name: 'Review' });
  await createRedirect(ctx, scope, { source: '/old', destination: '/new' });
  await createMenu(ctx, scope, {
    handle: 'main',
    name: 'Main',
    items: [{ label: 'Home', link: { type: 'url', url: '/' } }],
  });
}

/** Runs every pending `bulk.chunk_due`, as the engine's bulk consumer would, until none are left. */
export async function drainImportJobs(ctx: AppContext, blob: BlobStore) {
  const store = ctx.store as InMemoryContentStore;
  const ran = new Set<string>();
  for (let round = 0; round < 20; round++) {
    const due = (await store.outbox.readPending(10_000)).filter(
      (e): e is BulkChunkDueEvent => 'type' in e && e.type === 'bulk.chunk_due' && !ran.has(e.id),
    );
    if (due.length === 0) return;
    for (const event of due) {
      ran.add(event.id);
      await runBulkChunk(ctx, event, { importChunk: importChunkRunner(ctx, blob) });
    }
  }
}

type Named = { id: string; name?: string; apiId?: string; prefLabel?: unknown };
interface ExportedSnapshot {
  snapshotVersion: number;
  exportedAt: string;
  source: unknown;
  contentTypes: Named[];
  entries: Named[];
  assets: Named[];
  assetFolders: Named[];
  assetCollections: { collection: Named; assetIds: string[] }[];
  taxonomy: { schemes: Named[]; concepts: Named[]; tags: Named[] };
  workflows: Named[];
  redirects: Named[];
  menus: Named[];
}

/** The envelope keys that describe the export itself rather than carry content. */
export const SNAPSHOT_ENVELOPE = ['exportedAt', 'snapshotVersion', 'source'];

/**
 * What must survive an import, section by section. Taxonomy and workflows are created anew by an
 * import, so they are compared by name; everything else keeps its id. Its keys are every content
 * section an export writes (the round trips check that), so a new section can't go untested.
 */
export function sections(raw: unknown) {
  const s = raw as ExportedSnapshot;
  const ids = (items: Named[] | undefined) => (items ?? []).map((i) => i.id).sort();
  const names = (items: Named[] | undefined) => (items ?? []).map((i) => i.name).sort();
  return {
    contentTypes: (s.contentTypes ?? []).map((t) => t.apiId).sort(),
    entries: ids(s.entries),
    assets: ids(s.assets),
    assetFolders: ids(s.assetFolders),
    assetCollections: (s.assetCollections ?? []).map((c) => ({
      id: c.collection.id,
      name: c.collection.name,
      assetIds: c.assetIds,
    })),
    taxonomy: {
      schemes: names(s.taxonomy?.schemes),
      concepts: (s.taxonomy?.concepts ?? []).map((c) => JSON.stringify(c.prefLabel)).sort(),
      tags: names(s.taxonomy?.tags),
    },
    workflows: names(s.workflows),
    redirects: ids(s.redirects),
    menus: ids(s.menus),
  };
}
