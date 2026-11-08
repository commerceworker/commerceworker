import type { FieldDefinition, Principal } from '@commerceworker/domain';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryCache,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  cacheTag,
  createAsset,
  createContentType,
  createEntry,
  createSpace,
  getPublishedEntry,
  listPublishedEntries,
  maskDeliveredFields,
  publishAsset,
  publishEntry,
  SYSTEM_CALLER,
  unpublishEntry,
  updateEntry,
} from '../src/index';

/**
 * Delivery resolves links wherever an entry holds them, not only in Link and
 * Array-of-Link fields: inside rich-text reference nodes (`data.target`) and
 * inside Component values. Each embed is prefetched in the same batched read
 * as a field link, and lands in the render's cache tags.
 */

const scope = { spaceId: 'blog', environmentId: 'main' };

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const entryLink = (id: string) => ({ id, linkType: 'Entry' as const });
const text = (value: string) => ({ nodeType: 'text', value, marks: [] });

/** A body that embeds `entryId` as a block and links it inline, plus an asset block. */
const bodyWith = (entryId: string, assetId?: string) => ({
  nodeType: 'document',
  content: [
    { nodeType: 'embedded-entry-block', data: { target: entryLink(entryId) }, content: [] },
    {
      nodeType: 'paragraph',
      content: [
        text('See '),
        {
          nodeType: 'entry-hyperlink',
          data: { target: entryLink(entryId) },
          content: [text('the author')],
        },
        { nodeType: 'embedded-entry-inline', data: { target: entryLink(entryId) }, content: [] },
        {
          nodeType: 'hyperlink',
          data: { uri: 'https://example.com' },
          content: [text('elsewhere')],
        },
      ],
    },
    ...(assetId
      ? [
          {
            nodeType: 'embedded-asset-block',
            data: { target: { id: assetId, linkType: 'Asset' } },
            content: [],
          },
        ]
      : []),
  ],
});

type Node = { nodeType: string; data?: { target?: unknown }; content?: Node[] };
type Embedded = { id: string; contentType: string; fields: Record<string, unknown> };

/** The `data.target` of every reference node in a delivered document, in order. */
function targets(doc: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (n: Node) => {
    if (n.data?.target !== undefined) out.push(n.data.target);
    n.content?.forEach(walk);
  };
  walk(doc as Node);
  return out;
}

function setup() {
  const store = new InMemoryContentStore();
  const cache = new InMemoryCache();
  const ctx: AppContext = {
    store,
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('e'),
    cache,
  };
  // Count batched reads so "no per-link reads" is proven, not assumed.
  let manyReads = 0;
  const inner = store.entries.getPublishedMany.bind(store.entries);
  (store.entries as { getPublishedMany: typeof inner }).getPublishedMany = async (s, ids) => {
    manyReads += 1;
    return inner(s, ids);
  };
  // Capture the tags each render is cached under.
  const tagsByKey = new Map<string, readonly string[]>();
  const set = cache.set.bind(cache);
  cache.set = async (key, value, opts) => {
    tagsByKey.set(key, opts?.tags ?? []);
    return set(key, value, opts);
  };
  return { ctx, store, cache, blob: new FakeBlobStore(), reads: () => manyReads, tagsByKey };
}

async function seedModel(ctx: AppContext) {
  await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'author',
    name: 'Author',
    displayField: 'name',
    fields: [
      field({ apiId: 'name', type: 'Symbol', required: true }),
      field({ apiId: 'mentor', type: 'Link', linkType: 'Entry', position: 1 }),
      field({ apiId: 'email', type: 'Symbol', position: 2 }),
    ],
  });
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'post',
    name: 'Post',
    displayField: 'title',
    fields: [
      field({ apiId: 'title', type: 'Symbol', required: true }),
      field({ apiId: 'body', type: 'RichText', position: 1 }),
      field({
        apiId: 'hero',
        type: 'Component',
        position: 2,
        fields: [
          field({ apiId: 'heading', type: 'Symbol' }),
          field({ apiId: 'byline', type: 'Link', linkType: 'Entry', position: 1 }),
        ],
      }),
      field({
        apiId: 'cards',
        type: 'Array',
        position: 3,
        items: {
          type: 'Component',
          fields: [field({ apiId: 'author', type: 'Link', linkType: 'Entry' })],
        },
      }),
    ],
  });
}

async function author(ctx: AppContext, name: string, mentor?: string) {
  const created = await createEntry(ctx, scope, {
    contentTypeApiId: 'author',
    fields: {
      name: { 'en-US': name },
      email: { 'en-US': `${name.toLowerCase()}@example.com` },
      ...(mentor ? { mentor: { 'en-US': entryLink(mentor) } } : {}),
    },
  });
  await publishEntry(ctx, scope, created.entry.id);
  return created.entry.id;
}

async function post(ctx: AppContext, fields: Record<string, unknown>) {
  const created = await createEntry(ctx, scope, {
    contentTypeApiId: 'post',
    fields: Object.fromEntries(
      Object.entries({ title: 'Post', ...fields }).map(([k, v]) => [k, { 'en-US': v }]),
    ),
  });
  await publishEntry(ctx, scope, created.entry.id);
  return created.entry.id;
}

describe('delivery resolves links inside rich text and components', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(async () => {
    h = setup();
    await seedModel(h.ctx);
  });

  it('leaves every rich-text target a stub at include 0', async () => {
    const ada = await author(h.ctx, 'Ada');
    const id = await post(h.ctx, { body: bodyWith(ada) });
    const r = await getPublishedEntry(h.ctx, scope, id, { locale: 'en-US', include: 0 });
    expect(targets(r.fields.body)).toEqual([entryLink(ada), entryLink(ada), entryLink(ada)]);
    expect(h.reads()).toBe(0);
  });

  it('embeds entries and assets in place of data.target at include 1, keeping the nodes', async () => {
    const mentor = await author(h.ctx, 'Grace');
    const ada = await author(h.ctx, 'Ada', mentor);
    const asset = await createAsset(h.ctx, h.blob, scope, {
      fileName: 'hero.png',
      contentType: 'image/png',
      title: { 'en-US': 'Hero' },
    });
    await publishAsset(h.ctx, scope, asset.asset.id);
    const id = await post(h.ctx, { body: bodyWith(ada, asset.asset.id) });

    const r = await getPublishedEntry(h.ctx, scope, id, { locale: 'en-US', include: 1 });
    const body = r.fields.body as Node;
    expect(body.content?.map((n) => n.nodeType)).toEqual([
      'embedded-entry-block',
      'paragraph',
      'embedded-asset-block',
    ]);
    const [block, link, inline, image] = targets(body) as [Embedded, Embedded, Embedded, Embedded];
    for (const embed of [block, link, inline]) {
      expect(embed).toMatchObject({ id: ada, contentType: 'author', fields: { name: 'Ada' } });
      // One level only: the embed's own link stays a stub.
      expect(embed.fields.mentor).toEqual(entryLink(mentor));
    }
    // The delivered asset shape a Link field's asset embed has, flattened to the asked locale.
    expect(image).toMatchObject({ id: asset.asset.id, title: 'Hero', kind: 'image' });
    expect((image as unknown as { file: { fileName: string } }).file.fileName).toBe('hero.png');
    // Plain hyperlinks are untouched.
    expect(JSON.stringify(body)).toContain('"uri":"https://example.com"');
  });

  it('follows links inside an embed at include 2, in one batched read per level', async () => {
    const mentor = await author(h.ctx, 'Grace');
    const ada = await author(h.ctx, 'Ada', mentor);
    const id = await post(h.ctx, { body: bodyWith(ada) });
    const before = h.reads();

    const r = await getPublishedEntry(h.ctx, scope, id, { locale: 'en-US', include: 2 });
    const [block] = targets(r.fields.body) as [Embedded];
    expect(block.fields.mentor).toMatchObject({ id: mentor, fields: { name: 'Grace' } });
    expect(h.reads() - before).toBe(2);
  });

  it('stubs a rich-text cycle instead of recursing', async () => {
    const a = await createEntry(h.ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'A' } },
    });
    const b = await post(h.ctx, { title: 'B', body: bodyWith(a.entry.id) });
    await updateEntry(h.ctx, scope, a.entry.id, {
      title: { 'en-US': 'A' },
      body: { 'en-US': bodyWith(b) },
    });
    await publishEntry(h.ctx, scope, a.entry.id);

    const r = await getPublishedEntry(h.ctx, scope, a.entry.id, { locale: 'en-US', include: 5 });
    const [embeddedB] = targets(r.fields.body) as [Embedded];
    expect(embeddedB.id).toBe(b);
    expect(targets(embeddedB.fields.body)).toEqual([
      entryLink(a.entry.id),
      entryLink(a.entry.id),
      entryLink(a.entry.id),
    ]);
  });

  it('keeps the stub for a target unpublished after the embedding entry was published', async () => {
    const ada = await author(h.ctx, 'Ada');
    const id = await post(h.ctx, { body: bodyWith(ada) });
    await unpublishEntry(h.ctx, scope, ada);

    const r = await getPublishedEntry(h.ctx, scope, id, { locale: 'en-US', include: 1 });
    expect(targets(r.fields.body)).toEqual([entryLink(ada), entryLink(ada), entryLink(ada)]);
  });

  it('resolves links nested in a Component and in a repeater', async () => {
    const ada = await author(h.ctx, 'Ada');
    const grace = await author(h.ctx, 'Grace');
    const id = await post(h.ctx, {
      hero: { heading: 'Hi', byline: entryLink(ada) },
      cards: [{ author: entryLink(ada) }, { author: entryLink(grace) }],
    });

    const r = await getPublishedEntry(h.ctx, scope, id, { locale: 'en-US', include: 1 });
    const hero = r.fields.hero as { heading: string; byline: Embedded };
    expect(hero.heading).toBe('Hi');
    expect(hero.byline).toMatchObject({ id: ada, fields: { name: 'Ada' } });
    const cards = r.fields.cards as { author: Embedded }[];
    expect(cards.map((c) => c.author.fields.name)).toEqual(['Ada', 'Grace']);

    // Without a locale, the same walk runs under each per-locale map.
    const all = await getPublishedEntry(h.ctx, scope, id, { include: 1 });
    const heroes = all.fields.hero as Record<string, { byline: Embedded }>;
    expect(heroes['en-US']?.byline.id).toBe(ada);
  });

  it('tags the cached render with every entry embedded in rich text and components', async () => {
    const ada = await author(h.ctx, 'Ada');
    const grace = await author(h.ctx, 'Grace');
    const id = await post(h.ctx, {
      body: bodyWith(ada),
      hero: { byline: entryLink(grace) },
    });
    await getPublishedEntry(h.ctx, scope, id, { locale: 'en-US', include: 1 });
    const tags = [...h.tagsByKey.values()].flat();
    expect(tags).toEqual(expect.arrayContaining([id, ada, grace].map((e) => cacheTag(scope, e))));

    // Evicting only the embedded entry's own tag drops the render.
    await updateEntry(h.ctx, scope, ada, { name: { 'en-US': 'Ada L.' } });
    await publishEntry(h.ctx, scope, ada);
    await h.cache.invalidateTag(cacheTag(scope, ada));
    const r = await getPublishedEntry(h.ctx, scope, id, { locale: 'en-US', include: 1 });
    expect((targets(r.fields.body)[0] as Embedded).fields.name).toBe('Ada L.');
  });

  it('embeds rich-text links across list rows with one shared prefetch', async () => {
    const ada = await author(h.ctx, 'Ada');
    await post(h.ctx, { title: 'One', body: bodyWith(ada) });
    await post(h.ctx, { title: 'Two', body: bodyWith(ada) });
    const before = h.reads();

    const rows = await listPublishedEntries(
      h.ctx,
      scope,
      { contentTypeApiId: 'post' },
      { locale: 'en-US', include: 1 },
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect((targets(row.fields.body)[0] as Embedded).fields.name).toBe('Ada');
    }
    expect(h.reads() - before).toBe(1);
  });

  it('masks embeds inside rich text and components by their own content type', async () => {
    const ada = await author(h.ctx, 'Ada');
    const id = await post(h.ctx, { body: bodyWith(ada), hero: { byline: entryLink(ada) } });
    const r = await getPublishedEntry(h.ctx, scope, id, { locale: 'en-US', include: 1 });

    const denyEmail: Principal = {
      kind: 'cda',
      spaceId: 'blog',
      scopes: ['delivery:read'],
      contentGrants: [
        { contentTypeApiId: 'post', actions: ['read'] },
        { contentTypeApiId: 'author', actions: ['read'], deniedFields: ['email'] },
      ],
    };
    const masked = maskDeliveredFields(denyEmail, 'post', r.fields);
    for (const embed of targets(masked.body) as Embedded[]) {
      expect(embed.fields.name).toBe('Ada');
      expect(embed.fields.email).toBeUndefined();
    }
    expect((masked.hero as { byline: Embedded }).byline.fields.email).toBeUndefined();

    // No grant on the embedded type: every embed reverts to its stub.
    const postOnly: Principal = {
      ...denyEmail,
      contentGrants: [{ contentTypeApiId: 'post', actions: ['read'] }],
    };
    const stubbed = maskDeliveredFields(postOnly, 'post', r.fields);
    expect(targets(stubbed.body)).toEqual([entryLink(ada), entryLink(ada), entryLink(ada)]);
    expect((stubbed.hero as { byline: unknown }).byline).toEqual(entryLink(ada));
  });
});
