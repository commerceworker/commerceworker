import type { ContentType } from '../content-type/content-type';
import { urlPath, urlPatternSlugFields } from '../content-type/content-type';
import type { FieldDefinition } from '../content-type/field';
import { type LocaleConfig, resolveLocalizedValue } from '../locale';
import { parseAbsoluteUrl } from '../rich-text/embed';
import type { EntryFields, LocaleCode } from '../types';

/**
 * Search engine metadata, and the sitemap built from it.
 *
 * An entry's SEO metadata is a field of type `Seo`: a component whose shape is fixed, so the
 * sitemap, the admin and every client know where to find a page's title, description, canonical
 * URL, `noindex` flag and social image without reading the model. Being a field, it is versioned
 * with the draft, published with the entry, localized when the field is, validated like any
 * component and delivered with the entry's other fields. A content type opts in by declaring one.
 */

/** Longest SEO title kept (search engines show about 60 characters; the rest is the editor's). */
export const MAX_SEO_TITLE_LENGTH = 200;
/** Longest SEO description kept (search engines show about 160 characters). */
export const MAX_SEO_DESCRIPTION_LENGTH = 500;
/** Longest canonical URL. */
export const MAX_CANONICAL_URL_LENGTH = 2048;

/** One `Seo` field's value in one locale, as stored and delivered. Every part is optional. */
export interface SeoMetadata {
  /** The page title for search results and the `<title>` element. */
  readonly title?: string;
  /** The meta description. */
  readonly description?: string;
  /**
   * Where the page's canonical copy lives, when not here: a site path (`/guides/setup`) or an
   * absolute `http(s)` URL. A page whose canonical URL is elsewhere is left out of the sitemap.
   */
  readonly canonicalUrl?: string;
  /** Keep the page out of search results, and out of the sitemap. */
  readonly noindex?: boolean;
  /** The social sharing image: a link to an asset, `{ id, linkType: 'Asset' }`. */
  readonly ogImage?: { readonly id: string; readonly linkType: 'Asset' };
}

const nested = (
  apiId: string,
  name: string,
  type: FieldDefinition['type'],
  position: number,
  over: Partial<FieldDefinition> = {},
): FieldDefinition => ({ apiId, name, type, localized: false, required: false, position, ...over });

/**
 * The shape every `Seo` field holds. Validation, references, GraphQL, codegen and the admin read a
 * `Seo` field as a component of these fields, so none of them needs SEO-specific code beyond
 * asking for this list. The canonical URL's form is checked separately (`canonicalUrlIssue`).
 */
export const SEO_FIELDS: readonly FieldDefinition[] = [
  nested('title', 'Title', 'Symbol', 0, { validations: { size: { max: MAX_SEO_TITLE_LENGTH } } }),
  nested('description', 'Description', 'Text', 1, {
    validations: { size: { max: MAX_SEO_DESCRIPTION_LENGTH } },
  }),
  nested('canonicalUrl', 'Canonical URL', 'Symbol', 2, {
    validations: { size: { max: MAX_CANONICAL_URL_LENGTH } },
  }),
  nested('noindex', 'Hide from search engines', 'Boolean', 3),
  nested('ogImage', 'Social image', 'Link', 4, { linkType: 'Asset' }),
];

/** The content type's `Seo` field, if it declares one (it may declare at most one). */
export function seoFieldOf(contentType: Pick<ContentType, 'fields'>): FieldDefinition | undefined {
  return contentType.fields.find((f) => f.type === 'Seo');
}

/**
 * Why a canonical URL is refused, or null when it is a site path (`/…`, not `//…`) or an absolute
 * `http(s)` URL. Anything else (`javascript:`, a relative path) is no URL a crawler can follow.
 */
export function canonicalUrlIssue(value: string): string | null {
  if (value.startsWith('/') && !value.startsWith('//')) {
    return /\s/.test(value) ? 'A canonical path cannot hold spaces' : null;
  }
  const url = parseAbsoluteUrl(value);
  if (url && (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname) return null;
  return 'A canonical URL is a path starting with / or an absolute http(s) URL';
}

/** One locale's URL of a published entry, as the sitemap lists it. */
export interface SitemapUrl {
  /** The site path from the type's URL pattern, e.g. `/blog/hello`. */
  readonly path: string;
  readonly locale: LocaleCode;
}

/** A published entry as the sitemap reads it: only the fields its URLs depend on are needed. */
export interface SitemapSource {
  readonly id: string;
  readonly fields: EntryFields;
}

/**
 * Where the site lives, when the caller knows: its origin (`https://example.com`) and the path it
 * is served under (`/docs`, or `''` at the root). Sitemap paths are relative to it.
 */
export interface SiteLocation {
  readonly origin: string;
  readonly prefix?: string;
}

/** The absolute URL's origin, when `value` is one. */
const originOf = (value: string): string | null => {
  const url = parseAbsoluteUrl(value);
  return url ? `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}` : null;
};

const decoded = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/**
 * A path in one spelling, so two spellings of the same path compare equal: each segment
 * percent-encoded as `urlPath` encodes a slug (`/über` and `/%C3%BCber` agree), and one trailing
 * slash dropped (`/guide/` is `/guide`).
 */
export function normalizeSitePath(path: string): string {
  const encoded = path
    .split('/')
    .map((segment) => encodeURIComponent(decoded(segment)))
    .join('/');
  return encoded.length > 1 && encoded.endsWith('/') ? encoded.slice(0, -1) : encoded;
}

/**
 * The site path a canonical URL names (without query or fragment), or null when it is on another
 * site. A path (`/guide/setup`) is a site path already, like the ones URL patterns make. An
 * absolute URL is judged against `site` when known: another origin, or a path outside the site's
 * prefix, is elsewhere; the prefix is taken off the rest. Without `site` it is judged by its path.
 */
function canonicalSitePath(value: string, site?: SiteLocation): string | null {
  if (value.startsWith('/')) return normalizeSitePath(value.replace(/[?#].*$/, ''));
  const url = parseAbsoluteUrl(value);
  if (!url) return null;
  const path = normalizeSitePath(url.pathname);
  if (!site) return path;
  if (originOf(value) !== site.origin) return null;
  const prefix = normalizeSitePath(site.prefix ?? '');
  if (!prefix || prefix === '/') return path;
  if (path === prefix) return '/';
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : null;
}

/**
 * The fields a type's sitemap URLs are computed from: the slugs its URL pattern names and its
 * `Seo` field. A store reads only these from each published entry, not the whole body.
 */
export function sitemapFieldsOf(contentType: Pick<ContentType, 'urlPattern' | 'fields'>): string[] {
  if (!contentType.urlPattern) return [];
  const seo = seoFieldOf(contentType);
  return [
    ...new Set([...urlPatternSlugFields(contentType.urlPattern), ...(seo ? [seo.apiId] : [])]),
  ];
}

/**
 * A published entry's URLs on the site, one per locale it lives at, for the sitemap.
 *
 * Locales: when the pattern names `{locale}` or a localized slug, every locale of the space that
 * resolves the pattern (following the fallback chain, as Delivery does for that locale); else
 * only the default locale, since every locale shares the one path. Paths two locales share are
 * listed once, under the first locale. A locale is left out when its `Seo` value says `noindex`,
 * or when it names a canonical URL that is not this path (the page is a copy; the sitemap lists
 * canonical pages only). Both sides are compared in one spelling (`normalizeSitePath`); `site`,
 * when known, also refuses an absolute canonical on another site or outside its path prefix.
 */
export function entrySitemapUrls(
  contentType: Pick<ContentType, 'urlPattern' | 'fields'>,
  entry: SitemapSource,
  locales: LocaleConfig,
  site?: SiteLocation,
): SitemapUrl[] {
  const pattern = contentType.urlPattern;
  if (!pattern) return [];
  const named = urlPatternSlugFields(pattern);
  const perLocale =
    pattern.includes('{locale}') ||
    contentType.fields.some((f) => f.localized && named.includes(f.apiId));
  const seo = seoFieldOf(contentType);
  const urls: SitemapUrl[] = [];
  const seen = new Set<string>();
  for (const locale of perLocale ? locales.locales : [locales.defaultLocale]) {
    // The pattern's slugs as this locale reads them, under the locale `urlPath` looks in.
    const view: Record<string, Record<string, unknown>> = {};
    for (const name of named) {
      const value = resolveLocalizedValue(entry.fields[name] ?? {}, locales, locale);
      if (value !== undefined) view[name] = { [locale]: value };
    }
    const path = urlPath(pattern, { id: entry.id, fields: view }, locale);
    if (path === null || seen.has(path)) continue;
    const meta = seo
      ? (resolveLocalizedValue(entry.fields[seo.apiId] ?? {}, locales, locale) as
          | SeoMetadata
          | undefined)
      : undefined;
    if (meta?.noindex === true) continue;
    const canonical = typeof meta?.canonicalUrl === 'string' ? meta.canonicalUrl : '';
    if (canonical && canonicalSitePath(canonical, site) !== normalizeSitePath(path)) continue;
    seen.add(path);
    urls.push({ path, locale });
  }
  return urls;
}

/**
 * The most URLs one sitemap file may list, and the most sitemaps one index may (the sitemaps.org
 * protocol). A space past it is served as a sitemap index of pages.
 */
export const SITEMAP_MAX_URLS = 50_000;

/**
 * How many entries one sitemap page holds. Each entry lists at most one URL per locale, so a
 * page stays under {@link SITEMAP_MAX_URLS} however many locales the space has; capped at
 * `ceiling` so one page's read stays small.
 */
export function sitemapPageSize(localeCount: number, ceiling = 5_000): number {
  return Math.max(1, Math.min(ceiling, Math.floor(SITEMAP_MAX_URLS / Math.max(1, localeCount))));
}
