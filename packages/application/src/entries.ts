import type { ContentType, UniqueClaim } from '@commerceworker/domain';
import {
  applyDefaults,
  archive,
  assertEntryFieldsValid,
  assetMimeChecks,
  assignBlockKeys,
  ConflictError,
  deriveStatus,
  EMPTY_METADATA,
  ENTRY_ID_RULE,
  type Entry,
  type EntryFields,
  type EntryVersion,
  type FieldIssue,
  hasUniqueFields,
  InvalidStateError,
  isEntryId,
  mimeTypeAllowed,
  NotFoundError,
  nextSlugCandidate,
  normalizeSlugFields,
  restore,
  type Scope,
  SINGLETON_CLAIM_FIELD,
  saveDraft,
  stampChanged,
  stampCreated,
  uniqueClaims,
  type ValidationContext,
  ValidationError,
} from '@commerceworker/domain';
import { type BlobStore, type EntryRepo, TransactionConflictError } from '@commerceworker/ports';
import { noteEntryChange } from './change-log';
import { type AppContext, actorOf } from './context';
import { runHook, runPureHook } from './hooks';
import { unpublishEntryTx } from './publishing';
import { versionBodyPrefix } from './version-archive';

/**
 * A create judged as an edit of the type's defaults: a field its rules disable starts at its
 * default (or empty) and cannot be given another value.
 */
function asCreate(contentType: ContentType, vctx: ValidationContext): ValidationContext {
  return { ...vctx, previous: applyDefaults(contentType, {}, vctx.locales, vctx.defaultLocale) };
}

/** Loads the validation context (locales) for a scope. */
async function loadValidationContext(ctx: AppContext, scope: Scope): Promise<ValidationContext> {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  return { defaultLocale: config.defaultLocale, locales: config.locales };
}

async function requireContentType(
  ctx: AppContext,
  scope: Scope,
  apiId: string,
): Promise<ContentType> {
  const ct = await ctx.store.contentTypes.get(scope, apiId);
  if (!ct) throw new NotFoundError('ContentType', apiId);
  return ct;
}

export interface CreateEntryInput {
  readonly contentTypeApiId: string;
  readonly fields: EntryFields;
  /**
   * Keep this id instead of minting one: an environment import copies entries with their ids,
   * so every link between them still resolves in the target. Not accepted over the API.
   */
  readonly id?: string;
  /**
   * Authorship the entry brings from where it was copied (an environment clone or promotion), kept
   * instead of crediting whoever copied it. Not accepted over the API.
   */
  readonly authorship?: Pick<Entry, 'createdAt' | 'createdBy' | 'firstPublishedAt'>;
}

/** How a write's fields are judged. */
export interface EntryWriteOptions {
  /**
   * A whole entry copied from elsewhere (a snapshot or space-export import, a promotion, a CSV or
   * JSON import, a restored version): judged without previous values, so a field its rules
   * disable is not held to its default or stored value. The copy carries what the source held;
   * an interactive write (the API, MCP, AI, plugins) leaves this unset. Not accepted over the API.
   */
  readonly copy?: boolean;
  /**
   * Top-level fields the caller's role denies or makes read-only (`unwritableFieldsFor`). The
   * caller can neither send nor read them all, so an update keeps their stored values: what is
   * saved is what the caller sent plus what it may not touch, never an entry with those fields
   * erased. A field among them that its rules disable then holds its stored value and passes.
   */
  readonly unwritable?: readonly string[];
}

/**
 * The fields an update saves: those sent, with the stored values of the fields the caller may not
 * write laid over them (it can't send those, so they are kept rather than dropped).
 */
function withUnwritable(
  stored: EntryFields,
  fields: EntryFields,
  options: EntryWriteOptions,
): EntryFields {
  if (!options.unwritable?.length) return fields;
  const out: EntryFields = { ...fields };
  for (const apiId of options.unwritable) {
    const kept = stored[apiId];
    if (kept === undefined) delete out[apiId];
    else out[apiId] = kept;
  }
  return out;
}

export interface EntryView {
  readonly entry: Entry;
  readonly fields: EntryFields;
}

/** Creates a draft entry after validating its fields against the content type. */
export async function createEntry(
  ctx: AppContext,
  scope: Scope,
  input: CreateEntryInput,
  options: EntryWriteOptions = {},
): Promise<EntryView> {
  const contentType = await requireContentType(ctx, scope, input.contentTypeApiId);
  if (contentType.singleton) await assertSingletonFree(ctx.store.entries, scope, contentType);
  const vctx = await loadValidationContext(ctx, scope);
  // Defaults fill gaps, then slugs are normalized, and only then is the result
  // validated — so an editor is judged on what will actually be stored.
  if (input.id !== undefined && !isEntryId(input.id)) {
    throw new ValidationError([{ field: 'id', message: ENTRY_ID_RULE }]);
  }
  const withDefaults = applyDefaults(contentType, input.fields, vctx.locales, vctx.defaultLocale);
  const { fields } = await prepareFields(
    ctx,
    scope,
    contentType,
    options.copy ? vctx : asCreate(contentType, vctx),
    { contentTypeApiId: input.contentTypeApiId, fields: withDefaults },
    'save',
  );

  const id = input.id ?? ctx.ids.newId();
  const now = ctx.clock.now().toISOString();
  const entry = stampCreated(
    {
      id,
      contentTypeApiId: input.contentTypeApiId,
      status: 'draft',
      currentVersion: 1,
      publishedVersion: null,
      ...input.authorship,
    },
    actorOf(ctx),
    now,
  );
  const version: EntryVersion = {
    entryId: id,
    version: 1,
    fields,
    createdAt: now,
    createdBy: actorOf(ctx),
  };

  const claims = uniqueClaims(contentType, fields);
  // Claim and write together: the claim is the constraint, so a crash between
  // the two must not leave a value reserved by an entry that does not exist.
  await writeNewEntry(ctx, scope, contentType, entry, version, claims);
  noteEntryChange(ctx, { entry, contentType, before: {}, after: fields, locales: vctx.locales });
  return { entry, fields };
}

/**
 * Writes a new entry, its first version and its unique claims as one unit, guarded on its type
 * as the caller read it: a type deleted since (which would orphan the entry) or whose singleton
 * flag was turned on or off since (which would let a second entry past the claim it did not
 * stake) fails the commit, and the create is refused (409) rather than written.
 */
export async function writeNewEntry(
  ctx: AppContext,
  scope: Scope,
  contentType: ContentType,
  entry: Entry,
  version: EntryVersion,
  claims: readonly UniqueClaim[],
): Promise<void> {
  if (claims.length > 0) await assertClaimsFree(ctx.store.entries, scope, claims);
  try {
    await ctx.store.withTransaction(async (tx) => {
      await tx.contentTypes.guard(scope, contentType.apiId, {
        singleton: contentType.singleton === true,
      });
      await tx.entries.create(scope, entry, version);
      if (claims.length > 0) await tx.entries.replaceUniqueClaims(scope, entry.id, claims);
    });
  } catch (err) {
    if (!(err instanceof TransactionConflictError)) throw err;
    throw new ConflictError(
      `The content type "${contentType.apiId}" was deleted or changed while the entry was being ` +
        'created; try again',
      { contentType: contentType.apiId },
    );
  }
}

/**
 * What a save does to the fields it was given before it writes them: the `entry:beforeSave` hook,
 * slug normalization, block keys, then validation. One function, so a dry run
 * ({@link validateEntry}) judges exactly what a save would.
 *
 * `'dry-run'` runs the hook through its effect-free handlers only (`runPureHook`) and names the
 * ones it left out.
 */
async function prepareFields(
  ctx: AppContext,
  scope: Scope,
  contentType: ContentType,
  vctx: ValidationContext,
  payload: { readonly contentTypeApiId: string; readonly entryId?: string; fields: EntryFields },
  mode: 'save' | 'dry-run',
): Promise<{ readonly fields: EntryFields; readonly skippedHooks: readonly string[] }> {
  // Hook before normalization and validation, so a hook that writes
  // `slug: "Hello World"` still gets normalized, and nothing a hook produces
  // escapes validation.
  const hooked =
    mode === 'save'
      ? { payload: await runHook(ctx, 'entry:beforeSave', scope, payload), skipped: [] }
      : await runPureHook(ctx, 'entry:beforeSave', scope, payload);
  // Blocks get their `_key` last, so a block a hook added is keyed too.
  const fields = assignBlockKeys(
    contentType,
    normalizeSlugFields(contentType, hooked.payload.fields),
    () => ctx.ids.newId(),
  );
  assertEntryFieldsValid(contentType, fields, vctx);
  await assertAssetMimeTypes(ctx, scope, contentType, fields);
  return { fields, skippedHooks: hooked.skipped };
}

/**
 * Refuses a link to an asset whose file is not one of the MIME types its field allows
 * (`validations.assetMimeTypes`). The rule is on the field and the type on the asset, so this is
 * the one field check that reads: one batch for every linked asset, and none when no field has
 * the rule. An asset that does not exist is left to the publish gate, as any link is.
 */
/**
 * Refuses an asset link whose asset's declared file type (`file.contentType`, as uploaded) a MIME
 * rule doesn't take. The message names the rule, never the asset's own type: the caller learns
 * what the field takes, not what a file it may not read is. A link to an asset that isn't there is
 * left to the publish gate.
 */
export async function assertAssetMimeTypes(
  ctx: AppContext,
  scope: Scope,
  contentType: ContentType,
  fields: EntryFields,
): Promise<void> {
  const checks = assetMimeChecks(contentType, fields);
  if (checks.length === 0) return;
  const assets = await ctx.store.assets.getMany(scope, [...new Set(checks.map((c) => c.assetId))]);
  const mimeOf = new Map(assets.map((a) => [a.id, a.file.contentType]));
  const issues: FieldIssue[] = [];
  for (const c of checks) {
    const mime = mimeOf.get(c.assetId);
    if (mime === undefined || mimeTypeAllowed(mime, c.allowed)) continue;
    issues.push({
      field: c.field,
      locale: c.locale,
      message:
        c.message ??
        `Asset ${c.assetId} is not a file type this field takes (${c.allowed.join(', ')})`,
    });
  }
  if (issues.length > 0) throw new ValidationError(issues);
}

/**
 * Fails with a message naming the field and the entry holding the value.
 *
 * The database constraint is what actually guarantees uniqueness; this exists
 * so the common case produces "slug 'about' is already used by entry X" rather
 * than a bare constraint violation.
 */
export async function assertClaimsFree(
  entries: Pick<EntryRepo, 'findUniqueConflicts'>,
  scope: Scope,
  claims: readonly UniqueClaim[],
  excludeEntryId?: string,
): Promise<void> {
  const conflicts = await entries.findUniqueConflicts(scope, claims, excludeEntryId);
  if (conflicts.length === 0) return;
  const singleton = claims[0]?.fieldApiId === SINGLETON_CLAIM_FIELD ? claims[0] : undefined;
  throw new ConflictError(
    conflicts
      .map((c) =>
        c.fieldApiId === SINGLETON_CLAIM_FIELD
          ? singletonTaken(singleton?.contentTypeApiId ?? '', c.entryId)
          : `${c.fieldApiId} "${c.value}" is already used by entry ${c.entryId}`,
      )
      .join('; '),
    { conflicts },
  );
}

const singletonTaken = (contentTypeApiId: string, entryId: string) =>
  `"${contentTypeApiId}" is a singleton type and entry ${entryId} is its one entry: edit that ` +
  'one, or move it to the trash first';

/**
 * Refuses a second entry of a singleton type, naming the one it has. The claim every entry of the
 * type stakes (`singletonClaim`) is what holds under a race; this read is what an editor hears in
 * the common case, and it also counts an entry whose claim went missing (one saved while an older
 * release that knew nothing of singletons was serving), so the rule holds through a rollback.
 */
export async function assertSingletonFree(
  entries: Pick<EntryRepo, 'list'>,
  scope: Scope,
  contentType: Pick<ContentType, 'apiId'>,
  excludeEntryId?: string,
): Promise<void> {
  const [held] = (
    await entries.list(scope, { contentTypeApiId: contentType.apiId, limit: 2 })
  ).filter((e) => e.entry.id !== excludeEntryId);
  if (held) {
    throw new ConflictError(singletonTaken(contentType.apiId, held.entry.id), {
      singleton: contentType.apiId,
      entryId: held.entry.id,
    });
  }
}

export async function getEntry(ctx: AppContext, scope: Scope, id: string): Promise<EntryView> {
  const found = await ctx.store.entries.get(scope, id);
  if (!found) throw new NotFoundError('Entry', id);
  return { entry: found.entry, fields: found.fields };
}

/** Saves an edited set of field values as a new draft version. */
export async function updateEntry(
  ctx: AppContext,
  scope: Scope,
  id: string,
  fields: EntryFields,
  options: EntryWriteOptions = {},
): Promise<EntryView> {
  const found = await ctx.store.entries.get(scope, id);
  if (!found) throw new NotFoundError('Entry', id);
  const contentType = await requireContentType(ctx, scope, found.entry.contentTypeApiId);
  const vctx = await loadValidationContext(ctx, scope);
  // The stored version is what a disabled field must keep, unless the whole entry is a copy.
  return saveEntryDraft(
    ctx,
    scope,
    found.entry,
    contentType,
    options.copy ? vctx : { ...vctx, previous: found.fields },
    withUnwritable(found.fields, fields, options),
    found.fields,
  );
}

/**
 * `updateEntry` once its reads are done: for a use-case that already read the entry, its type and
 * the locales to work out the new fields (a partial edit), so the save doesn't read them again.
 * `stored` is the fields it read, which what this save changed is measured against.
 */
export async function saveEntryDraft(
  ctx: AppContext,
  scope: Scope,
  current: Entry,
  contentType: ContentType,
  vctx: ValidationContext,
  fields: EntryFields,
  stored: EntryFields,
): Promise<EntryView> {
  const id = current.id;
  // No defaults on update. The fields passed become the whole new version: an
  // omitted field is absent from it (nothing is merged from the previous
  // version), and a cleared one is empty. Re-applying a default would override both.
  const { fields: normalized } = await prepareFields(
    ctx,
    scope,
    contentType,
    vctx,
    { contentTypeApiId: current.contentTypeApiId, entryId: id, fields },
    'save',
  );

  const { entry, version } = saveDraft(current, normalized);
  // Keep status consistent with the published pointer.
  const synced: Entry = stampChanged(
    { ...entry, status: deriveStatus(entry.currentVersion, entry.publishedVersion, false) },
    actorOf(ctx),
  );
  const stamped: EntryVersion = {
    ...version,
    createdAt: ctx.clock.now().toISOString(),
    createdBy: actorOf(ctx),
  };

  const claims = uniqueClaims(contentType, normalized);
  if (claims.length === 0 && !hasUniqueFields(contentType)) {
    await ctx.store.entries.saveVersion(scope, synced, stamped);
  } else {
    await ctx.store.withTransaction(async (tx) => {
      await assertClaimsFree(tx.entries, scope, claims, id);
      await tx.entries.saveVersion(scope, synced, stamped);
      // Replace rather than add: clearing a unique field has to free its value.
      await tx.entries.replaceUniqueClaims(scope, id, claims);
    });
  }
  // What is measured is what was stored: after the hook, the slugs and the block keys.
  noteEntryChange(ctx, {
    entry: synced,
    contentType,
    before: stored,
    after: normalized,
    locales: vctx.locales,
  });
  return { entry: synced, fields: normalized };
}

/**
 * What to validate: new fields for a content type, judged as a create (defaults applied), or a
 * whole new version of an existing entry, judged as an update (no defaults; its own unique values
 * don't collide with themselves).
 */
export type ValidateEntryInput =
  | { readonly contentTypeApiId: string; readonly fields: EntryFields }
  | { readonly entryId: string; readonly fields: EntryFields };

export interface EntryValidation {
  readonly valid: true;
  /**
   * The fields as the save would store them: defaults applied (a create), slugs normalized,
   * blocks keyed. A block `_key` minted here is not reserved; a save keeps the keys it is sent.
   */
  readonly fields: EntryFields;
  /**
   * Plugins registered for `entry:beforeSave` that did not run because they hold capabilities: on
   * a real save they could still rewrite or refuse these fields. Empty when every one ran.
   */
  readonly skippedHooks: readonly string[];
}

/**
 * Validates an entry without saving it: exactly the checks `createEntry` or `updateEntry` makes
 * before it writes (field validation, unique values, an archived entry refused), in the same
 * order, failing with the same errors, so an agent or an editor learns what a save would say
 * without leaving a version behind.
 *
 * It writes nothing. Of the `entry:beforeSave` plugins it runs only those holding no capability
 * (they can compute an answer and nothing else); a plugin that could write, store or fetch is
 * skipped and named in `skippedHooks`. Link targets aren't checked here because a save doesn't
 * check them either: the publish gate does.
 */
export async function validateEntry(
  ctx: AppContext,
  scope: Scope,
  input: ValidateEntryInput,
  options: Pick<EntryWriteOptions, 'unwritable'> = {},
): Promise<EntryValidation> {
  if ('entryId' in input) {
    const found = await ctx.store.entries.get(scope, input.entryId);
    if (!found) throw new NotFoundError('Entry', input.entryId);
    const contentType = await requireContentType(ctx, scope, found.entry.contentTypeApiId);
    const vctx = await loadValidationContext(ctx, scope);
    const { fields, skippedHooks } = await prepareFields(
      ctx,
      scope,
      contentType,
      { ...vctx, previous: found.fields },
      {
        contentTypeApiId: found.entry.contentTypeApiId,
        entryId: input.entryId,
        fields: withUnwritable(found.fields, input.fields, options),
      },
      'dry-run',
    );
    // The domain's own refusal (an archived entry can't take a new version), at the point a save
    // meets it.
    saveDraft(found.entry, fields);
    const claims = uniqueClaims(contentType, fields);
    if (claims.length > 0) {
      await assertClaimsFree(ctx.store.entries, scope, claims, input.entryId);
    }
    return { valid: true, fields, skippedHooks };
  }

  const contentType = await requireContentType(ctx, scope, input.contentTypeApiId);
  const vctx = await loadValidationContext(ctx, scope);
  const withDefaults = applyDefaults(contentType, input.fields, vctx.locales, vctx.defaultLocale);
  const { fields, skippedHooks } = await prepareFields(
    ctx,
    scope,
    contentType,
    asCreate(contentType, vctx),
    { contentTypeApiId: input.contentTypeApiId, fields: withDefaults },
    'dry-run',
  );
  const claims = uniqueClaims(contentType, fields);
  if (claims.length > 0) await assertClaimsFree(ctx.store.entries, scope, claims);
  return { valid: true, fields, skippedHooks };
}

// ---------------------------------------------------------------------------
// Trash lifecycle: trash → restore, or trash → purge
// ---------------------------------------------------------------------------

/**
 * Moves an entry to the trash, unpublishing it first when it is live.
 *
 * The domain refuses to archive a published entry, which is the right
 * invariant but the wrong seam for a person clicking "delete": trashing
 * something live is one intention. Doing both in one transaction keeps the
 * invariant and still emits `entry.unpublished`, so the worker clears the
 * delivery cache and the entry's embeddings exactly as it would for a manual
 * unpublish. Trashing an already-trashed entry is a no-op, so a retried
 * request cannot fail.
 */
export async function trashEntry(ctx: AppContext, scope: Scope, id: string): Promise<Entry> {
  return ctx.store.withTransaction(async (tx) => {
    const found = await tx.entries.get(scope, id);
    if (!found) throw new NotFoundError('Entry', id);
    if (found.entry.status === 'archived') return found.entry;
    await runHook(ctx, 'entry:beforeTrash', scope, {
      entryId: id,
      contentTypeApiId: found.entry.contentTypeApiId,
    });

    const base =
      found.entry.publishedVersion !== null
        ? await unpublishEntryTx(ctx, tx, scope, id)
        : found.entry;
    const archived = stampChanged(archive(base), actorOf(ctx));
    await tx.entries.saveAggregate(scope, archived);
    // A trashed entry gives its slug back: an editor who deleted "about"
    // expects to be able to create a new "about", not to be blocked by
    // something they can no longer see.
    await tx.entries.releaseUniqueClaims(scope, id);
    return archived;
  });
}

/** Brings a trashed entry back as a draft. Publishing it again is a separate act. */
export async function restoreEntry(ctx: AppContext, scope: Scope, id: string): Promise<Entry> {
  const found = await ctx.store.entries.get(scope, id);
  if (!found) throw new NotFoundError('Entry', id);
  const restored = stampChanged(restore(found.entry), actorOf(ctx));
  const contentType = await ctx.store.contentTypes.get(scope, found.entry.contentTypeApiId);
  // Out of the trash, it would be the singleton's second entry.
  if (contentType?.singleton) {
    await assertSingletonFree(ctx.store.entries, scope, contentType, id);
  }
  const claims = contentType ? uniqueClaims(contentType, found.fields) : [];

  if (claims.length === 0) {
    await ctx.store.entries.saveAggregate(scope, restored);
    return restored;
  }
  // Trashing released this entry's values, so someone may have taken one since.
  // Refusing with a message naming the holder is the honest outcome — silently
  // restoring a duplicate slug would break routing on the front end.
  await ctx.store.withTransaction(async (tx) => {
    await assertClaimsFree(tx.entries, scope, claims, id);
    await tx.entries.saveAggregate(scope, restored);
    await tx.entries.replaceUniqueClaims(scope, id, claims);
  });
  return restored;
}

export interface PurgeEntryOptions {
  /**
   * Delete even though other entries still link to this one, leaving those
   * links dangling. Off by default: the caller has to say they mean it.
   */
  readonly force?: boolean;
  /** Where its archived version bodies live (version-archive.ts), removed with it. */
  readonly blob?: BlobStore;
}

/**
 * Permanently deletes a trashed entry, its versions, its reference edges and
 * its taxonomy metadata. Irreversible.
 *
 * Only reachable from the trash, so "delete" is always two deliberate steps.
 * The entry is unpublished by definition at this point, so delivery and the
 * embeddings index were already cleaned when it was trashed — there is nothing
 * further to invalidate.
 */
export async function purgeEntry(
  ctx: AppContext,
  scope: Scope,
  id: string,
  options: PurgeEntryOptions = {},
): Promise<void> {
  await ctx.store.withTransaction(async (tx) => {
    const found = await tx.entries.get(scope, id);
    if (!found) throw new NotFoundError('Entry', id);
    if (found.entry.status !== 'archived') {
      throw new InvalidStateError('Move the entry to the trash before deleting it permanently');
    }
    await runHook(ctx, 'entry:beforePurge', scope, {
      entryId: id,
      contentTypeApiId: found.entry.contentTypeApiId,
    });

    // Reference edges are recorded at publish time, so this sees links from
    // PUBLISHED entries only — which is the set that matters: those are the
    // links delivery resolves per request, and purging under them turns into
    // broken references on live pages. A draft that links here is not serving
    // anything to anyone yet.
    if (!options.force) {
      const inbound = await tx.references.findReverse(scope, id);
      if (inbound.length > 0) {
        throw new ConflictError(
          `${inbound.length} published ${inbound.length === 1 ? 'entry links' : 'entries link'} to this one`,
          { referencedBy: inbound.map((e) => e.fromEntryId) },
        );
      }
    }

    await tx.references.removeForEntry(scope, id);
    await tx.taxonomy.setEntryMetadata(scope, id, EMPTY_METADATA);
    await tx.entries.releaseUniqueClaims(scope, id);
    await tx.entries.delete(scope, id);
  });

  // Comments and tasks live outside the transactional repo set, so they are
  // cleaned best-effort afterwards: an orphaned note is untidy, but failing the
  // delete after the entry is already gone would be worse.
  await Promise.all([
    ...(await ctx.store.comments.listForEntry(scope, id)).map((c) =>
      ctx.store.comments.delete(scope, c.id).catch(() => {}),
    ),
    ...(await ctx.store.tasks.listForEntry(scope, id)).map((t) =>
      ctx.store.tasks.delete(scope, t.id).catch(() => {}),
    ),
  ]);
  // Its archived version bodies, likewise best-effort: their rows are gone, so nothing reads them.
  await options.blob?.deletePrefix?.(versionBodyPrefix(scope, id), () => false).catch(() => {});
}

/**
 * Copies an entry into a new draft, including its taxonomy metadata.
 *
 * The display field gets a " (copy)" suffix so the two are tellable apart in a
 * list — truncated when the field declares a max size, since a duplicate that
 * fails validation because of the marker we added would be our bug, not the
 * user's.
 */
export async function duplicateEntry(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<EntryView> {
  const found = await ctx.store.entries.get(scope, id);
  if (!found) throw new NotFoundError('Entry', id);
  const contentType = await requireContentType(ctx, scope, found.entry.contentTypeApiId);

  const marked = markAsCopy(contentType, found.fields);
  // Every unique field would collide with the original, so give the copy free
  // values before trying to write it. Done here rather than by retrying on
  // conflict so the entry is created once, with a predictable slug.
  const fields = await freeUniqueValues(ctx, scope, contentType, marked);
  // A whole-entry copy: a field its rules disable carries what the original holds.
  const created = await createEntry(
    ctx,
    scope,
    { contentTypeApiId: found.entry.contentTypeApiId, fields },
    { copy: true },
  );

  const metadata = await ctx.store.taxonomy.getEntryMetadata(scope, id);
  if (metadata && (metadata.tags.length > 0 || metadata.concepts.length > 0)) {
    await ctx.store.taxonomy.setEntryMetadata(scope, created.entry.id, metadata);
  }
  return created;
}

/**
 * Rewrites unique field values until they are free: `about` → `about-2` → …
 *
 * Slug fields get the numeric suffix pattern; other unique scalars get the same
 * treatment on their string form, which is crude but predictable, and far
 * better than refusing to duplicate at all.
 */
async function freeUniqueValues(
  ctx: AppContext,
  scope: Scope,
  contentType: ContentType,
  fields: EntryFields,
): Promise<EntryFields> {
  if (!hasUniqueFields(contentType)) return fields;
  const out: EntryFields = { ...fields };

  for (const field of contentType.fields) {
    if (!field.unique) continue;
    const values = out[field.apiId];
    if (!values) continue;
    const next: Record<string, unknown> = { ...values };

    for (const [locale, value] of Object.entries(values)) {
      if (typeof value !== 'string' || value === '') continue;
      let candidate = value;
      // Bounded: a space with 50 copies of one slug is pathological, and
      // looping forever would be worse than a clear conflict error.
      for (let attempt = 2; attempt < 50; attempt++) {
        const conflicts = await ctx.store.entries.findUniqueConflicts(scope, [
          {
            contentTypeApiId: contentType.apiId,
            fieldApiId: field.apiId,
            locale,
            value: candidate,
          },
        ]);
        if (conflicts.length === 0) break;
        candidate = nextSlugCandidate(value, attempt);
      }
      next[locale] = candidate;
    }
    out[field.apiId] = next;
  }
  return out;
}

const COPY_SUFFIX = ' (copy)';

/** Appends the copy marker to every locale of the content type's display field. */
function markAsCopy(contentType: ContentType, fields: EntryFields): EntryFields {
  const display = contentType.fields.find((f) => f.apiId === contentType.displayField);
  const values = contentType.displayField ? fields[contentType.displayField] : undefined;
  if (!display || !values) return fields;

  const max = display.validations?.size?.max;
  const marked = Object.fromEntries(
    Object.entries(values).map(([locale, value]) => {
      if (typeof value !== 'string') return [locale, value];
      const next = value + COPY_SUFFIX;
      if (max === undefined || next.length <= max) return [locale, next];
      // Keep the marker and trim the title, not the other way round.
      return [locale, value.slice(0, Math.max(0, max - COPY_SUFFIX.length)) + COPY_SUFFIX];
    }),
  );
  return { ...fields, [contentType.displayField]: marked };
}
