/**
 * Taxonomy — controlled vocabulary for tagging content. A `ConceptScheme` is a
 * named vocabulary (e.g. "Topics"); a `Concept` is a term within a scheme that
 * may nest under a broader concept (a hierarchy). `Tag`s are flat, free labels.
 *
 * Entries carry `EntryMetadata` associating them with tags and concepts — cross
 * cutting editorial metadata that lives outside the content-type field schema,
 * is delivered with the entry, and is filterable.
 *
 * Every term has a `slug` (a front end's archive URL: `/tags/news`), unique among
 * the environment's tags or within its concept's scheme, an optional plain-text
 * `description`, and `labels` in the space's other locales. The term's own label
 * (`Tag.name`, `Concept.prefLabel`) is its default-locale label.
 */

import { isSlug, nextSlugCandidate, normalizeSlug } from '../content-type/slug';
import { fallbackChain, type LocaleConfig } from '../locale';
import type { LocaleCode } from '../types';

export interface ConceptScheme {
  readonly id: string;
  readonly name: string;
}

/** A term's labels in locales other than the default (locale → label). */
export type TermLabels = Readonly<Record<LocaleCode, string>>;

export interface Concept {
  readonly id: string;
  readonly schemeId: string;
  /** The default-locale label. */
  readonly prefLabel: string;
  /** Unique within the scheme. */
  readonly slug: string;
  readonly description: string | null;
  readonly labels: TermLabels;
  /** The broader (parent) concept, or null at the top of the hierarchy. */
  readonly broaderId: string | null;
}

export interface Tag {
  readonly id: string;
  /** The default-locale label. */
  readonly name: string;
  /** Unique among the environment's tags. */
  readonly slug: string;
  readonly description: string | null;
  readonly labels: TermLabels;
}

/** Which vocabulary a term belongs to. */
export type TermKind = 'tag' | 'concept';

/**
 * How many published entries of one content type carry a term. Only published snapshots count:
 * a draft's tags count once it is published, and stop counting when it is unpublished, archived
 * or trashed.
 */
export interface TermUsage {
  readonly kind: TermKind;
  readonly termId: string;
  readonly contentTypeApiId: string;
  readonly count: number;
}

/** A term's published usage: the total, and the same count per content type. */
export interface TermUsageSummary {
  readonly count: number;
  readonly byContentType: Readonly<Record<string, number>>;
}

export const NO_USAGE: TermUsageSummary = { count: 0, byContentType: {} };

/**
 * Sums usage rows per term. `include` narrows the content types counted, so a key limited to
 * some types never learns how many entries of the others carry a term.
 */
export function summarizeUsage(
  rows: readonly TermUsage[],
  include: (contentTypeApiId: string) => boolean = () => true,
): Map<string, TermUsageSummary> {
  const out = new Map<string, { count: number; byContentType: Record<string, number> }>();
  for (const row of rows) {
    if (row.count <= 0 || !include(row.contentTypeApiId)) continue;
    let summary = out.get(row.termId);
    if (!summary) {
      summary = { count: 0, byContentType: {} };
      out.set(row.termId, summary);
    }
    summary.count += row.count;
    summary.byContentType[row.contentTypeApiId] =
      (summary.byContentType[row.contentTypeApiId] ?? 0) + row.count;
  }
  return out;
}

/**
 * The slug a term asks for: `requested` normalized, or one made from its label. A label with
 * nothing slug-worthy in it (all emoji, all CJK) falls back to the kind (`tag`, `concept`), which
 * {@link uniqueTermSlug} then numbers. Null when a slug was asked for and none of it survives
 * normalization.
 */
export function termSlug(kind: TermKind, label: string, requested?: string): string | null {
  if (requested !== undefined) {
    const slug = normalizeSlug(requested);
    return isSlug(slug) ? slug : null;
  }
  return normalizeSlug(label) || kind;
}

/**
 * The first of `base`, `base-2`, `base-3`, … that `taken` doesn't hold, so a generated slug never
 * collides. (A slug the caller asked for that is taken is a conflict instead.)
 */
export function uniqueTermSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let attempt = 2; ; attempt++) {
    const candidate = nextSlugCandidate(base, attempt);
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A term's label in `requested`, walking the space's fallback chain: the locale's own label, then
 * its fallbacks', ending at the default locale, whose label is the term's own (`defaultLabel`).
 */
export function resolveTermLabel(
  defaultLabel: string,
  labels: TermLabels,
  config: LocaleConfig,
  requested: LocaleCode,
): string {
  for (const locale of fallbackChain(config, requested)) {
    if (locale === config.defaultLocale) return defaultLabel;
    const label = labels[locale];
    if (label) return label;
  }
  return defaultLabel;
}

/** A term's labels in every locale it has one, the default locale's included. */
export const allTermLabels = (
  defaultLabel: string,
  labels: TermLabels,
  config: Pick<LocaleConfig, 'defaultLocale'>,
): Record<LocaleCode, string> => ({ ...labels, [config.defaultLocale]: defaultLabel });

/** Longest label a term keeps (default or localized). */
export const TERM_LABEL_MAX_LENGTH = 256;
/** Longest description a term keeps. */
export const TERM_DESCRIPTION_MAX_LENGTH = 2000;

/** The taxonomy associations attached to an entry. */
export interface EntryMetadata {
  readonly tags: readonly string[];
  readonly concepts: readonly string[];
}

export const EMPTY_METADATA: EntryMetadata = { tags: [], concepts: [] };

/**
 * Validates that setting `broaderId` on `conceptId` would not create a cycle,
 * given the existing parent links. `parentOf` returns a concept's current
 * broader id (or null). Throws nothing — returns true when the link is safe.
 */
export function isAcyclicBroader(
  conceptId: string,
  broaderId: string | null,
  parentOf: (id: string) => string | null,
): boolean {
  if (broaderId === null) return true;
  if (broaderId === conceptId) return false;
  const seen = new Set<string>([conceptId]);
  let current: string | null = broaderId;
  while (current) {
    if (seen.has(current)) return false;
    seen.add(current);
    current = parentOf(current);
  }
  return true;
}
