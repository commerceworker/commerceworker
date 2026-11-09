/**
 * The catalog's reads as REST and MCP both answer them: one place for what each returns and how
 * far it reaches, so the two transports can't drift. The catalog Worker is the implementation
 * (`ProductCatalogRpc`); this only names the answer's shape and the bounds. `null` is "no such
 * thing": REST answers it with a 404 and a tool with a refusal.
 */

import type { ProductCatalogRpc } from './api';

/** Recent feeds a call lists: the default and the most the catalog returns. */
export const FEEDS_LIMIT = { default: 20, max: 100 } as const;
/** Cards a board column returns a page (`listBoard`): the default and the most a page holds. */
export const BOARD_PAGE_LIMIT = { default: 50, max: 100 } as const;

const orNull = <K extends string, V>(key: K, value: V | null) =>
  value === null ? null : ({ [key]: value } as { [P in K]: V });

export async function readProduct(c: ProductCatalogRpc, key: string) {
  return orNull('product', await c.getProduct(key));
}

export async function readProductByAlias(c: ProductCatalogRpc, alias: string) {
  return orNull('key', await c.resolveAlias(alias));
}

export async function readProductSheet(c: ProductCatalogRpc, key: string) {
  return orNull('sheet', await c.getProductSheet(key));
}

export async function readFeed(c: ProductCatalogRpc, id: string) {
  return orNull('feed', await c.feedStatus(id));
}

/** The latest feeds; a limit that isn't a number takes the default, one out of range the nearest bound. */
export async function readFeeds(c: ProductCatalogRpc, limit?: number) {
  const asked = Number.isFinite(limit) ? Math.trunc(limit as number) : FEEDS_LIMIT.default;
  return { feeds: await c.listFeeds(Math.min(Math.max(1, asked), FEEDS_LIMIT.max)) };
}

export async function readProductTypes(c: ProductCatalogRpc) {
  return { types: await c.listTypes() };
}

export async function readChannels(c: ProductCatalogRpc) {
  return { channels: await c.listChannels() };
}

export async function readCategories(c: ProductCatalogRpc) {
  return { categories: await c.listCategories() };
}

export async function readBoard(c: ProductCatalogRpc) {
  return { board: await c.catalogBoard() };
}
