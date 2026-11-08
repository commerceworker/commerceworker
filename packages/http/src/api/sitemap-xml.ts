import type { DeliveredSitemapEntry, SitemapFile } from '@commerceworker/application';
import { ValidationError } from '@commerceworker/domain';

/**
 * The sitemap as crawlers read it: the sitemaps.org XML protocol, with `hreflang` alternates for
 * an entry listed in several locales. A protocol format, not content: every value in it is a URL
 * or a date, escaped. Kept free of the docs stack, since the delivery Worker serves it.
 */

const xml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;',
  );

/**
 * The site's base URL from `?base=`: an absolute http(s) URL, kept with any path prefix (a site
 * served under `/docs`) and without a trailing slash, its origin, and that path prefix. Refused otherwise: a sitemap
 * lists absolute URLs, and commerceworker serves no site to take them from.
 */
export function sitemapBase(raw: string | undefined): {
  base: string;
  origin: string;
  prefix: string;
} {
  let url: URL | undefined;
  try {
    url = raw ? new URL(raw) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.search || url.hash) {
    throw new ValidationError([
      {
        field: 'base',
        message: 'base is the site’s absolute http(s) URL, e.g. https://www.example.com',
      },
    ]);
  }
  const prefix = url.pathname.replace(/\/+$/, '');
  return { base: `${url.origin}${prefix}`, origin: url.origin, prefix };
}

const urlset = (items: readonly DeliveredSitemapEntry[], base: string): string => {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
  ];
  for (const entry of items) {
    const alternates =
      entry.urls.length > 1
        ? entry.urls.map(
            (u) =>
              `<xhtml:link rel="alternate" hreflang="${xml(u.locale)}" href="${xml(base + u.path)}"/>`,
          )
        : [];
    for (const u of entry.urls) {
      out.push(
        `<url><loc>${xml(base + u.path)}</loc><lastmod>${xml(entry.lastmod)}</lastmod>${alternates.join('')}</url>`,
      );
    }
  }
  out.push('</urlset>');
  return `${out.join('\n')}\n`;
};

const sitemapIndex = (pages: readonly string[], base: string): string => {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...pages.map(
      (page) =>
        `<sitemap><loc>${xml(`${base}/sitemap.xml?page=${encodeURIComponent(page)}`)}</loc></sitemap>`,
    ),
    '</sitemapindex>',
  ];
  return `${out.join('\n')}\n`;
};

/**
 * One sitemap file as XML. An index names its pages at `<base>/sitemap.xml?page=<range token>`:
 * the site serves its sitemap there by proxying to Delivery's `sitemap.xml` with the query.
 */
export function renderSitemapXml(file: SitemapFile, base: string): string {
  return file.kind === 'index' ? sitemapIndex(file.pages, base) : urlset(file.items, base);
}
