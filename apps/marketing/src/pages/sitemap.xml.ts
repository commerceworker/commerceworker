/**
 * The sitemap: every page in both locales, each naming its alternates, so a search engine serves
 * the reader's language. Static: written at build.
 */
import type { APIRoute } from 'astro';
import { joinCanonical } from '../lib/canonical-url';
import { LOCALES, localePath, SITE_ORIGIN } from '../lib/site';

export const PAGES = ['/', '/features/'] as const;

export const GET: APIRoute = () => {
  const url = (locale: (typeof LOCALES)[number], path: string) =>
    joinCanonical(SITE_ORIGIN, localePath(locale, path));
  const entries = PAGES.flatMap((path) =>
    LOCALES.map(
      (locale) =>
        `  <url>\n    <loc>${url(locale, path)}</loc>\n${LOCALES.map(
          (alt) => `    <xhtml:link rel="alternate" hreflang="${alt}" href="${url(alt, path)}"/>`,
        ).join('\n')}\n  </url>`,
    ),
  );
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries.join('\n')}\n</urlset>\n`;
  return new Response(body, { headers: { 'content-type': 'application/xml' } });
};
