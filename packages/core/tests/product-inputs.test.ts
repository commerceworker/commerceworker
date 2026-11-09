import { describe, expect, it } from 'vitest';
import { ASSISTANT_TOOLS, isPageOnly, TOOL_INPUTS } from '../src';
import {
  CATALOG_BATCH_MAX,
  catalogCategoriesDeleteInput,
  catalogCategoriesInput,
  catalogDeleteInput,
  catalogDiscardInput,
  catalogEditsInput,
  catalogFeedInput,
  catalogProductsInput,
  deleteRefusal,
  editsStaged,
  FEED_TEXT_MAX,
  feedName,
  productsDeleted,
  productsWritten,
} from '../src/product';

const product = {
  key: 'tee',
  type: 'apparel',
  title: { en: 'Tee' },
  variants: [{ sku: 'TEE-1', prices: { web: { amount: 1000, currency: 'USD' } } }],
};
const edit = { key: 'tee', ref: { field: 'title', locale: 'en' }, op: 'set', value: 'Tee' };

describe('the catalog write inputs REST and MCP share', () => {
  it('holds a bulk write to 500 items and at least one', () => {
    const many = (n: number, item: unknown) => Array.from({ length: n }, () => item);
    for (const [schema, key, item] of [
      [catalogProductsInput, 'products', product],
      [catalogDeleteInput, 'keys', 'tee'],
      [catalogCategoriesDeleteInput, 'codes', 'tops'],
      [catalogCategoriesInput, 'categories', { code: 'tops', name: { en: 'Tops' } }],
      [catalogEditsInput, 'edits', edit],
      [catalogDiscardInput, 'items', { key: 'tee' }],
    ] as const) {
      expect(schema.safeParse({ [key]: many(CATALOG_BATCH_MAX, item) }).success, key).toBe(true);
      expect(schema.safeParse({ [key]: many(CATALOG_BATCH_MAX + 1, item) }).success, key).toBe(
        false,
      );
      expect(schema.safeParse({ [key]: [] }).success, key).toBe(false);
    }
  });

  it('bounds a feed’s text, so a larger file goes over REST’s stream', () => {
    const ok = { format: 'ndjson', content: 'x'.repeat(FEED_TEXT_MAX) };
    expect(catalogFeedInput.safeParse(ok).success).toBe(true);
    expect(catalogFeedInput.safeParse({ ...ok, content: `${ok.content}x` }).success).toBe(false);
    expect(catalogFeedInput.safeParse({ ...ok, content: '' }).success).toBe(false);
    expect(catalogFeedInput.safeParse({ ...ok, format: 'xml' }).success).toBe(false);
  });

  it('is what the tools take, so the transports cannot differ', () => {
    expect(TOOL_INPUTS.put_catalog_products).toBe(catalogProductsInput);
    expect(TOOL_INPUTS.delete_catalog_products).toBe(catalogDeleteInput);
    expect(TOOL_INPUTS.stage_product_edits).toBe(catalogEditsInput);
    expect(TOOL_INPUTS.start_catalog_feed).toBe(catalogFeedInput);
    expect(
      TOOL_INPUTS.discard_product_edits.safeParse({ what: 'drafts', items: [{ key: 'tee' }] })
        .success,
    ).toBe(true);
    expect(TOOL_INPUTS.discard_product_edits.safeParse({ items: [{ key: 'tee' }] }).success).toBe(
      false,
    );
  });

  it('keeps the product editor’s staging and discarding off the page-only list', () => {
    expect(isPageOnly('stage_product_edits')).toBe(false);
    expect(isPageOnly('discard_product_edits')).toBe(false);
    // Accepting a draft stays the page’s own button.
    expect(isPageOnly('accept_product_drafts')).toBe(true);
  });

  it('confirms what goes live or comes down, and nothing that only stages', () => {
    for (const t of [
      'put_catalog_products',
      'delete_catalog_products',
      'delete_catalog_type',
      'delete_catalog_channel',
      'put_catalog_categories',
      'delete_catalog_categories',
      'start_catalog_feed',
      'cancel_catalog_feed',
      'reindex_catalog',
      'rebuild_catalog_gaps',
    ] as const)
      expect(ASSISTANT_TOOLS[t].confirm, t).toBe(true);
    for (const t of [
      'put_catalog_type',
      'put_catalog_channel',
      'stage_product_edits',
      'discard_product_edits',
    ] as const)
      expect(ASSISTANT_TOOLS[t].confirm, t).toBe(false);
    for (const t of ['delete_catalog_channel', 'reindex_catalog', 'rebuild_catalog_gaps'] as const)
      expect(ASSISTANT_TOOLS[t].role, t).toBe('admin');
  });
});

describe('what a catalog write records', () => {
  it('counts a product write by outcome', () => {
    const results = [
      { key: 'a', status: 'created' },
      { key: 'b', status: 'updated' },
      { key: 'c', status: 'unchanged' },
      { key: 'd', status: 'rejected' },
      { key: 'e', status: 'deleted' },
    ] as const;
    expect(productsWritten([...results])).toEqual({
      created: 1,
      updated: 1,
      unchanged: 1,
      rejected: 1,
      urgent: false,
    });
    expect(productsWritten([...results], true).urgent).toBe(true);
    expect(productsDeleted([...results])).toEqual({ deleted: 1 });
  });

  it('counts staged edits, products and drafts accepted', () => {
    const ref = { field: 'title', locale: 'en' } as never;
    const edits = [
      { key: 'a', ref, op: 'set', value: 'x', source: 'assistant' },
      { key: 'a', ref, op: 'clear' },
      { key: 'b', ref, op: 'clear' },
    ] as never;
    expect(
      editsStaged(edits, [
        { key: 'a', ref, ok: true },
        { key: 'a', ref, ok: true },
        { key: 'b', ref, ok: false, issues: ['no'] },
      ]),
    ).toEqual({ staged: 2, refused: 1, products: 1, fromDrafts: 1 });
  });

  it('words a refused delete and names a feed', () => {
    expect(deleteRefusal('The type', { issues: ['gone'], notFound: true })).toEqual({
      notFound: true,
      message: 'Not found: gone',
    });
    expect(deleteRefusal('The type', { issues: ['3 products use it'] })).toEqual({
      notFound: false,
      message: 'The type is in use: 3 products use it',
    });
    expect(feedName(null, 'csv')).toBe('feed.csv');
    expect(feedName('x'.repeat(300), 'csv')).toHaveLength(200);
  });
});
