import type { AppContext } from '@commerceworker/application';
import {
  createContentType,
  createEntry,
  createSpace,
  listPreviewEntries,
  listPublishedEntries,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  updateContentType,
  updateEntry,
} from '@commerceworker/application';
import type { FieldDefinition } from '@commerceworker/domain';
import type { Clock, EntryQuery, IdGenerator } from '@commerceworker/ports';
import { InMemoryContentStore } from '@commerceworker/test-kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Filter by referenced entry against D1: `ref`/`refIn` on a field and `*` (links_to_entry).
 * The published path pushes them down as an IN over the reference edges, the draft path as a
 * scan of the fields' JSON; both must answer exactly as the in-memory engine does, narrow the
 * candidate scan in SQL, and stay within D1's parameter cap however many ids they carry.
 */

const clock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const seqIds = (prefix: string): IdGenerator => {
  let n = 0;
  return { newId: () => `${prefix}-${String(++n).padStart(4, '0')}` };
};

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;
const link = (id: string) => ({ id, linkType: 'Entry' as const });
const embed = (id: string) => ({
  nodeType: 'document',
  data: {},
  content: [{ nodeType: 'embedded-entry-block', data: { target: link(id) }, content: [] }],
});

/** How many people the posts link to; the refIn lists cross the 100-parameter cap. */
const PEOPLE = 6;

describe('filter by referenced entry on D1', { timeout: 60_000 }, () => {
  const runId = crypto.randomUUID();
  const scope = { spaceId: `ref-${runId}`, environmentId: 'main' };
  const other = { spaceId: `ref-other-${runId}`, environmentId: 'main' };
  const d1 = createD1Store(testDb);
  const d1Ctx: AppContext = { store: d1, clock, ids: seqIds(`r-${runId}`) };
  const memCtx: AppContext = {
    store: new InMemoryContentStore(),
    clock,
    ids: seqIds(`r-${runId}`),
  };
  let people: string[] = [];
  let draftOnly = '';

  async function seed(ctx: AppContext, s: typeof scope): Promise<string[]> {
    await createSpace(ctx, { spaceId: s.spaceId, name: 'R', defaultLocale: 'en-US' });
    await createContentType(ctx, SYSTEM_CALLER, s, {
      apiId: 'person',
      name: 'Person',
      displayField: 'name',
      fields: [field({ apiId: 'name', type: 'Symbol' })],
    });
    await createContentType(ctx, SYSTEM_CALLER, s, {
      apiId: 'post',
      name: 'Post',
      displayField: 'title',
      fields: [
        field({ apiId: 'title', type: 'Symbol' }),
        field({ apiId: 'author', type: 'Link', linkType: 'Entry', position: 1 }),
        field({
          apiId: 'related',
          type: 'Array',
          items: { type: 'Link', linkType: 'Entry' },
          position: 2,
        }),
        field({ apiId: 'body', type: 'RichText', position: 3 }),
        field({
          apiId: 'card',
          type: 'Component',
          position: 4,
          fields: [
            field({ apiId: 'heading', type: 'Symbol' }),
            field({ apiId: 'person', type: 'Link', linkType: 'Entry', position: 1 }),
          ],
        }),
        field({ apiId: 'data', type: 'JSON', position: 5 }),
      ],
    });
    await publishContentType(ctx, s, 'person');
    await publishContentType(ctx, s, 'post');
    const ids: string[] = [];
    for (let i = 0; i < PEOPLE; i++) {
      const p = await createEntry(ctx, s, {
        contentTypeApiId: 'person',
        fields: { name: { 'en-US': `P${i}` } },
      });
      await publishEntry(ctx, s, p.entry.id);
      ids.push(p.entry.id);
    }
    const posts: Record<string, unknown>[] = [
      { author: link(ids[0] as string) },
      { author: link(ids[1] as string), related: [link(ids[0] as string), link(ids[2] as string)] },
      { body: embed(ids[3] as string) },
      { card: { heading: 'h', person: link(ids[4] as string) } },
      { author: link(ids[1] as string) },
      {},
      // A link-shaped value in a JSON field: data, not a link, and the edges skip it.
      { data: { nested: link(ids[0] as string) } },
    ];
    for (const [i, f] of posts.entries()) {
      const e = await createEntry(ctx, s, {
        contentTypeApiId: 'post',
        fields: {
          title: { 'en-US': `Post ${i}` },
          ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { 'en-US': v }])),
        } as never,
      });
      await publishEntry(ctx, s, e.entry.id);
    }
    // A post whose author is set only in its draft: Preview sees the link, Delivery doesn't.
    const draft = await createEntry(ctx, s, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Draft' } },
    });
    await publishEntry(ctx, s, draft.entry.id);
    await updateEntry(ctx, s, draft.entry.id, {
      title: { 'en-US': 'Draft' },
      author: { 'en-US': link(ids[5] as string) },
    } as never);
    draftOnly = draft.entry.id;
    // A snapshot holding a link in a field the type doesn't declare (as after the field was
    // removed): it has no edge, and the engine, reading the model, doesn't count it either.
    await ctx.store.entries.putPublished(s, {
      entryId: `${s.spaceId}-legacy`,
      contentTypeApiId: 'post',
      version: 1,
      fields: {
        title: { 'en-US': 'Legacy' },
        legacy: { 'en-US': link(ids[0] as string) },
      } as never,
      publishedAt: clock.now().toISOString(),
    });
    return ids;
  }

  beforeAll(async () => {
    people = await seed(d1Ctx, scope);
    await seed(memCtx, scope);
  });

  // The model rides on every reference query, as the use-cases send it.
  let model: EntryQuery['contentTypes'] = [];
  const queries = (): { name: string; q: EntryQuery }[] => [
    {
      name: 'links in a JSON field or an undeclared field are not links',
      q: { filters: [{ field: '*', op: 'ref', value: people[0] }] },
    },
    {
      name: 'ref on a JSON field',
      q: { filters: [{ field: 'data', op: 'ref', value: people[0] }] },
    },
    {
      name: 'ref on a link field',
      q: { filters: [{ field: 'author', op: 'ref', value: people[1] }] },
    },
    {
      name: 'refIn through a list of links',
      q: { filters: [{ field: 'related', op: 'refIn', value: [people[2], 'missing'] }] },
    },
    {
      name: 'ref on a component member is found by its top-level field',
      q: { filters: [{ field: 'card', op: 'ref', value: people[4] }] },
    },
    {
      name: 'links_to_entry in rich text',
      q: { filters: [{ field: '*', op: 'ref', value: people[3] }] },
    },
    {
      name: 'links_to_entry across fields',
      q: { filters: [{ field: '*', op: 'refIn', value: [people[0], people[4]] }] },
    },
    {
      name: 'ref with another filter',
      q: {
        filters: [
          { field: 'author', op: 'ref', value: people[1] },
          { field: 'title', op: 'eq', value: 'Post 4' },
        ],
      },
    },
    {
      name: 'the draft-only link',
      q: { filters: [{ field: 'author', op: 'ref', value: people[5] }] },
    },
    {
      name: 'refIn past the parameter cap',
      q: {
        filters: [
          {
            field: '*',
            op: 'refIn',
            value: [...Array.from({ length: 150 }, (_, i) => `nobody-${i}`), people[0]],
          },
        ],
      },
    },
  ];

  it('answers every reference query exactly as the in-memory engine does', async () => {
    model = await d1.contentTypes.list(scope);
    for (const { name, q: bare } of queries()) {
      const q = { ...bare, contentTypes: model };
      const [a, b] = await Promise.all([
        d1.entries.listPublished(scope, q),
        memCtx.store.entries.listPublished(scope, q),
      ]);
      expect(a.map((r) => r.entryId).sort(), `published: ${name}`).toEqual(
        b.map((r) => r.entryId).sort(),
      );
      const [c, d] = await Promise.all([
        d1.entries.list(scope, q),
        memCtx.store.entries.list(scope, q),
      ]);
      expect(c.map((r) => r.entry.id).sort(), `draft: ${name}`).toEqual(
        d.map((r) => r.entry.id).sort(),
      );
    }
  });

  it('without the model, a link-shaped value anywhere counts, so the edge pushdown alone is narrower', async () => {
    const q: EntryQuery = { filters: [{ field: '*', op: 'ref', value: people[0] }] };
    const withModel = await memCtx.store.entries.listPublished(scope, {
      ...q,
      contentTypes: await memCtx.store.contentTypes.list(scope),
    });
    const without = await memCtx.store.entries.listPublished(scope, q);
    expect(without.length).toBe(withModel.length + 2);
  });

  it('a field key holding a quote widens the scan instead of failing the statement', async () => {
    // Written straight to the store: validation would refuse such a key.
    const id = `${scope.spaceId}-quoted`;
    const fields = {
      title: { 'en-US': 'Quoted' },
      'we"ird': { 'en-US': link(people[0] as string) },
    };
    await d1.entries.putPublished(scope, {
      entryId: id,
      contentTypeApiId: 'post',
      version: 1,
      fields: fields as never,
      publishedAt: clock.now().toISOString(),
    });
    await d1.entries.create(
      scope,
      { id, contentTypeApiId: 'post', status: 'draft', currentVersion: 1, publishedVersion: null },
      { entryId: id, version: 1, fields: fields as never, createdAt: clock.now().toISOString() },
    );
    for (const filters of [
      [{ field: 'author', op: 'ref' as const, value: people[0] }],
      [{ field: '*', op: 'ref' as const, value: people[0] }],
      [{ field: 'card.heading', op: 'eq' as const, value: 'h' }],
      [{ field: 'card.heading', op: 'startsWith' as const, value: 'h' }],
    ]) {
      await expect(d1.entries.listPublished(scope, { filters })).resolves.toBeDefined();
      await expect(d1.entries.list(scope, { filters })).resolves.toBeDefined();
    }
  });

  it('reads the published links on Delivery and the draft links on Preview', async () => {
    const q: EntryQuery = { filters: [{ field: 'author', op: 'ref', value: people[5] }] };
    expect(await d1.entries.listPublished(scope, q)).toEqual([]);
    expect((await d1.entries.list(scope, q)).map((r) => r.entry.id)).toEqual([draftOnly]);
  });

  it('narrows in SQL: a reference filter fits a scan cap the whole type does not', async () => {
    const tiny = createD1Store(testDb, { queryScanLimit: 2 });
    const all: EntryQuery = {
      contentTypeApiId: 'post',
      order: [{ field: 'title', direction: 'asc' }],
    };
    await expect(tiny.entries.listPublished(scope, all)).rejects.toMatchObject({
      code: 'query_too_broad',
    });
    await expect(tiny.entries.list(scope, all)).rejects.toMatchObject({ code: 'query_too_broad' });
    for (const filters of [
      [{ field: 'author', op: 'ref' as const, value: people[1] }],
      [{ field: '*', op: 'ref' as const, value: people[3] }],
      [{ field: 'related', op: 'refIn' as const, value: [people[0], people[2]] }],
    ]) {
      const q = { ...all, filters };
      await expect(tiny.entries.listPublished(scope, q)).resolves.not.toHaveLength(0);
      await expect(tiny.entries.list(scope, q)).resolves.not.toHaveLength(0);
    }
  });

  it('reads only its own scope’s edges, even for an entry id another scope shares', async () => {
    const [post] = await d1.entries.listPublished(scope, {
      filters: [{ field: 'author', op: 'ref', value: people[0] }],
    });
    // The same entry id in another space links to `elsewhere`; this space's entry does not.
    await d1.references.replaceForEntry(other, post?.entryId as string, [
      {
        fromEntryId: post?.entryId as string,
        fromField: 'author',
        toId: 'elsewhere',
        toType: 'Entry',
      },
    ]);
    for (const filters of [
      [{ field: 'author', op: 'ref' as const, value: 'elsewhere' }],
      [{ field: '*', op: 'ref' as const, value: 'elsewhere' }],
    ]) {
      expect(await d1.entries.listPublished(scope, { filters })).toEqual([]);
    }
  });

  it('Delivery trusts the edges when the type was edited after publish; Preview reads today’s type', async () => {
    const s2 = { spaceId: `ref-edit-${runId}`, environmentId: 'main' };
    const ctx: AppContext = { store: d1, clock, ids: seqIds(`re-${runId}`) };
    await createSpace(ctx, { spaceId: s2.spaceId, name: 'E', defaultLocale: 'en-US' });
    const card = (person: boolean) =>
      field({
        apiId: 'card',
        type: 'Component',
        position: 1,
        fields: [
          field({ apiId: 'heading', type: 'Symbol' }),
          person
            ? field({ apiId: 'person', type: 'Link', linkType: 'Entry', position: 1 })
            : field({ apiId: 'person', type: 'JSON', position: 1 }),
        ],
      });
    await createContentType(ctx, SYSTEM_CALLER, s2, {
      apiId: 'person',
      name: 'Person',
      displayField: 'name',
      fields: [field({ apiId: 'name', type: 'Symbol' })],
    });
    await createContentType(ctx, SYSTEM_CALLER, s2, {
      apiId: 'post',
      name: 'Post',
      displayField: 'title',
      fields: [field({ apiId: 'title', type: 'Symbol' }), card(true)],
    });
    await publishContentType(ctx, s2, 'person');
    await publishContentType(ctx, s2, 'post');
    const ann = await createEntry(ctx, s2, {
      contentTypeApiId: 'person',
      fields: { name: { 'en-US': 'Ann' } },
    });
    await publishEntry(ctx, s2, ann.entry.id);
    const post = await createEntry(ctx, s2, {
      contentTypeApiId: 'post',
      fields: {
        title: { 'en-US': 'Card' },
        card: { 'en-US': { heading: 'h', person: link(ann.entry.id) } },
      } as never,
    });
    await publishEntry(ctx, s2, post.entry.id);
    // The nested link field becomes a JSON field; the published snapshot and its edge remain.
    await updateContentType(ctx, SYSTEM_CALLER, s2, 'post', {
      fields: [field({ apiId: 'title', type: 'Symbol' }), card(false)],
    });
    await publishContentType(ctx, s2, 'post');
    for (const filters of [
      [{ field: 'card', op: 'ref' as const, value: ann.entry.id }],
      [{ field: '*', op: 'refIn' as const, value: [ann.entry.id] }],
    ]) {
      const delivered = await listPublishedEntries(ctx, s2, { contentTypeApiId: 'post', filters });
      expect(delivered.map((e) => e.id)).toEqual([post.entry.id]);
      // Preview has no edges for drafts: it reads the type as it is now, which links nothing.
      expect(await listPreviewEntries(ctx, s2, { contentTypeApiId: 'post', filters })).toEqual([]);
    }
  });
});
