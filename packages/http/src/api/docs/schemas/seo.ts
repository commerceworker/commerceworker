import { z } from 'zod';

// --- SEO and the sitemap --------------------------------------------------------

/** One locale's URL of an entry in the sitemap. */
export const sitemapUrl = z.object({
  path: z.string().describe('The site path from the type’s URL pattern, e.g. /blog/hello'),
  locale: z.string(),
});

export const deliveredSitemapEntry = z.object({
  entryId: z.string(),
  contentType: z.string().describe('Content type apiId'),
  lastmod: z.iso.datetime().describe('When the live version was published'),
  urls: z
    .array(sitemapUrl)
    .min(1)
    .describe('One per locale the entry lives at; alternates of each other (hreflang)'),
});

export const deliveredSitemapPage = z.object({
  items: z.array(deliveredSitemapEntry),
  next: z.string().nullable().describe('Pass as from for the next page; null on the last'),
});
