/**
 * What the catalog answers the REST API with, from real shards, validated against the schemas the
 * OpenAPI document describes those responses by (`apps/web/tests/rest-responses.test.ts` holds the
 * handlers to the same schemas, with the catalog's answers typed). A response must carry nothing
 * its schema doesn't name: parsing strips an unknown field, so the parsed value is held equal to
 * the one the catalog returned.
 */
import {
  boardCardSchema,
  boardSummarySchema,
  categoriesDeletedSchema,
  channelDeletedSchema,
  draftSchema,
  editResultSchema,
  type FeedStatus,
  feedStatusSchema,
  gapsRebuiltSchema,
  productDraftResultSchema,
  productSchema,
  productSheetSchema,
  publishResultSchema,
  reindexedSchema,
  typeDeletedSchema,
  writeResultSchema,
} from '@commerceworker/core/product';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, by, product, settle, setup } from './helpers';

beforeAll(setup);

/** The value as JSON, which is how REST sends it, and parsed by `schema` without losing a field. */
function expectValid(
  schema: {
    safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues: unknown } };
  },
  value: unknown,
) {
  const sent = JSON.parse(JSON.stringify(value));
  const parsed = schema.safeParse(sent);
  expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 1)).toBe(true);
  expect(parsed.data).toEqual(sent);
  return sent;
}

/** Each item of a list, as REST sends them. */
function expectAll(schema: Parameters<typeof expectValid>[0], items: readonly unknown[], min = 1) {
  expect(items.length).toBeGreaterThanOrEqual(min);
  for (const item of items) expectValid(schema, item);
}

const ed = 'editor@commerceworker';
const titleFr = { field: 'title' as const, locale: 'fr' };
const descFr = { field: 'description' as const, locale: 'fr' };

function body(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

async function finished(id: string): Promise<FeedStatus> {
  for (let i = 0; i < 300; i++) {
    const s = await api.feedStatus(id);
    if (s && s.state !== 'queued' && s.state !== 'splitting' && s.state !== 'applying') return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`feed ${id} never finished`);
}

describe('the catalog’s answers to the REST API', () => {
  it('products: created, unchanged, rejected and deleted, and the stored product', async () => {
    const p = product({
      description: { en: 'A cotton tee.' },
      extra: { source: 'erp' },
      brand: 'Acme',
    });
    const bad = product({ attributes: { material: 'silk' } });
    const written = await api.putProducts([p, bad], { by });
    expect(written.map((r) => r.status)).toEqual(['created', 'rejected']);
    expectAll(writeResultSchema, written);
    expectAll(writeResultSchema, await api.putProducts([p], { by }));

    const stored = await api.getProduct(p.key);
    expectValid(productSchema, stored);
    expect(await api.resolveAlias(`sku:${p.variants[0]?.sku}`)).toBe(p.key);

    expectAll(writeResultSchema, await api.deleteProducts([p.key], { by }));
  });

  it('a feed, from queued to done with a rejected row, and listed', async () => {
    const prefix = `rt${Date.now().toString(36)}`;
    const csv = [
      'key,type,title:en,title:fr,categories,price.web,sku,attr.material,attr.size',
      `${prefix}-0,apparel,Tee 0,T-shirt 0,tees,19.99,${prefix}-0-S,cotton,S`,
      `${prefix}-1,apparel,Tee 1,T-shirt 1,tees,19.99,${prefix}-1-S,silk,S`,
    ].join('\r\n');
    const started = await api.startFeed(body(csv), { name: 'rest.csv', format: 'csv', by });
    expectValid(feedStatusSchema, started);
    const done = await finished(started.id);
    expect(done).toMatchObject({ state: 'done', created: 1, rejected: 1 });
    expect(done.errors).toHaveLength(1);
    expectValid(feedStatusSchema, done);
    expectAll(feedStatusSchema, await api.listFeeds(5));
    const cancelled = await api.cancelFeed(started.id, by);
    expectValid(feedStatusSchema, cancelled);
  });

  it('the board and a sheet with an override, a staged edit, a draft and its history', async () => {
    const p = product({ description: { en: 'A cotton tee.' }, title: { en: 'Tee' } });
    await api.putProducts([p], { by });
    // A draft and a staged edit wait; the title in French is published, so it has a revision.
    expectAll(
      editResultSchema,
      await api.stageEdits(
        [
          { key: p.key, ref: titleFr, op: 'set', value: 'T-shirt' },
          // An edit the product refuses: a field it doesn't have.
          {
            key: p.key,
            ref: { field: 'attribute', code: 'nope', locale: 'fr' },
            op: 'set',
            value: 'x',
          },
        ],
        ed,
      ),
    );
    expectAll(
      publishResultSchema,
      await api.publishStaged([p.key], { by: ed, requestId: `rt-${Date.now()}` }),
    );
    expectAll(
      editResultSchema,
      await api.putDrafts(
        [{ key: p.key, ref: descFr, value: 'Un tee en coton.', model: '@cf/test' }],
        ed,
      ),
    );
    expectAll(
      editResultSchema,
      await api.stageEdits(
        [{ key: p.key, ref: { field: 'status' }, op: 'set', value: 'draft' }],
        ed,
      ),
    );

    const sheet = await api.getProductSheet(p.key);
    expectValid(productSheetSchema, sheet);
    expect(sheet?.drafts).toHaveLength(1);
    expect(sheet?.revisions.length).toBeGreaterThan(0);
    expectValid(draftSchema, sheet?.drafts[0]);

    await settle();
    expectValid(boardSummarySchema, await api.catalogBoard());
    let cards = 0;
    for (const column of ['gaps', 'drafted', 'staged', 'published'] as const) {
      const page = await api.listBoard({ column, limit: 100 });
      cards += page.items.length;
      expectAll(boardCardSchema, page.items, 0);
      expect(page.cursor === null || typeof page.cursor === 'string').toBe(true);
    }
    // Each column answers a page; between them the product's card is on the board.
    expect(cards).toBeGreaterThan(0);
    expect((await api.discardStaged([{ key: p.key }], ed)).discarded).toBeGreaterThan(0);
    expect((await api.discardDrafts([{ key: p.key }], ed)).discarded).toBeGreaterThan(0);
  });

  it('what rebuilding gaps, republishing and the deletes answer', async () => {
    expectValid(gapsRebuiltSchema, await api.rebuildGaps(by));
    expectValid(reindexedSchema, await api.reindex(by));
    await settle();

    const code = `rt-${Date.now().toString(36)}`;
    const type = await api.putType({ code, version: 1, attributes: [], variantAxes: [] }, by);
    expect(type.ok).toBe(true);
    expectValid(typeDeletedSchema, await api.deleteType(code, by));

    const channel = await api.putChannel(
      { code, name: 'Outlet', currency: 'USD', locales: ['en'], defaultLocale: 'en' },
      by,
    );
    expect(channel.ok).toBe(true);
    expectValid(channelDeletedSchema, await api.deleteChannel(code, by));

    const category = await api.putCategories([{ code, name: { en: 'Spare' } }], by);
    expect(category.ok).toBe(true);
    expectValid(categoriesDeletedSchema, await api.deleteCategories([code], by));
  });

  it('a draft request’s result is what the assistant’s drafts look like', () => {
    expectValid(productDraftResultSchema, {
      key: 'k',
      title: 'Tee',
      drafted: [{ ref: descFr, value: 'Un tee' }],
      refused: [],
      more: 0,
      model: null,
    });
  });
});
