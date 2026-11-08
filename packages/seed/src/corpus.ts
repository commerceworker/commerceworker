import { logger } from '@commerceworker/telemetry';
import {
  assetLink,
  CITIES,
  ensurePublishedEntry,
  entryLink,
  isoDate,
  localized,
  pick,
  prose,
  richTextDoc,
  richTextGuide,
  richTextKitchenSink,
  seedGeneratedEntries,
  statusFor,
  WORDS,
} from './helpers';
import type { TaxonomySeed } from './taxonomy';
import type { SeedRun } from './types';

export interface CorpusSeed {
  readonly articleIds: readonly string[];
  readonly productIds: readonly string[];
  /** Ids of generated entries left as drafts (scheduling/publish demos). */
  readonly draftArticleIds: readonly string[];
  /** Ids of published generated entries (scheduled-unpublish demos). */
  readonly publishedArticleIds: readonly string[];
}

export type CorpusVolumes = ReturnType<typeof volumes>;

/** Generated-type volumes; the bulk types scale linearly for benchmarking. */
export function volumes(scale: number) {
  return {
    authors: 24,
    categories: 18,
    articles: 250 * scale,
    products: 80 * scale,
    events: 60 * scale,
    recipes: 50 * scale,
    pages: 30,
    landingPages: 15,
  };
}

/**
 * The entry corpus: a small curated showcase (stable titles the docs and
 * e2e flows can rely on) plus a deterministic generated dataset sized by
 * `scale`. Ordering respects publish-time referential integrity: link targets
 * (categories, authors, assets, products) are seeded before their referrers.
 */
export async function seedCorpus(
  run: SeedRun,
  assetIds: readonly string[],
  taxonomy: TaxonomySeed,
  vol: CorpusVolumes = volumes(run.scale),
): Promise<CorpusSeed> {
  const { locale, hasDe } = run;
  const asset = (i: number) => (assetIds.length ? assetLink(pick(assetIds, i)) : undefined);

  // --- categories (tree: roots first so children can reference real ids) ----
  const CATEGORY_ROOTS = ['Engineering', 'Product', 'Business'] as const;
  const rootCategoryIds = await seedGeneratedEntries(
    run,
    'category',
    'name',
    CATEGORY_ROOTS.length,
    (i) => ({
      matchValue: CATEGORY_ROOTS[i]!,
      status: 'published',
      fields: {
        name: localized(locale, CATEGORY_ROOTS[i]!),
        slug: localized(locale, CATEGORY_ROOTS[i]!.toLowerCase()),
      },
    }),
  );
  const childCategoryIds = await seedGeneratedEntries(
    run,
    'category',
    'name',
    vol.categories - CATEGORY_ROOTS.length,
    (i) => {
      const name = `${pick(CATEGORY_ROOTS, i)} / ${pick(WORDS.topics, i)}`;
      return {
        matchValue: name,
        status: 'published',
        fields: {
          name: localized(locale, name),
          slug: localized(locale, name.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
          parent: localized(locale, entryLink(pick(rootCategoryIds, i))),
        },
      };
    },
  );
  const categoryIds = [...rootCategoryIds, ...childCategoryIds];

  // --- authors --------------------------------------------------------------
  const authorIds = await seedGeneratedEntries(run, 'author', 'name', vol.authors, (i) => {
    const first = pick(['Jordan', 'Alex', 'Sam', 'Riley', 'Casey', 'Morgan'] as const, i);
    const last = pick(
      ['Lee', 'Kim', 'Rivera', 'Patel', 'Nguyen', 'Okafor', 'Sørensen', 'Haddad'] as const,
      i * 5 + 1,
    );
    const name = `${first} ${last}`;
    return {
      matchValue: name,
      status: 'published',
      fields: {
        name: localized(locale, name),
        role: localized(
          locale,
          pick(
            [
              'Staff writer',
              'Editor',
              'Guest author',
              'Developer advocate',
              'Contributor',
            ] as const,
            i,
          ),
        ),
        bio: localized(
          locale,
          `${name} writes about ${pick(WORDS.topics, i)} and ${pick(WORDS.topics, i + 3)}, ` +
            `mostly for ${pick(WORDS.audiences, i)}. Based in ${pick(CITIES, i).name}.`,
          hasDe
            ? {
                'de-DE': `${name} schreibt über ${pick(WORDS.topics, i)} — aus ${pick(CITIES, i).name}.`,
              }
            : undefined,
        ),
      },
    };
  });

  // --- products -------------------------------------------------------------
  const productIds = await seedGeneratedEntries(run, 'product', 'name', vol.products, (i) => {
    const line = pick(
      ['Workspace', 'Toolkit', 'Console', 'Bundle', 'Kit', 'Studio', 'Field Kit'] as const,
      i,
    );
    const name = `${pick(WORDS.adjectives, i)} ${line} ${i}`;
    const price = 9 + (i % 40) * 10 + (i % 3) * 0.99;
    return {
      matchValue: name,
      status: statusFor(i),
      fields: {
        name: localized(
          locale,
          name,
          hasDe && i % 2 === 0 ? { 'de-DE': `${name} (DE-Ausgabe)` } : undefined,
        ),
        description: localized(
          locale,
          `The ${line.toLowerCase()} built for ${pick(WORDS.audiences, i)} who care about ` +
            `${pick(WORDS.topics, i)}. Designed to ${pick(WORDS.outcomes, i)}.`,
        ),
        price: localized(locale, Math.round(price * 100) / 100),
        inStock: localized(locale, i % 4 !== 0),
        sku: localized(locale, `${pick(['CW', 'PR', 'KT'] as const, i)}-${String(1000 + i)}`),
        images: localized(locale, [asset(i), asset(i + 1)].filter(Boolean)),
        specs: localized(locale, {
          weightKg: (i % 5) + 0.5,
          dimensions: { w: 10 + (i % 30), h: 20 + (i % 12), d: 5 + (i % 4) },
          materials: [
            pick(['aluminium', 'walnut', 'recycled-abs', 'steel', 'cork'] as const, i),
            pick(['felt', 'glass', 'bamboo'] as const, i + 1),
          ],
          warrantyYears: (i % 3) + 1,
          madeIn: pick(CITIES, i).name,
        }),
        availability: localized(
          locale,
          pick(['in-stock', 'backorder', 'discontinued'] as const, i % 9 === 0 ? 2 : i % 2),
        ),
      },
      patch: { price: localized(locale, Math.round((price + 5) * 100) / 100) },
    };
  });

  // --- articles (the big block; carries taxonomy metadata + all links) ------
  const now = run.ctx.clock.now();
  const draftArticleIds: string[] = [];
  const articleIds = await seedGeneratedEntries(run, 'article', 'title', vol.articles, (i) => {
    const title = `${pick(WORDS.verbs, i)} ${pick(WORDS.topics, i)} — part ${Math.floor(i / WORDS.topics.length) + 1}`;
    const status = statusFor(i);
    // Every 4th entry carries taxonomy metadata so tag/concept filters return
    // meaningful result sets at any scale.
    const withMeta = i % 4 === 1;
    return {
      matchValue: title,
      status,
      metadata: withMeta
        ? {
            tags: [pick(taxonomy.tagIds, i), pick(taxonomy.tagIds, i + 3)],
            concepts: [pick(taxonomy.conceptIds, i)],
          }
        : undefined,
      fields: {
        title: localized(
          locale,
          title,
          hasDe && i % 2 === 0
            ? {
                'de-DE': `${pick(WORDS.topics, i)} verstehen — Teil ${Math.floor(i / WORDS.topics.length) + 1}`,
              }
            : undefined,
        ),
        body: localized(locale, prose(i)),
        summary: localized(
          locale,
          `How ${pick(WORDS.audiences, i)} ${pick(WORDS.outcomes, i)} — field notes on ${pick(WORDS.topics, i)}.`,
          hasDe && i % 2 === 0
            ? { 'de-DE': `Praxisnotizen zu ${pick(WORDS.topics, i)}.` }
            : undefined,
        ),
        author: localized(locale, entryLink(pick(authorIds, i))),
        views: localized(locale, (i * 137) % 25000),
        featured: localized(locale, i % 6 === 0),
        // Published dates spread over the past year relative to the clock, so
        // date-range filters and "recent" sorts always have fresh material.
        publishedDate: localized(locale, isoDate(now, -((i * 3) % 365), 9)),
        keywords: localized(
          locale,
          [pick(WORDS.topics, i), pick(WORDS.topics, i + 4), pick(WORDS.audiences, i)].slice(
            0,
            (i % 3) + 1,
          ),
        ),
        ...(asset(i) ? { heroImage: localized(locale, asset(i)) } : {}),
        // A slice of articles without category exercises absent-optional-field
        // rendering and `exists` filters.
        ...(i % 13 === 0 ? {} : { category: localized(locale, entryLink(pick(categoryIds, i))) }),
        readingTime: localized(locale, (i % 25) + 2),
      },
      patch: {
        summary: localized(
          locale,
          `Revised: what ${pick(WORDS.audiences, i)} learned about ${pick(WORDS.topics, i)} in production.`,
        ),
      },
    };
  });
  const publishedArticleIds: string[] = [];
  for (let i = 0; i < vol.articles; i++) {
    const id = articleIds[i];
    if (!id) continue;
    if (statusFor(i) === 'draft') draftArticleIds.push(id);
    else if (statusFor(i) === 'published') publishedArticleIds.push(id);
  }

  // --- events ---------------------------------------------------------------
  await seedGeneratedEntries(run, 'event', 'title', vol.events, (i) => {
    const city = pick(CITIES, i);
    const kind = pick(['Summit', 'Meetup', 'Workshop', 'Webinar', 'Office hours'] as const, i);
    const title = `${city.name} ${kind}: ${pick(WORDS.topics, i)}`;
    // Events spread from 60 days back to ~10 months out relative to the clock,
    // so past/upcoming filters both return material on any demo day.
    const dayOffset = -60 + ((i * 11) % 360);
    return {
      matchValue: title,
      status: statusFor(i),
      fields: {
        title: localized(
          locale,
          title,
          hasDe && i % 2 === 0
            ? { 'de-DE': `${city.name} ${kind}: ${pick(WORDS.topics, i)} (DE)` }
            : undefined,
        ),
        startDate: localized(locale, isoDate(now, dayOffset, 18)),
        endDate: localized(locale, isoDate(now, dayOffset, 21)),
        venue: localized(locale, { lat: city.lat, lon: city.lon }),
        capacity: localized(locale, 50 + (i % 20) * 25),
        status: localized(
          locale,
          pick(['scheduled', 'sold-out', 'cancelled'] as const, i % 11 === 0 ? 2 : i % 2),
        ),
        speakers: localized(locale, [
          entryLink(pick(authorIds, i)),
          entryLink(pick(authorIds, i + 5)),
          ...(i % 3 === 0 ? [entryLink(pick(authorIds, i + 11))] : []),
        ]),
      },
      patch: { capacity: localized(locale, 50 + (i % 20) * 25 + 10) },
    };
  });

  // --- recipes --------------------------------------------------------------
  await seedGeneratedEntries(run, 'recipe', 'name', vol.recipes, (i) => {
    const method = pick(
      ['Roasted', 'Charred', 'Braised', 'Fresh', 'Smoked', 'Pickled'] as const,
      i,
    );
    const base = pick(
      ['squash', 'salmon', 'greens', 'noodles', 'flatbread', 'mushrooms', 'citrus'] as const,
      i,
    );
    const name = `${method} ${base} No. ${i}`;
    return {
      matchValue: name,
      status: statusFor(i),
      fields: {
        name: localized(locale, name),
        instructions: localized(
          locale,
          richTextGuide(
            name,
            [
              `Prep the ${base} and pat dry.`,
              `${method === 'Fresh' ? 'Dress' : method.replace(/ed$/, '')} over medium-high heat for ${8 + (i % 10)} minutes.`,
              `Season, rest for ${2 + (i % 4)} minutes, and serve warm.`,
            ],
            i,
          ),
          hasDe && i % 3 === 0
            ? { 'de-DE': richTextDoc(`${name} — Zubereitung in drei Schritten.`) }
            : undefined,
        ),
        nutrition: localized(locale, {
          calories: 180 + (i % 12) * 40,
          protein: 6 + (i % 9),
          carbs: 12 + (i % 20),
          fat: 4 + (i % 11),
          allergens: i % 4 === 0 ? ['gluten'] : [],
        }),
        servings: localized(locale, (i % 6) + 2),
        relatedProducts: localized(locale, [
          entryLink(pick(productIds, i)),
          ...(i % 2 === 0 ? [entryLink(pick(productIds, i + 7))] : []),
        ]),
      },
      patch: { servings: localized(locale, (i % 6) + 4) },
    };
  });

  // --- curated pages (stable) + generated filler ----------------------------
  const pageSeeds = [
    { title: 'Home', slug: 'home', body: 'Welcome to the sample site.' },
    { title: 'About us', slug: 'about', body: 'commerceworker is an API-first headless CMS.' },
    {
      title: 'Documentation',
      slug: 'docs',
      body: 'The commerceworker documentation covers modeling, publishing and delivery.',
    },
  ] as const;
  const pageIds: string[] = [];
  for (const p of pageSeeds) {
    const result = await ensurePublishedEntry(run, 'page', 'title', p.title, {
      title: localized(
        locale,
        p.title,
        hasDe && p.title === 'Home' ? { 'de-DE': 'Startseite' } : undefined,
      ),
      slug: localized(locale, p.slug),
      body: localized(locale, richTextDoc(p.body)),
      seoDescription: localized(locale, `${p.title}: a sample page.`),
    });
    pageIds.push(result.id);
  }
  const generatedPages = await seedGeneratedEntries(run, 'page', 'title', vol.pages, (i) => {
    const title = `${pick(WORDS.adjectives, i)} ${pick(WORDS.topics, i)} guide`;
    return {
      matchValue: title,
      status: statusFor(i),
      fields: {
        title: localized(
          locale,
          title,
          hasDe && i % 2 === 0 ? { 'de-DE': `Leitfaden: ${pick(WORDS.topics, i)}` } : undefined,
        ),
        slug: localized(locale, `guide-${i}`),
        body: localized(
          locale,
          richTextGuide(
            title,
            [
              `Audit how your team handles ${pick(WORDS.topics, i)} today.`,
              'Model the target state as content types, not documents.',
              'Migrate one environment, measure, then roll forward.',
            ],
            i,
          ),
        ),
        seoDescription: localized(
          locale,
          `A practical guide to ${pick(WORDS.topics, i)} for ${pick(WORDS.audiences, i)}.`,
        ),
      },
      patch: { seoDescription: localized(locale, `Guide #${i} (revised).`) },
    };
  });
  pageIds.push(...generatedPages);

  // --- landing pages (kitchen-sink rich text on the first one) --------------
  await seedGeneratedEntries(run, 'landingPage', 'title', vol.landingPages, (i) => {
    const title = i === 0 ? 'Everything showcase' : `${pick(WORDS.adjectives, i)} launch ${i}`;
    const body =
      i === 0 && articleIds[1] && assetIds[0]
        ? richTextKitchenSink(articleIds[1], assetIds[0])
        : richTextGuide(
            `${title} — campaign brief`,
            [
              `Lead with the ${pick(WORDS.topics, i)} story.`,
              `Route sign-ups to the ${pick(WORDS.audiences, i)} nurture track.`,
            ],
            i,
          );
    return {
      matchValue: title,
      status: i === 0 ? 'published' : statusFor(i),
      fields: {
        title: localized(locale, title),
        slug: localized(locale, i === 0 ? 'showcase' : `launch-${i}`),
        body: localized(locale, body),
        sections: localized(locale, [
          entryLink(pick(articleIds, i * 2 + 1)),
          entryLink(pick(articleIds, i * 3 + 2)),
          entryLink(pick(pageIds, i)),
        ]),
        ...(asset(i) ? { hero: localized(locale, asset(i)) } : {}),
        // The same page as blocks: a hero, a section of copy, a call to
        // action. No `_key`s here: the server assigns them on create.
        blocks: localized(locale, [
          {
            _type: 'hero',
            heading: title,
            subheading: `Everything ${pick(WORDS.audiences, i)} need for ${pick(WORDS.topics, i)}.`,
            ...(asset(i) ? { image: asset(i) } : {}),
          },
          {
            _type: 'richText',
            body: richTextGuide(
              `Why ${pick(WORDS.topics, i)}`,
              ['Start small.', 'Ship weekly.'],
              i,
            ),
          },
          {
            _type: 'callToAction',
            label: 'Read the guide',
            target: entryLink(pick(pageIds, i)),
          },
        ]),
      },
      patch: {},
    };
  });

  logger.info(
    { articles: vol.articles, products: vol.products, events: vol.events, recipes: vol.recipes },
    'seed: corpus ensured',
  );
  return { articleIds, productIds, draftArticleIds, publishedArticleIds };
}
