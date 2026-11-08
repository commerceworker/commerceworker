/**
 * Where the marketing site lives and what it links to. The site is static, served from the
 * commerceworker.com zone (docs/operations.md, the host table), so these are constants rather than
 * environment: a build can't point the site's canonical URLs or CTAs anywhere else.
 */
import { joinCanonical } from './canonical-url';

export const SITE_ORIGIN = 'https://commerceworker.com';
export const DOCS_ORIGIN = 'https://docs.commerceworker.com';
export const APP_ORIGIN = 'https://app.commerceworker.com';

export const LOCALES = ['en', 'es'] as const;
export type Locale = (typeof LOCALES)[number];

/** The site path for `path` in `locale`: English at the root, Spanish under /es/. */
export function localePath(locale: Locale, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return locale === 'en' ? p : `/es${p === '/' ? '/' : p}`;
}

/** A link into the docs site. */
export const docsUrl = (path: string) => joinCanonical(DOCS_ORIGIN, path);

export type MetaTag = { name: string; content: string } | { property: string; content: string };

/** The description, Open Graph and Twitter tags for one page. */
export function socialMeta(opts: {
  title: string;
  description: string;
  pathname: string;
}): MetaTag[] {
  const url = joinCanonical(SITE_ORIGIN, opts.pathname);
  const image = joinCanonical(SITE_ORIGIN, '/og-image.svg');
  return [
    { name: 'description', content: opts.description },
    { property: 'og:title', content: opts.title },
    { property: 'og:description', content: opts.description },
    { property: 'og:type', content: 'website' },
    { property: 'og:url', content: url },
    { property: 'og:image', content: image },
    { name: 'twitter:card', content: 'summary_large_image' },
    { name: 'twitter:title', content: opts.title },
    { name: 'twitter:description', content: opts.description },
    { name: 'twitter:image', content: image },
  ];
}
