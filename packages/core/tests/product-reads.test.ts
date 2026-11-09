import { describe, expect, it } from 'vitest';
import type { ProductCatalogRpc } from '../src/product';
import {
  FEEDS_LIMIT,
  readBoard,
  readFeed,
  readFeeds,
  readProduct,
  readProductByAlias,
  readProductSheet,
} from '../src/product';

/** A catalog that has nothing: every lookup answers null, and a feeds list records its limit. */
function empty() {
  const limits: (number | undefined)[] = [];
  const c = {
    getProduct: async () => null,
    resolveAlias: async () => null,
    getProductSheet: async () => null,
    feedStatus: async () => null,
    listFeeds: async (limit?: number) => {
      limits.push(limit);
      return [];
    },
    catalogBoard: async () => ({ columns: {} }),
  } as unknown as ProductCatalogRpc;
  return { c, limits };
}

describe('the catalog reads REST and MCP share', () => {
  it('names each answer, and is null for what the catalog lacks', async () => {
    const { c } = empty();
    expect(await readProduct(c, 'nope')).toBeNull();
    expect(await readProductByAlias(c, 'sku:NOPE')).toBeNull();
    expect(await readProductSheet(c, 'nope')).toBeNull();
    expect(await readFeed(c, 'nope')).toBeNull();
    const found = {
      getProduct: async () => ({ key: 'tee' }),
      resolveAlias: async () => 'tee',
      catalogBoard: async () => ({ indexBuilt: true }),
    } as unknown as ProductCatalogRpc;
    expect(await readProduct(found, 'tee')).toEqual({ product: { key: 'tee' } });
    expect(await readProductByAlias(found, 'sku:T')).toEqual({ key: 'tee' });
    expect(await readBoard(found)).toEqual({ board: { indexBuilt: true } });
  });

  it('bounds the feeds limit: the default unset or not a number, the nearest bound out of range', async () => {
    const { c, limits } = empty();
    expect(await readFeeds(c)).toEqual({ feeds: [] });
    await readFeeds(c, Number.NaN);
    await readFeeds(c, 0);
    await readFeeds(c, 5.9);
    await readFeeds(c, 10_000);
    expect(limits).toEqual([FEEDS_LIMIT.default, FEEDS_LIMIT.default, 1, 5, FEEDS_LIMIT.max]);
  });
});
