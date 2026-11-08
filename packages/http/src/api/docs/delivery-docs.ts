import { z } from 'zod';
import { doc } from './openapi';
import { deliveredCollection } from './schemas/asset-collections';
import { deliveredAsset, deliveredAssetPage, deliveredAssetSearchPage } from './schemas/assets';
import { deliveredRouteList } from './schemas/content-types';
import { publishedEntry, publishedEntryList, searchHits } from './schemas/entries';
import { deliveredMenu, deliveredMenuList } from './schemas/menus';
import { deliveredRedirectList, deliveredRedirectMatch } from './schemas/redirects';
import { deliveredSitemapPage } from './schemas/seo';
import {
  deliveredConcept,
  deliveredConceptList,
  deliveredTag,
  deliveredTagList,
} from './schemas/taxonomy';

/**
 * The Delivery routes' OpenAPI descriptions, kept apart from the routes themselves so the
 * delivery Worker, which serves the routes but no API docs, never bundles zod, hono-openapi or
 * the response schemas (about 40% of its script). The api mounts the routes with these
 * (`deliveryRoutes(deps, describeDelivery)`), so its OpenAPI document is unchanged.
 */
const DOCS = {
  search: () =>
    doc('Delivery', 'Search published content', {
      ok: searchHits,
      description:
        'Hybrid search by default: vector nearest-neighbour search + a full-text index, fused with Reciprocal Rank Fusion.',
      query: {
        q: 'Search query',
        mode: 'hybrid (default) | semantic | lexical',
        top_k: 'Max hits (default 10)',
      },
    }),
  listEntries: () =>
    doc('Delivery', 'List published entries', {
      ok: publishedEntryList,
      query: {
        content_type: 'Filter by content type apiId',
        locale: 'Resolve fields for one locale',
        include: 'Reference resolution depth',
        where:
          'AND/OR groups of predicates as JSON, e.g. {"or":[{"field":"fields.title","op":"startsWith",' +
          '"value":"A"},{"field":"fields.views","op":"between","value":[10,20]}]} ' +
          '(at most 4 groups deep and 20 predicates)',
        links_to_entry: 'Entries with a link to this entry id in any field (a,b: to any of them)',
        'fields.<field>[ref]':
          'Entries whose link field links to this entry id ([refIn]=a,b for any of several)',
        'metadata.tags.slug':
          'Entries carrying the tag with this slug (also [in]=a,b, [ne], [nin]; ' +
          'metadata.concepts.slug for concepts, metadata.tags / metadata.concepts for ids)',
      },
    }),
  getEntry: () =>
    doc('Delivery', 'Get a published entry', {
      ok: publishedEntry,
      query: { locale: 'Resolve fields for one locale', include: 'Reference resolution depth' },
    }),
  getSingleton: () =>
    doc('Delivery', 'Get a singleton’s entry', {
      ok: publishedEntry,
      description:
        'The published entry of a singleton content type (one that holds at most one entry: ' +
        'site settings, a home page), by the type’s apiId, so a front end needs no entry id. ' +
        '404 when the type is not a singleton or its entry is not published.',
      query: { locale: 'Resolve fields for one locale', include: 'Reference resolution depth' },
    }),
  listAssets: () =>
    doc('Delivery', 'List or search published assets', {
      ok: z.union([deliveredAssetPage, deliveredAssetSearchPage]),
      description:
        'In publish order. URLs are on the media origin and immutable (the file version is in ' +
        'them). Page with the response’s nextCursor. With q, a hybrid search (full text and ' +
        'semantic, fused by rank) over published assets only, best match first, with facet ' +
        'counts by kind, tag and folder; limit applies, paging does not. A search needs the ' +
        'search:read scope as well as delivery:read (403 without it).',
      query: {
        q: 'Search text (1–256 characters): file name, title, caption, alt text, tags, document text',
        limit: 'Page size',
        cursor: 'nextCursor from the previous page',
        skip: 'Offset (without a cursor)',
        kind: 'image | video | audio | document | other',
        tag: 'A taxonomy tag id',
        folder: 'A folder id, or root for assets in no folder',
        locale: 'Resolve title, description and alt text for one locale',
      },
    }),
  getAsset: () =>
    doc('Delivery', 'Get a published asset', {
      ok: deliveredAsset,
      query: { locale: 'Resolve title, description and alt text for one locale' },
    }),
  getCollection: () =>
    doc('Delivery', 'Get a collection’s published assets', {
      ok: deliveredCollection,
      description:
        'Its name and its published members in the collection’s order, in the delivered asset ' +
        'shape (drafts and archived members are left out). Page with nextCursor.',
      query: {
        limit: 'Page size',
        cursor: 'nextCursor from the previous page',
        locale: 'Resolve title, description and alt text for one locale',
      },
    }),
  listTags: () =>
    doc('Delivery', 'List tags', {
      ok: deliveredTagList,
      description:
        'Every tag, by slug, with its label, description and how many published entries carry ' +
        'it (in all, and per content type). A key limited to some content types counts only ' +
        'those. Cached like any delivery read, and purged when a tag changes or an entry publishes.',
      query: {
        locale: 'Resolve labels for one locale (with the space’s fallbacks)',
        content_type: 'Count published entries of this content type only',
      },
    }),
  getTag: () =>
    doc('Delivery', 'Get a tag by slug', {
      ok: deliveredTag,
      description: 'As in the list; 404 when no tag has the slug.',
      query: {
        locale: 'Resolve labels for one locale (with the space’s fallbacks)',
        content_type: 'Count published entries of this content type only',
      },
    }),
  listConcepts: () =>
    doc('Delivery', 'List concepts', {
      ok: deliveredConceptList,
      description:
        'Every concept (of one scheme with scheme), by slug, with its label, description, ' +
        'parent and published usage counts, as for tags.',
      query: {
        scheme: 'Only this scheme’s concepts',
        locale: 'Resolve labels for one locale (with the space’s fallbacks)',
        content_type: 'Count published entries of this content type only',
      },
    }),
  getConcept: () =>
    doc('Delivery', 'Get a concept by slug', {
      ok: deliveredConcept,
      description:
        'A slug is unique within a scheme: without scheme, a slug two schemes share is a 409. ' +
        '404 when no concept has it.',
      query: {
        scheme: 'The concept’s scheme',
        locale: 'Resolve labels for one locale (with the space’s fallbacks)',
        content_type: 'Count published entries of this content type only',
      },
    }),
  listRedirects: () =>
    doc('Delivery', 'List the redirects', {
      ok: deliveredRedirectList,
      description:
        'Every enabled redirect, by source: the set a front end or an edge Worker applies ' +
        'itself (commerceworker serves no site). Match exact sources first, then the most ' +
        'specific pattern, as `redirects/resolve` does; the SDKs ship that matcher.',
    }),
  listMenus: () =>
    doc('Delivery', 'List the menus', {
      ok: deliveredMenuList,
      description: 'Every navigation menu’s handle and name, by handle: which ones to ask for.',
    }),
  getMenu: () =>
    doc('Delivery', 'Get a menu, resolved', {
      ok: deliveredMenu,
      description:
        'One menu as a tree ready to render. Entry links resolve to the published entry’s path ' +
        '(its type’s URL pattern) and label (its display field, unless the item has its own); ' +
        'term links to the term’s label and slug. An item whose link doesn’t resolve (the ' +
        'entry unpublished or deleted, no URL in the locale, a type the key can’t read) is ' +
        'dropped and its children take its place. 404 when no menu has the handle.',
      query: { locale: 'Labels, slugs and paths in this locale (with the space’s fallbacks)' },
    }),
  listRoutes: () =>
    doc('Delivery', 'List the site routes', {
      ok: deliveredRouteList,
      description:
        'Where each published content type’s entries live on the site (its `urlPattern`), for a ' +
        'front end that routes pages from the content model. Only published types that have ' +
        'one, by content type; a key limited to some content types sees only theirs. A ' +
        'pattern’s placeholders are `{id}`, `{locale}` or one of the type’s Slug fields.',
    }),
  getSitemap: () =>
    doc('Delivery', 'Get a page of the sitemap', {
      ok: deliveredSitemapPage,
      description:
        'The published entries of every published content type with a URL pattern, by entry ' +
        'id, each with its paths per locale and `lastmod` (when its live version was ' +
        'published). Entries whose Seo field says `noindex`, or names a canonical URL that ' +
        'isn’t their own path, are left out. Page with `next`; a key limited to some content ' +
        'types sees only theirs. For crawlers, serve `sitemap.xml`.',
      query: {
        from: 'next from the previous page',
        limit: 'Entries per page, 1..5000 (default 1000)',
        base: 'The site’s URL: an entry whose absolute canonical URL is on another site, or outside its path, is left out',
      },
    }),
  getSitemapXml: () =>
    doc('Delivery', 'Get the XML sitemap', {
      okDescription:
        'application/xml: a sitemaps.org urlset of absolute URLs (`base` + path) with lastmod ' +
        'and hreflang alternates, or, past one file’s 50,000 URLs, a sitemap index of pages at ' +
        '`<base>/sitemap.xml?page=…`. Serve it at the site’s own /sitemap.xml by proxying here ' +
        'with the query string.',
      query: {
        base: 'Required: the site’s absolute URL, e.g. https://www.example.com',
        page: 'One page of a sitemap index (as the index names it)',
      },
    }),
  resolveRedirect: () =>
    doc('Delivery', 'Resolve a path against the redirects', {
      ok: deliveredRedirectMatch,
      description:
        'The redirect a path takes, with its status and the location to send the reader to ' +
        '(captures filled in; the request’s query kept when the destination has none). 404 ' +
        'when nothing redirects it.',
      query: {
        path: 'The request path, with or without its query string',
        locale:
          'The request’s locale: its own redirects apply as well as the ones for every locale',
      },
    }),
  live: () =>
    doc('Delivery', 'Live Content API (SSE)', {
      okDescription: 'text/event-stream of published-content domain events for this scope',
      query: { types: 'Comma-separated event-type filter, e.g. entry.published' },
    }),
  transform: () =>
    doc('Delivery', 'Resolve a transformed image URL (deprecated)', {
      status: 301,
      okDescription:
        'Redirects (permanently, cacheably) to the media URL of the next width step up from w, ' +
        'or of the named rendition. Use the asset’s srcset and renditions instead.',
      query: {
        w: 'Width: the next ladder step (320, 640, 960, 1280, 1920, 2560) at or above it',
        rendition: 'A rendition name',
      },
    }),
} as const;

export type DeliveryDocKey = keyof typeof DOCS;

/** Describes a Delivery route for the api's OpenAPI document. */
export const describeDelivery = (key: DeliveryDocKey) => DOCS[key]();
