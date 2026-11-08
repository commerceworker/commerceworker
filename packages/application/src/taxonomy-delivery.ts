import {
  allTermLabels,
  type Concept,
  ConflictError,
  type LocaleConfig,
  NO_USAGE,
  NotFoundError,
  type QueryFilter,
  resolveTermLabel,
  type Scope,
  summarizeUsage,
  type Tag,
  type TermUsage,
  ValidationError,
  withoutUndeliveredLocales,
} from '@commerceworker/domain';
import type { DeliveryReadResult, EntryQuery, SpaceConfig } from '@commerceworker/ports';
import type { AppContext } from './context';
import { assertDeliveredLocale, type DeliveryReads, deliveryReads } from './delivery-reads';

/**
 * Taxonomy on the Delivery API: what a front end needs to build archive pages. Every read here is
 * one store round trip (the space config, the terms and their usage counts in one batch) and
 * writes nothing; the counts are kept by the store as entries publish, never computed here.
 */

/** A term as Delivery serves it. */
export interface DeliveredTerm {
  readonly id: string;
  readonly slug: string;
  /** In the requested locale (with the space's fallbacks), or the default locale's. */
  readonly label: string;
  /** Every locale's label, the default's included; only when no locale was requested. */
  readonly labels?: Readonly<Record<string, string>>;
  readonly description: string | null;
  /** Published entries carrying the term (of `content_type` only, when one was asked for). */
  readonly count: number;
  /** The same count per content type. */
  readonly countsByContentType: Readonly<Record<string, number>>;
}

export type DeliveredTag = DeliveredTerm;

export interface DeliveredConcept extends DeliveredTerm {
  readonly schemeId: string;
  readonly broaderId: string | null;
}

export interface TermDeliveryOptions {
  /** Resolve labels for one locale. */
  readonly locale?: string;
  /** Count published entries of this content type only. */
  readonly contentType?: string;
  /**
   * The content types the caller may read; counts leave the others out, so a key limited to some
   * types never learns how many entries of the rest carry a term. Default: all.
   */
  readonly readable?: (contentType: string) => boolean;
  readonly reads?: DeliveryReads;
}

/** The space's config, refusing a locale it doesn't deliver (404). */
function spaceConfig(
  scope: Scope,
  result: DeliveryReadResult,
  opts: { readonly locale?: string },
): SpaceConfig {
  if (!result.config) throw new NotFoundError('Space', scope.spaceId);
  assertDeliveredLocale(result.config, opts.locale);
  return result.config;
}

function deliverTerm(
  term: { id: string; slug: string; description: string | null; labels: Tag['labels'] },
  defaultLabel: string,
  usage: ReadonlyMap<string, { count: number; byContentType: Readonly<Record<string, number>> }>,
  config: LocaleConfig,
  locale: string | undefined,
): DeliveredTerm {
  const counted = usage.get(term.id) ?? NO_USAGE;
  return {
    id: term.id,
    slug: term.slug,
    label:
      locale === undefined
        ? defaultLabel
        : resolveTermLabel(defaultLabel, term.labels, config, locale),
    ...(locale === undefined
      ? {
          labels: withoutUndeliveredLocales(
            allTermLabels(defaultLabel, term.labels, config),
            config,
          ),
        }
      : {}),
    description: term.description,
    count: counted.count,
    countsByContentType: counted.byContentType,
  };
}

const usageFilter = (opts: TermDeliveryOptions) => (contentType: string) =>
  (opts.contentType === undefined || contentType === opts.contentType) &&
  (opts.readable?.(contentType) ?? true);

const deliverTag = (
  tag: Tag,
  usage: readonly TermUsage[],
  config: LocaleConfig,
  opts: TermDeliveryOptions,
): DeliveredTag =>
  deliverTerm(tag, tag.name, summarizeUsage(usage, usageFilter(opts)), config, opts.locale);

function deliverConcepts(
  concepts: readonly Concept[],
  usage: readonly TermUsage[],
  config: LocaleConfig,
  opts: TermDeliveryOptions,
): DeliveredConcept[] {
  const counted = summarizeUsage(usage, usageFilter(opts));
  return concepts.map((c) => ({
    ...deliverTerm(c, c.prefLabel, counted, config, opts.locale),
    schemeId: c.schemeId,
    broaderId: c.broaderId,
  }));
}

/** Terms written before slugs (until the repair sweep reaches them) are not served. */
const bySlug = <T extends { slug: string }>(terms: readonly T[]): T[] =>
  terms.filter((t) => t.slug).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

/** Every tag, by slug, with its published usage counts. */
export async function listDeliveredTags(
  ctx: AppContext,
  scope: Scope,
  opts: TermDeliveryOptions = {},
): Promise<DeliveredTag[]> {
  const reads = opts.reads ?? deliveryReads(ctx);
  const result = await reads.read(scope, {
    config: true,
    tags: {},
    termUsage: { kind: 'tag' },
  });
  const config = spaceConfig(scope, result, opts);
  return bySlug(result.tags ?? []).map((t) => deliverTag(t, result.termUsage ?? [], config, opts));
}

/** One tag by its slug (404 when no tag has it). */
export async function getDeliveredTag(
  ctx: AppContext,
  scope: Scope,
  slug: string,
  opts: TermDeliveryOptions = {},
): Promise<DeliveredTag> {
  const reads = opts.reads ?? deliveryReads(ctx);
  const result = await reads.read(scope, {
    config: true,
    tags: { slugs: [slug] },
    termUsage: { kind: 'tag', slugs: [slug] },
  });
  const config = spaceConfig(scope, result, opts);
  const [tag] = result.tags ?? [];
  if (!tag) throw new NotFoundError('Tag', slug);
  return deliverTag(tag, result.termUsage ?? [], config, opts);
}

/** Every concept (of one scheme, or all), by slug, with its published usage counts. */
export async function listDeliveredConcepts(
  ctx: AppContext,
  scope: Scope,
  opts: TermDeliveryOptions & { readonly schemeId?: string } = {},
): Promise<DeliveredConcept[]> {
  const reads = opts.reads ?? deliveryReads(ctx);
  const narrow = opts.schemeId !== undefined ? { schemeId: opts.schemeId } : {};
  const result = await reads.read(scope, {
    config: true,
    concepts: narrow,
    termUsage: { kind: 'concept', ...narrow },
  });
  const config = spaceConfig(scope, result, opts);
  return deliverConcepts(bySlug(result.concepts ?? []), result.termUsage ?? [], config, opts);
}

/**
 * One concept by its slug. A slug is unique within a scheme, so without `schemeId` one that two
 * schemes share is a conflict (409): pass the scheme.
 */
export async function getDeliveredConcept(
  ctx: AppContext,
  scope: Scope,
  slug: string,
  opts: TermDeliveryOptions & { readonly schemeId?: string } = {},
): Promise<DeliveredConcept> {
  const reads = opts.reads ?? deliveryReads(ctx);
  const narrow = opts.schemeId !== undefined ? { schemeId: opts.schemeId } : {};
  const result = await reads.read(scope, {
    config: true,
    concepts: { ...narrow, slugs: [slug] },
    termUsage: { kind: 'concept', ...narrow, slugs: [slug] },
  });
  const config = spaceConfig(scope, result, opts);
  const found = result.concepts ?? [];
  if (found.length === 0) throw new NotFoundError('Concept', slug);
  if (found.length > 1) {
    throw new ConflictError(
      `More than one scheme has a concept with the slug "${slug}": pass scheme`,
      { slug, schemeIds: found.map((c) => c.schemeId) },
    );
  }
  const [concept] = deliverConcepts(found, result.termUsage ?? [], config, opts);
  return concept as DeliveredConcept;
}

// --- filtering entries by term slug ------------------------------------------

/** The filter fields that name terms by slug; the store filters on the ids they resolve to. */
const SLUG_FILTERS = {
  'metadata.tags.slug': 'metadata.tags',
  'metadata.concepts.slug': 'metadata.concepts',
} as const;
type SlugFilterField = keyof typeof SLUG_FILTERS;

const isSlugFilter = (f: QueryFilter): f is QueryFilter & { field: SlugFilterField } =>
  f.field in SLUG_FILTERS;

/** Whether a query filters on a term's slug (so the slugs must be looked up first). */
export const hasSlugFilters = (query: EntryQuery): boolean =>
  query.filters?.some(isSlugFilter) ?? false;

/** The slugs a query's slug filters name, by kind: what to read alongside the space config. */
export function slugFilterSlugs(query: EntryQuery): { tags: string[]; concepts: string[] } {
  const out = { tags: [] as string[], concepts: [] as string[] };
  for (const f of query.filters ?? []) {
    if (!isSlugFilter(f)) continue;
    const values = (Array.isArray(f.value) ? f.value : [f.value]).map(String);
    (f.field === 'metadata.tags.slug' ? out.tags : out.concepts).push(...values);
  }
  return out;
}

/**
 * Rewrites slug filters as id filters: `metadata.tags.slug=news` → `metadata.tags[in]=<ids>`. A
 * concept slug may name one concept per scheme, so it matches any of them. A slug no term has
 * matches nothing (`eq`/`in`) or excludes nothing (`ne`/`nin`).
 */
export function resolveSlugFilters(
  query: EntryQuery,
  terms: { readonly tags: readonly Tag[]; readonly concepts: readonly Concept[] },
): EntryQuery {
  if (!hasSlugFilters(query)) return query;
  const idsOf = (field: SlugFilterField, slugs: readonly string[]): string[] => {
    const pool: readonly { id: string; slug: string }[] =
      field === 'metadata.tags.slug' ? terms.tags : terms.concepts;
    return pool.filter((t) => slugs.includes(t.slug)).map((t) => t.id);
  };
  const filters = (query.filters ?? []).map((f): QueryFilter => {
    if (!isSlugFilter(f)) return f;
    const slugs = (Array.isArray(f.value) ? f.value : [f.value]).map(String);
    const ids = idsOf(f.field, slugs);
    switch (f.op) {
      case 'eq':
      case 'in':
        // No term has the slug: nothing can match (an id no term has).
        return { field: SLUG_FILTERS[f.field], op: 'in', value: ids.length ? ids : [''] };
      case 'ne':
      case 'nin':
        return { field: SLUG_FILTERS[f.field], op: 'nin', value: ids };
      default:
        throw new ValidationError([
          { field: f.field, message: 'A slug filter takes eq, ne, in or nin' },
        ]);
    }
  });
  return { ...query, filters };
}
