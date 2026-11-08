import {
  type Concept,
  type ConceptScheme,
  ConflictError,
  type EntryMetadata,
  InvalidStateError,
  isAcyclicBroader,
  NO_USAGE,
  NotFoundError,
  type Scope,
  summarizeUsage,
  type Tag,
  TERM_DESCRIPTION_MAX_LENGTH,
  TERM_LABEL_MAX_LENGTH,
  type TermKind,
  type TermLabels,
  type TermUsageSummary,
  termSlug,
  uniqueTermSlug,
  ValidationError,
} from '@commerceworker/domain';
import type { ContentStoreTx } from '@commerceworker/ports';
import type { AppContext } from './context';

// --- concept schemes ------------------------------------------------------

export async function createScheme(
  ctx: AppContext,
  scope: Scope,
  input: { name: string },
): Promise<ConceptScheme> {
  const scheme: ConceptScheme = { id: ctx.ids.newId(), name: input.name };
  await ctx.store.taxonomy.createScheme(scope, scheme);
  return scheme;
}

export const listSchemes = (ctx: AppContext, scope: Scope): Promise<ConceptScheme[]> =>
  ctx.store.taxonomy.listSchemes(scope);

export async function deleteScheme(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  if (!(await ctx.store.taxonomy.getScheme(scope, id)))
    throw new NotFoundError('ConceptScheme', id);
  await ctx.store.taxonomy.deleteScheme(scope, id);
}

// --- term fields (slug, description, localized labels) ---------------------

/** What a term's create or update may set beside its label. */
export interface TermFieldsInput {
  /** Normalized; made from the label when omitted on create. Kept when the label changes. */
  readonly slug?: string;
  /** Plain text; null or '' clears it. */
  readonly description?: string | null;
  /**
   * Labels by locale, each a locale of the space. The whole set: a locale left out loses its
   * label. A default-locale entry sets the term's own label; an empty value is dropped.
   */
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * What to do when a slug asked for on create is taken: refuse (`conflict`, every client call), or
 * number it like a generated one (`renumber`, an import into an environment that has the slug).
 */
export type SlugTakenPolicy = 'conflict' | 'renumber';

type SlugNamespace =
  | { readonly kind: 'tag' }
  | { readonly kind: 'concept'; readonly schemeId: string };

const issue = (field: string, message: string) => new ValidationError([{ field, message }]);

function checkLabel(field: string, label: string): string {
  const trimmed = label.trim();
  if (!trimmed) throw issue(field, 'A label is required');
  if (trimmed.length > TERM_LABEL_MAX_LENGTH) {
    throw issue(field, `A label is at most ${TERM_LABEL_MAX_LENGTH} characters`);
  }
  return trimmed;
}

function checkDescription(description: string | null | undefined): string | null {
  const trimmed = description?.trim() ?? '';
  if (trimmed.length > TERM_DESCRIPTION_MAX_LENGTH) {
    throw issue(
      'description',
      `A description is at most ${TERM_DESCRIPTION_MAX_LENGTH} characters`,
    );
  }
  return trimmed || null;
}

/**
 * Splits localized labels into the term's own (default-locale) label and the others, refusing a
 * locale the space doesn't have. Reads the space config only when there are labels to check.
 */
async function splitLabels(
  ctx: AppContext,
  scope: Scope,
  label: string,
  labels: Readonly<Record<string, string>> | undefined,
): Promise<{ label: string; labels: TermLabels | undefined }> {
  if (labels === undefined) return { label, labels: undefined };
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  let own = label;
  const others: Record<string, string> = {};
  for (const [locale, value] of Object.entries(labels)) {
    if (!config.locales.includes(locale)) {
      throw issue(`labels.${locale}`, `"${locale}" is not a locale of this space`);
    }
    if (!value.trim()) continue;
    const checked = checkLabel(`labels.${locale}`, value);
    if (locale === config.defaultLocale) own = checked;
    else others[locale] = checked;
  }
  return { label: own, labels: others };
}

/**
 * Writes a term under the slug it should get, letting the namespace's unique index decide rather
 * than reading the taken slugs first: most labels make a slug nobody has, so the common write
 * costs no extra read. When the slug is taken, one the caller asked for is a conflict (unless the
 * policy renumbers it); one made from the label is numbered past the taken ones and written again,
 * choosing again if a concurrent writer takes that one first. `ownSlug` is the term's current
 * slug, which it may always keep.
 */
async function writeWithSlug<T>(
  ctx: AppContext,
  scope: Scope,
  namespace: SlugNamespace,
  slugOf: { label: string; requested: string | undefined; ownSlug?: string },
  onTaken: SlugTakenPolicy,
  write: (slug: string) => Promise<T>,
): Promise<T> {
  const base = termSlug(namespace.kind, slugOf.label, slugOf.requested);
  if (base === null) {
    throw issue('slug', 'A slug needs at least one letter or digit (a-z, 0-9)');
  }
  const taken = (err: unknown) => {
    if (!(err instanceof ConflictError)) throw err;
  };
  try {
    return await write(base);
  } catch (err) {
    taken(err);
    if (base === slugOf.ownSlug) throw err;
  }
  if (slugOf.requested !== undefined && onTaken === 'conflict') {
    throw new ConflictError(
      namespace.kind === 'tag'
        ? `Another tag already has the slug "${base}"`
        : `Another concept in this scheme already has the slug "${base}"`,
      { slug: base },
    );
  }
  for (let attempt = 1; ; attempt++) {
    const inUse = new Set(await ctx.store.taxonomy.slugsLike(scope, namespace, base));
    try {
      return await write(uniqueTermSlug(base, inUse));
    } catch (err) {
      taken(err);
      if (attempt >= 3) throw err;
    }
  }
}

/** The event every vocabulary change commits with: Delivery's taxonomy reads are stale. */
async function announce(
  ctx: AppContext,
  tx: ContentStoreTx,
  scope: Scope,
  termKind: TermKind,
  termId: string,
): Promise<void> {
  await tx.outbox.append({
    id: ctx.ids.newId(),
    type: 'taxonomy.changed',
    scope,
    occurredAt: ctx.clock.now().toISOString(),
    termKind,
    termId,
  });
}

// --- concepts -------------------------------------------------------------

export async function createConcept(
  ctx: AppContext,
  scope: Scope,
  input: { schemeId: string; prefLabel: string; broaderId?: string | null } & TermFieldsInput,
  opts: { readonly slugTaken?: SlugTakenPolicy } = {},
): Promise<Concept> {
  if (!(await ctx.store.taxonomy.getScheme(scope, input.schemeId))) {
    throw new NotFoundError('ConceptScheme', input.schemeId);
  }
  const broaderId = input.broaderId ?? null;
  if (broaderId && !(await ctx.store.taxonomy.getConcept(scope, broaderId))) {
    throw new NotFoundError('Concept', broaderId);
  }
  const { label, labels } = await splitLabels(
    ctx,
    scope,
    checkLabel('prefLabel', input.prefLabel),
    input.labels,
  );
  const draft = {
    id: ctx.ids.newId(),
    schemeId: input.schemeId,
    prefLabel: label,
    description: checkDescription(input.description),
    labels: labels ?? {},
    broaderId,
  };
  return writeWithSlug(
    ctx,
    scope,
    { kind: 'concept', schemeId: input.schemeId },
    { label, requested: input.slug },
    opts.slugTaken ?? 'conflict',
    (slug) => saveConcept(ctx, scope, { ...draft, slug }),
  );
}

/** Writes a concept with the event that announces it. */
async function saveConcept(ctx: AppContext, scope: Scope, concept: Concept): Promise<Concept> {
  await ctx.store.withTransaction(async (tx) => {
    await tx.taxonomy.createConcept(scope, concept);
    await announce(ctx, tx, scope, 'concept', concept.id);
  });
  return concept;
}

/**
 * Changes a concept's label, slug, description or localized labels; only the keys sent change.
 * Its slug stays when its label changes (an archive URL doesn't move by itself).
 */
export async function updateConcept(
  ctx: AppContext,
  scope: Scope,
  id: string,
  patch: { prefLabel?: string } & TermFieldsInput,
): Promise<Concept> {
  const concept = await ctx.store.taxonomy.getConcept(scope, id);
  if (!concept) throw new NotFoundError('Concept', id);
  const own = patch.prefLabel !== undefined ? checkLabel('prefLabel', patch.prefLabel) : null;
  const split = await splitLabels(ctx, scope, own ?? concept.prefLabel, patch.labels);
  const updated: Concept = {
    ...concept,
    prefLabel: split.label,
    labels: split.labels ?? concept.labels,
    ...(patch.description !== undefined
      ? { description: checkDescription(patch.description) }
      : {}),
  };
  if (patch.slug === undefined && concept.slug) return saveConcept(ctx, scope, updated);
  return writeWithSlug(
    ctx,
    scope,
    { kind: 'concept', schemeId: concept.schemeId },
    { label: split.label, requested: patch.slug, ownSlug: concept.slug },
    'conflict',
    (slug) => saveConcept(ctx, scope, { ...updated, slug }),
  );
}

export const listConcepts = (
  ctx: AppContext,
  scope: Scope,
  schemeId?: string,
): Promise<Concept[]> => ctx.store.taxonomy.listConcepts(scope, schemeId);

/** A term with its published usage: how many published entries carry it, per content type. */
export type WithUsage<T> = T & { readonly usage: TermUsageSummary };

/** Concepts (of one scheme, or all) with their published usage counts. */
export async function listConceptsWithUsage(
  ctx: AppContext,
  scope: Scope,
  schemeId?: string,
): Promise<WithUsage<Concept>[]> {
  const [concepts, usage] = await Promise.all([
    ctx.store.taxonomy.listConcepts(scope, schemeId),
    ctx.store.taxonomy.listUsage(scope, { kind: 'concept' }),
  ]);
  const byTerm = summarizeUsage(usage);
  return concepts.map((c) => ({ ...c, usage: byTerm.get(c.id) ?? NO_USAGE }));
}

/** Re-parents a concept, rejecting a change that would create a cycle. */
export async function setConceptBroader(
  ctx: AppContext,
  scope: Scope,
  id: string,
  broaderId: string | null,
): Promise<Concept> {
  const concept = await ctx.store.taxonomy.getConcept(scope, id);
  if (!concept) throw new NotFoundError('Concept', id);
  if (broaderId && !(await ctx.store.taxonomy.getConcept(scope, broaderId))) {
    throw new NotFoundError('Concept', broaderId);
  }
  const all = await ctx.store.taxonomy.listConcepts(scope);
  const parentOf = (cid: string) => all.find((c) => c.id === cid)?.broaderId ?? null;
  if (!isAcyclicBroader(id, broaderId, parentOf)) {
    throw new InvalidStateError('That parent would create a cycle in the concept hierarchy');
  }
  return saveConcept(ctx, scope, { ...concept, broaderId });
}

export async function deleteConcept(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  if (!(await ctx.store.taxonomy.getConcept(scope, id))) throw new NotFoundError('Concept', id);
  await ctx.store.withTransaction(async (tx) => {
    await tx.taxonomy.deleteConcept(scope, id);
    await announce(ctx, tx, scope, 'concept', id);
  });
}

// --- tags -----------------------------------------------------------------

export async function createTag(
  ctx: AppContext,
  scope: Scope,
  input: { name: string } & TermFieldsInput,
  opts: { readonly slugTaken?: SlugTakenPolicy } = {},
): Promise<Tag> {
  const { label, labels } = await splitLabels(
    ctx,
    scope,
    checkLabel('name', input.name),
    input.labels,
  );
  const draft = {
    id: ctx.ids.newId(),
    name: label,
    description: checkDescription(input.description),
    labels: labels ?? {},
  };
  return writeWithSlug(
    ctx,
    scope,
    { kind: 'tag' },
    { label, requested: input.slug },
    opts.slugTaken ?? 'conflict',
    (slug) => saveTag(ctx, scope, { ...draft, slug }),
  );
}

/** Writes a tag with the event that announces it. */
async function saveTag(ctx: AppContext, scope: Scope, tag: Tag): Promise<Tag> {
  await ctx.store.withTransaction(async (tx) => {
    await tx.taxonomy.createTag(scope, tag);
    await announce(ctx, tx, scope, 'tag', tag.id);
  });
  return tag;
}

/**
 * Changes a tag's name, slug, description or localized labels; only the keys sent change. Its
 * slug stays when its name changes (an archive URL doesn't move by itself).
 */
export async function updateTag(
  ctx: AppContext,
  scope: Scope,
  id: string,
  patch: { name?: string } & TermFieldsInput,
): Promise<Tag> {
  const tag = await ctx.store.taxonomy.getTag(scope, id);
  if (!tag) throw new NotFoundError('Tag', id);
  const own = patch.name !== undefined ? checkLabel('name', patch.name) : null;
  const split = await splitLabels(ctx, scope, own ?? tag.name, patch.labels);
  const updated: Tag = {
    ...tag,
    name: split.label,
    labels: split.labels ?? tag.labels,
    ...(patch.description !== undefined
      ? { description: checkDescription(patch.description) }
      : {}),
  };
  if (patch.slug === undefined && tag.slug) return saveTag(ctx, scope, updated);
  return writeWithSlug(
    ctx,
    scope,
    { kind: 'tag' },
    { label: split.label, requested: patch.slug, ownSlug: tag.slug },
    'conflict',
    (slug) => saveTag(ctx, scope, { ...updated, slug }),
  );
}

export const listTags = (ctx: AppContext, scope: Scope): Promise<Tag[]> =>
  ctx.store.taxonomy.listTags(scope);

/** Tags with their published usage counts. */
export async function listTagsWithUsage(ctx: AppContext, scope: Scope): Promise<WithUsage<Tag>[]> {
  const [tags, usage] = await Promise.all([
    ctx.store.taxonomy.listTags(scope),
    ctx.store.taxonomy.listUsage(scope, { kind: 'tag' }),
  ]);
  const byTerm = summarizeUsage(usage);
  return tags.map((t) => ({ ...t, usage: byTerm.get(t.id) ?? NO_USAGE }));
}

export async function deleteTag(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  if (!(await ctx.store.taxonomy.getTag(scope, id))) throw new NotFoundError('Tag', id);
  await ctx.store.withTransaction(async (tx) => {
    await tx.taxonomy.deleteTag(scope, id);
    await announce(ctx, tx, scope, 'tag', id);
  });
}

// --- repair ---------------------------------------------------------------

export interface TaxonomyRepair {
  /** Terms that had no slug (written by code older than slugs) and now have one. */
  readonly slugsAssigned: number;
}

/**
 * Rebuilds the scope's published usage counts from its published snapshots, and gives a slug to
 * any term without one. Counts are kept as entries publish, so this changes nothing unless
 * something wrote snapshots without them (code older than the counts, during a deploy); the
 * engine runs it daily for every environment, and a client may run it at any time. Safe to repeat.
 */
export async function repairTaxonomy(ctx: AppContext, scope: Scope): Promise<TaxonomyRepair> {
  let slugsAssigned = 0;
  for (const tag of await ctx.store.taxonomy.listTags(scope)) {
    if (tag.slug) continue;
    await updateTag(ctx, scope, tag.id, {});
    slugsAssigned += 1;
  }
  for (const concept of await ctx.store.taxonomy.listConcepts(scope)) {
    if (concept.slug) continue;
    await updateConcept(ctx, scope, concept.id, {});
    slugsAssigned += 1;
  }
  await ctx.store.taxonomy.recountUsage(scope);
  return { slugsAssigned };
}

/** {@link repairTaxonomy} for every environment of every space: the engine's daily sweep. */
export async function repairAllTaxonomies(
  ctx: AppContext,
): Promise<{ environments: number; slugsAssigned: number; failed: number }> {
  let environments = 0;
  let slugsAssigned = 0;
  let failed = 0;
  for (const space of await ctx.store.spaces.list()) {
    for (const env of await ctx.store.spaces.listEnvironments(space.spaceId)) {
      try {
        const r = await repairTaxonomy(ctx, { spaceId: space.spaceId, environmentId: env.id });
        environments += 1;
        slugsAssigned += r.slugsAssigned;
      } catch {
        // One environment's failure (deleted mid-sweep, a lost slug race) never stops the rest;
        // the next day's sweep tries it again.
        failed += 1;
      }
    }
  }
  return { environments, slugsAssigned, failed };
}

// --- entry associations ---------------------------------------------------

export const getEntryMetadata = (
  ctx: AppContext,
  scope: Scope,
  entryId: string,
): Promise<EntryMetadata | null> => ctx.store.taxonomy.getEntryMetadata(scope, entryId);

/**
 * Sets an entry's tag/concept associations, validating that every referenced
 * tag and concept exists. Takes effect on the next publish (the snapshot copies
 * the current metadata). Duplicates are dropped: an entry counts once per term.
 */
export async function setEntryMetadata(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
  input: { tags?: readonly string[]; concepts?: readonly string[] },
): Promise<EntryMetadata> {
  if (!(await ctx.store.entries.get(scope, entryId))) throw new NotFoundError('Entry', entryId);
  const tags = [...new Set(input.tags ?? [])];
  const concepts = [...new Set(input.concepts ?? [])];
  for (const tagId of tags) {
    if (!(await ctx.store.taxonomy.getTag(scope, tagId))) throw new NotFoundError('Tag', tagId);
  }
  for (const conceptId of concepts) {
    if (!(await ctx.store.taxonomy.getConcept(scope, conceptId))) {
      throw new NotFoundError('Concept', conceptId);
    }
  }
  const metadata: EntryMetadata = { tags, concepts };
  await ctx.store.taxonomy.setEntryMetadata(scope, entryId, metadata);
  return metadata;
}
