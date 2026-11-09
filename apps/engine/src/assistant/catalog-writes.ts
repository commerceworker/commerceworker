/**
 * The catalog's admin writes through the assistant and MCP, REST's twins (apps/web's
 * catalog-api.server.ts): the same catalog calls, bounds, roles and audit actions. A write that
 * changes the live catalog or takes something down stops for a confirm with a preview of what it
 * touches, and is refused up front where the catalog would refuse it: writing products, a feed,
 * categories, and every delete, a reindex and a gap rebuild. Saving a type or a channel changes
 * nothing buyers see until products use it or the next reindex, so it runs at once.
 */

import {
  type ActionPreview,
  boundText,
  type Principal,
  type ToolInput,
} from '@commerceworker/core';
import {
  type Channel,
  deleteRefusal,
  feedName,
  type ProductTypeInput,
  productsDeleted,
  productsWritten,
} from '@commerceworker/core/product';
import { recordAudit } from '../audit';
import { Refused } from './data';
import { catalog } from './product-draft';

type Trail = Record<string, unknown>;

const by = (p: Principal) => p.email ?? p.id;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Keys or codes for a card: the first few, one bounded line each is not needed, they are short. */
const some = (items: string[], n = 6) =>
  `${items
    .slice(0, n)
    .map((i) => boundText(i, 60))
    .join(', ')}${items.length > n ? ` and ${items.length - n} more` : ''}`;
/** Products a preview looks up before it says how many exist: each is a call to the catalog. */
const LOOKUP_MAX = 50;

export type CatalogWrite = {
  put_catalog_products: ToolInput<'put_catalog_products'>;
  delete_catalog_products: ToolInput<'delete_catalog_products'>;
  delete_catalog_type: ToolInput<'delete_catalog_type'>;
  delete_catalog_channel: ToolInput<'delete_catalog_channel'>;
  put_catalog_categories: ToolInput<'put_catalog_categories'>;
  delete_catalog_categories: ToolInput<'delete_catalog_categories'>;
  start_catalog_feed: ToolInput<'start_catalog_feed'>;
  cancel_catalog_feed: ToolInput<'cancel_catalog_feed'>;
  reindex_catalog: Record<string, never>;
  rebuild_catalog_gaps: Record<string, never>;
};
export type CatalogWriteTool = keyof CatalogWrite;

/** A feed's rows, near enough to say how many the file holds: lines, less a CSV's header. */
const feedRows = (content: string, format: 'csv' | 'ndjson') => {
  const lines = content.split('\n').filter((l) => l.trim()).length;
  return format === 'csv' ? Math.max(0, lines - 1) : lines;
};

export async function previewCatalogWrite<T extends CatalogWriteTool>(
  env: Env,
  tool: T,
  input: CatalogWrite[T],
  roleBlock?: string,
): Promise<ActionPreview> {
  const c = catalog(env);
  const block = (why?: string) => roleBlock ?? why;
  switch (tool) {
    case 'put_catalog_products': {
      const i = input as CatalogWrite['put_catalog_products'];
      return {
        title: `Write ${plural(i.products.length, 'product')}`,
        href: '/catalog',
        consequences: [
          'Writes the live catalog, not a draft: each stored product publishes to the storefront and the feeds within the minute',
          some(i.products.map((x) => x.key)),
          'A field a person edited keeps their text; a changed feed value for it makes a conflict',
          'Products that already match write nothing',
          ...(i.urgent ? ['Purges cached copies now (rationed)'] : []),
        ],
        blocked: block(),
      };
    }
    case 'delete_catalog_products': {
      const i = input as CatalogWrite['delete_catalog_products'];
      const keys = [...new Set(i.keys)];
      const looked = keys.slice(0, LOOKUP_MAX);
      const found = (await Promise.all(looked.map((k) => c.getProduct(k)))).filter(Boolean).length;
      return {
        title: `Delete ${plural(keys.length, 'product')}`,
        href: '/catalog',
        consequences: [
          some(keys),
          keys.length > looked.length
            ? `${found} of the first ${looked.length} exist`
            : `${found} of ${keys.length} exist; the rest are skipped`,
          'Takes them off the storefront and out of the feeds; only a new write or feed brings them back',
          ...(i.urgent ? ['Purges cached copies now (rationed)'] : []),
        ],
        blocked: block(
          found || keys.length > looked.length ? undefined : 'None of these products exist.',
        ),
      };
    }
    case 'delete_catalog_type': {
      const { code } = input as CatalogWrite['delete_catalog_type'];
      const type = (await c.listTypes()).find((t) => t.code === code);
      return {
        title: `Delete the product type ${boundText(code, 60)}`,
        href: '/catalog',
        consequences: [
          type ? `Removes every version, the latest is v${type.version}` : 'No such type',
          // The catalog answers whether a product uses it when it runs; nothing counts them up front.
          'Refused, removing nothing, while any product uses it',
        ],
        blocked: block(type ? undefined : `The catalog has no product type ${code}.`),
      };
    }
    case 'delete_catalog_channel': {
      const { code } = input as CatalogWrite['delete_catalog_channel'];
      const channel = (await c.listChannels()).find((x) => x.code === code);
      return {
        title: `Delete the channel ${boundText(code, 60)}`,
        href: '/catalog',
        consequences: channel
          ? [
              `${boundText(channel.name, 80)} · ${channel.currency} · ${channel.locales.join(', ')}`,
              'Takes down everything published in it: documents, SKU and slug pointers, cards, listings, search and category trees',
              'Products keep their listing data for it',
            ]
          : [],
        blocked: block(channel ? undefined : `The catalog has no channel ${code}.`),
      };
    }
    case 'put_catalog_categories': {
      const i = input as CatalogWrite['put_catalog_categories'];
      return {
        title: `Write ${plural(i.categories.length, 'category', 'categories')}`,
        href: '/catalog',
        consequences: [
          some(i.categories.map((x) => x.code)),
          'The category tree is republished live once for the call',
        ],
        blocked: block(),
      };
    }
    case 'delete_catalog_categories': {
      const i = input as CatalogWrite['delete_catalog_categories'];
      const codes = [...new Set(i.codes)];
      const all = await c.listCategories();
      const known = new Set(all.map((x) => x.code));
      const missing = codes.filter((x) => !known.has(x));
      const kept = all.filter(
        (x) => x.parent && codes.includes(x.parent) && !codes.includes(x.code),
      );
      return {
        title: `Delete ${plural(codes.length, 'category', 'categories')}`,
        href: '/catalog',
        consequences: [some(codes), 'Refused, removing nothing, while a product is in one of them'],
        blocked: block(
          missing.length
            ? `The catalog has no category ${some(missing, 3)}.`
            : kept.length
              ? `${some(
                  kept.map((x) => x.code),
                  3,
                )} ${kept.length === 1 ? 'is a child' : 'are children'} of a category in this set, so it would be left without its parent. Delete them too, or move them first.`
              : undefined,
        ),
      };
    }
    case 'start_catalog_feed': {
      const i = input as CatalogWrite['start_catalog_feed'];
      const rows = feedRows(i.content, i.format);
      return {
        title: `Import ${boundText(feedName(i.name, i.format), 80)}`,
        href: '/catalog',
        consequences: [
          `${i.format.toUpperCase()}, about ${plural(rows, 'row')}, ${Math.ceil(i.content.length / 1024)} KiB`,
          'Writes the live catalog, not a draft: each product it stores publishes within the minute',
          'A field a person edited keeps their text; a changed feed value for it makes a conflict',
          'It runs in the background; cancel it from the feed list while it has not finished',
        ],
        blocked: block(rows ? undefined : 'The file has no rows.'),
      };
    }
    case 'cancel_catalog_feed': {
      const { feedId } = input as CatalogWrite['cancel_catalog_feed'];
      const feed = await c.feedStatus(feedId);
      return {
        title: `Cancel the feed ${feed ? boundText(feed.name, 80) : feedId}`,
        href: '/catalog',
        consequences: feed
          ? [
              `${feed.state}: ${feed.partsDone} of ${feed.parts} parts applied, ${feed.rows} rows read`,
              'No more of its file is read; parts already handed to the catalog still apply, so some products may have been written',
            ]
          : [],
        blocked: block(
          !feed
            ? `The catalog has no feed ${feedId}.`
            : ['done', 'failed', 'cancelled'].includes(feed.state)
              ? `The feed has already finished (${feed.state}).`
              : undefined,
        ),
      };
    }
    case 'reindex_catalog':
      return {
        title: 'Reindex the catalog',
        href: '/catalog',
        consequences: [
          'Queues every product in every shard to be published again',
          'Published pages are rewritten as the publishers get to them; changed channel currencies and locales reach them',
        ],
        blocked: roleBlock,
      };
    case 'rebuild_catalog_gaps':
      return {
        title: 'Rebuild the gap index',
        href: '/catalog',
        consequences: [
          'Reads every product in the catalog and recounts its content gaps',
          'The board’s counts can read incomplete until it finishes',
        ],
        blocked: roleBlock,
      };
  }
}

/** A catalog refusal as the model reads it: what it was and the catalog's own reasons. */
const refused = (what: string, issues: string[]) => new Refused(`${what}: ${issues.join(' ')}`);

export async function runCatalogWrite<T extends CatalogWriteTool>(
  env: Env,
  p: Principal,
  tool: T,
  input: CatalogWrite[T],
  trail: Trail,
): Promise<Record<string, unknown>> {
  const c = catalog(env);
  switch (tool) {
    case 'put_catalog_products': {
      const i = input as CatalogWrite['put_catalog_products'];
      const results = await c.putProducts(i.products, { by: by(p), urgent: i.urgent });
      const d = productsWritten(results, i.urgent);
      await recordAudit(env, 'catalog.products_written', { actor: p, detail: { ...d, ...trail } });
      return {
        done: `Wrote ${d.created + d.updated} of ${i.products.length} (${d.created} created, ${d.updated} updated, ${d.unchanged} unchanged, ${d.rejected} rejected)`,
        href: '/catalog',
        results,
      };
    }
    case 'delete_catalog_products': {
      const i = input as CatalogWrite['delete_catalog_products'];
      const results = await c.deleteProducts(i.keys, { by: by(p), urgent: i.urgent });
      const d = productsDeleted(results);
      await recordAudit(env, 'catalog.products_deleted', { actor: p, detail: { ...d, ...trail } });
      return { done: `Deleted ${d.deleted} of ${i.keys.length}`, href: '/catalog', results };
    }
    case 'delete_catalog_type': {
      const { code } = input as CatalogWrite['delete_catalog_type'];
      const r = await c.deleteType(code, by(p));
      if (!r.ok) throw new Refused(deleteRefusal('The type', r).message);
      await recordAudit(env, 'catalog.type_deleted', {
        actor: p,
        target: code,
        detail: { versions: r.versions, ...trail },
      });
      return { done: `Deleted ${code} (${plural(r.versions, 'version')})`, href: '/catalog' };
    }
    case 'delete_catalog_channel': {
      const { code } = input as CatalogWrite['delete_catalog_channel'];
      const r = await c.deleteChannel(code, by(p));
      if (!r.ok) throw new Refused(deleteRefusal('The channel', r).message);
      await recordAudit(env, 'catalog.channel_deleted', {
        actor: p,
        target: code,
        detail: { unpublished: r.unpublished, ...trail },
      });
      return { done: `Deleted ${code}; took down ${r.unpublished} published`, href: '/catalog' };
    }
    case 'put_catalog_categories': {
      const i = input as CatalogWrite['put_catalog_categories'];
      const r = await c.putCategories(i.categories, by(p));
      if (!r.ok) throw refused('Categories refused', r.issues);
      await recordAudit(env, 'catalog.categories_saved', {
        actor: p,
        detail: { count: r.categories.length, ...trail },
      });
      return {
        done: `Wrote ${plural(r.categories.length, 'category', 'categories')}`,
        href: '/catalog',
        categories: r.categories,
      };
    }
    case 'delete_catalog_categories': {
      const i = input as CatalogWrite['delete_catalog_categories'];
      const r = await c.deleteCategories(i.codes, by(p));
      if (!r.ok) throw new Refused(deleteRefusal('A category', r).message);
      await recordAudit(env, 'catalog.categories_deleted', {
        actor: p,
        detail: { codes: r.deleted, ...trail },
      });
      return {
        done: `Deleted ${plural(r.deleted.length, 'category', 'categories')}`,
        href: '/catalog',
      };
    }
    case 'start_catalog_feed': {
      const i = input as CatalogWrite['start_catalog_feed'];
      const name = feedName(i.name, i.format);
      const feed = await c.startFeed(new Blob([i.content]).stream(), {
        name,
        format: i.format,
        by: by(p),
      });
      await recordAudit(env, 'catalog.feed_started', {
        actor: p,
        target: feed.id,
        detail: { name, format: i.format, ...trail },
      });
      return { done: `Started the feed ${name}`, href: '/catalog', feed };
    }
    case 'cancel_catalog_feed': {
      const { feedId } = input as CatalogWrite['cancel_catalog_feed'];
      const feed = await c.cancelFeed(feedId, by(p));
      if (!feed) throw new Refused(`The catalog has no feed ${feedId}.`);
      if (feed.state !== 'cancelled')
        throw new Refused(`The feed has already finished (${feed.state}).`);
      await recordAudit(env, 'catalog.feed_cancelled', {
        actor: p,
        target: feedId,
        detail: trail,
      });
      return { done: `Cancelled the feed ${feed.name}`, href: '/catalog', feed };
    }
    case 'reindex_catalog': {
      const r = await c.reindex(by(p));
      await recordAudit(env, 'catalog.reindexed', {
        actor: p,
        detail: { queued: r.queued, ...trail },
      });
      return { done: `Queued ${plural(r.queued, 'product')} to publish again`, href: '/catalog' };
    }
    case 'rebuild_catalog_gaps': {
      const r = await c.rebuildGaps(by(p));
      await recordAudit(env, 'catalog.gaps_rebuilt', {
        actor: p,
        detail: { products: r.products, ...trail },
      });
      return { done: `Recounted the gaps of ${plural(r.products, 'product')}`, href: '/catalog' };
    }
  }
  throw new Refused('Unknown action.');
}

/** Saves a type or its next version, as REST does; a refusal is the catalog's reasons. */
export async function putCatalogType(env: Env, p: Principal, type: ProductTypeInput, trail: Trail) {
  const r = await catalog(env).putType(type, by(p));
  if (!r.ok) throw refused('Type refused', r.issues);
  await recordAudit(env, 'catalog.type_saved', {
    actor: p,
    target: r.type.code,
    detail: { version: r.type.version, ...trail },
  });
  return { done: `Saved ${r.type.code} v${r.type.version}`, href: '/catalog', type: r.type };
}

export async function putCatalogChannel(env: Env, p: Principal, channel: Channel, trail: Trail) {
  const r = await catalog(env).putChannel(channel, by(p));
  if (!r.ok) throw refused('Channel refused', r.issues);
  await recordAudit(env, 'catalog.channel_saved', {
    actor: p,
    target: r.channel.code,
    detail: trail,
  });
  return { done: `Saved the channel ${r.channel.code}`, href: '/catalog', channel: r.channel };
}
