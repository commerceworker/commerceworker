import {
  assertEntryFieldsValid,
  ConflictError,
  type ContentType,
  canAccessContentType,
  type Entry,
  type EntryFields,
  type EntryVersion,
  NotFoundError,
  type Principal,
  type Scope,
  SINGLETON_CLAIM_FIELD,
  stampChanged,
  stampCreated,
  type UniqueClaim,
  uniqueClaims,
  type ValidationContext,
} from '@commerceworker/domain';
import { saveContentTypeOver } from './content-types';
import { type AppContext, actorOf } from './context';
import {
  assertAssetMimeTypes,
  assertClaimsFree,
  assertSingletonFree,
  writeNewEntry,
} from './entries';
import { allPages } from './paging';
import { resolveEnvironment, resolveWritableEnvironment } from './spaces';

/** How an item in the source environment relates to the target. */
export type ChangeKind = 'added' | 'removed' | 'changed' | 'unchanged';

export interface ContentTypeChange {
  readonly apiId: string;
  readonly kind: ChangeKind;
}

export interface EntryChange {
  readonly entryId: string;
  readonly contentTypeApiId: string;
  readonly kind: ChangeKind;
}

/** A diff of two environments (what merging source→target would change). */
export interface EnvironmentComparison {
  readonly spaceId: string;
  readonly source: string;
  readonly target: string;
  readonly contentTypes: readonly ContentTypeChange[];
  readonly entries: readonly EntryChange[];
}

const scopeOf = (spaceId: string, environmentId: string): Scope => ({ spaceId, environmentId });
const eq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Structural projection of a content type (ignores the volatile version counter). */
const ctShape = (ct: ContentType) => ({
  name: ct.name,
  displayField: ct.displayField,
  fields: ct.fields,
  urlPattern: ct.urlPattern,
  group: ct.group,
  description: ct.description,
  icon: ct.icon,
  agentInstructions: ct.agentInstructions,
  layout: ct.layout,
  preview: ct.preview,
  status: ct.status,
});

function classify<T>(
  sourceItems: Map<string, T>,
  targetItems: Map<string, T>,
  same: (a: T, b: T) => boolean,
): Map<string, ChangeKind> {
  const out = new Map<string, ChangeKind>();
  for (const [key, s] of sourceItems) {
    const t = targetItems.get(key);
    if (!t) out.set(key, 'added');
    else out.set(key, same(s, t) ? 'unchanged' : 'changed');
  }
  for (const key of targetItems.keys()) {
    if (!sourceItems.has(key)) out.set(key, 'removed');
  }
  return out;
}

/**
 * Diffs two environments in a space: which content types and entries differ,
 * framed as the change merging source→target would apply. `removed` means the
 * item exists only in the target (merging source would not delete it — merges
 * here are additive/overwriting, never destructive).
 */
export async function compareEnvironments(
  ctx: AppContext,
  spaceId: string,
  source: string,
  target: string,
): Promise<EnvironmentComparison> {
  // Resolved as an `:env` is: an alias names its target, and a deleted environment is not found.
  const src = scopeOf(spaceId, await resolveEnvironment(ctx, spaceId, source));
  const tgt = scopeOf(spaceId, await resolveEnvironment(ctx, spaceId, target));

  const [srcTypes, tgtTypes] = await Promise.all([
    ctx.store.contentTypes.list(src),
    ctx.store.contentTypes.list(tgt),
  ]);
  const ctChanges = classify(
    new Map(srcTypes.map((c) => [c.apiId, c])),
    new Map(tgtTypes.map((c) => [c.apiId, c])),
    (a, b) => eq(ctShape(a), ctShape(b)),
  );

  // Every entry on both sides: the store's default page (100 on D1) compared only the first.
  const [srcEntries, tgtEntries] = await Promise.all([
    allPages((skip, limit) => ctx.store.entries.list(src, { skip, limit })),
    allPages((skip, limit) => ctx.store.entries.list(tgt, { skip, limit })),
  ]);
  const srcById = new Map(srcEntries.map((e) => [e.entry.id, e]));
  const tgtById = new Map(tgtEntries.map((e) => [e.entry.id, e]));
  const entryChanges = classify(srcById, tgtById, (a, b) => eq(a.fields, b.fields));

  return {
    spaceId,
    source,
    target,
    contentTypes: [...ctChanges].map(([apiId, kind]) => ({ apiId, kind })),
    entries: [...entryChanges].map(([entryId, kind]) => ({
      entryId,
      contentTypeApiId:
        srcById.get(entryId)?.entry.contentTypeApiId ??
        tgtById.get(entryId)?.entry.contentTypeApiId ??
        '',
      kind,
    })),
  };
}

/**
 * A comparison as `principal` may see it: only the content types it can read, and their entries.
 * A comparison spans every type, so a role limited to some sees part of one.
 */
export function comparisonFor(
  principal: Principal,
  comparison: EnvironmentComparison,
): EnvironmentComparison {
  const readable = (apiId: string) => canAccessContentType(principal, 'read', apiId);
  return {
    ...comparison,
    contentTypes: comparison.contentTypes.filter((c) => readable(c.apiId)),
    entries: comparison.entries.filter((e) => readable(e.contentTypeApiId)),
  };
}

export interface MergeSelection {
  /** apiIds of content types to copy source→target. */
  readonly contentTypes?: readonly string[];
  /** entry ids to copy source→target. */
  readonly entries?: readonly string[];
}

export interface MergeResult {
  readonly mergedContentTypes: readonly string[];
  readonly mergedEntries: readonly string[];
}

async function targetValidationContext(ctx: AppContext, scope: Scope): Promise<ValidationContext> {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  return { defaultLocale: config.defaultLocale, locales: config.locales };
}

/**
 * Applies selected content types and entries from `source` into `target`.
 * Content types are copied wholesale; entries are copied as a NEW draft version
 * in the target (preserving the entry id, validated against the target's content
 * type). The merge is additive/overwriting — it never deletes target content.
 */
export async function mergeEnvironments(
  ctx: AppContext,
  spaceId: string,
  source: string,
  target: string,
  selection: MergeSelection,
): Promise<MergeResult> {
  // The source resolves as a read, the target as a write: it must exist (or be an alias of one).
  const src = scopeOf(spaceId, await resolveEnvironment(ctx, spaceId, source));
  const tgt = scopeOf(spaceId, await resolveWritableEnvironment(ctx, spaceId, target));

  const mergedContentTypes: string[] = [];
  for (const apiId of selection.contentTypes ?? []) {
    const ct = await ctx.store.contentTypes.get(src, apiId);
    if (!ct) throw new NotFoundError('ContentType', `${source}/${apiId}`);
    await saveContentTypeOver(ctx, tgt, await ctx.store.contentTypes.get(tgt, apiId), ct);
    mergedContentTypes.push(apiId);
  }

  const plan: PlannedEntry[] = [];
  if (selection.entries?.length) {
    const vctx = await targetValidationContext(ctx, tgt);
    for (const entryId of selection.entries) {
      const found = await ctx.store.entries.get(src, entryId);
      if (!found) throw new NotFoundError('Entry', `${source}/${entryId}`);
      const targetCt = await ctx.store.contentTypes.get(tgt, found.entry.contentTypeApiId);
      if (!targetCt) {
        throw new NotFoundError(
          'ContentType',
          `${target}/${found.entry.contentTypeApiId} (include it in the merge)`,
        );
      }
      assertEntryFieldsValid(targetCt, found.fields, vctx);
      // Judged against the target's assets, as a save there would be.
      await assertAssetMimeTypes(ctx, tgt, targetCt, found.fields);
      const existing = (await ctx.store.entries.get(tgt, entryId))?.entry ?? null;
      // An entry the target holds in its trash stays there (as a promotion leaves it), so it
      // claims nothing: the trash released its values.
      const trashed = existing?.status === 'archived';
      plan.push({
        entryId,
        from: found.entry,
        contentType: targetCt,
        fields: found.fields,
        existing,
        claims: trashed ? [] : uniqueClaims(targetCt, found.fields),
      });
    }
    await assertPlanFree(ctx, tgt, plan);
  }

  // Entries the target already has first: a value one of them gives up (a swap) is then free
  // for the new entry that takes it.
  const order = [...plan.filter((p) => p.existing), ...plan.filter((p) => !p.existing)];
  for (const p of order) await applyEntry(ctx, tgt, p);

  return { mergedContentTypes, mergedEntries: plan.map((p) => p.entryId) };
}

/** One selected entry of a merge: its source fields and what the target holds of it. */
interface PlannedEntry {
  readonly entryId: string;
  /** The source's aggregate, whose authorship a new entry keeps. */
  readonly from: Entry;
  readonly contentType: ContentType;
  readonly fields: EntryFields;
  /** The target's copy, or null when the merge creates it. */
  readonly existing: Entry | null;
  /** The unique values it holds in the target afterwards (none while it stays in the trash). */
  readonly claims: readonly UniqueClaim[];
}

/** Clashes a merge's refusal names; the details carry them all. */
const CLASHES_NAMED = 10;

/**
 * Refuses a merge, before anything is written, whose entries would take a unique value (the
 * singleton's claim included) that the target holds outside the merge, or that two of them claim
 * together, naming each source entry and its holder. A value held by an entry of the merge that
 * gives it up (a swap) is free. A new entry of a singleton type is also refused while the target
 * has another entry outside the trash, as `createEntry` would refuse it.
 */
async function assertPlanFree(
  ctx: AppContext,
  tgt: Scope,
  plan: readonly PlannedEntry[],
): Promise<void> {
  const key = (c: Pick<UniqueClaim, 'contentTypeApiId' | 'fieldApiId' | 'locale' | 'value'>) =>
    `${c.contentTypeApiId}\u0000${c.fieldApiId}\u0000${c.locale}\u0000${c.value}`;
  const planned = new Set(plan.map((p) => p.entryId));
  const clashes: { entryId: string; field: string; value: string; heldBy: string }[] = [];
  const claimedBy = new Map<string, string>();
  for (const p of plan) {
    for (const c of p.claims) {
      const other = claimedBy.get(key(c));
      if (other) {
        clashes.push({ entryId: p.entryId, field: c.fieldApiId, value: c.value, heldBy: other });
      } else claimedBy.set(key(c), p.entryId);
    }
    if (p.claims.length > 0) {
      for (const held of await ctx.store.entries.findUniqueConflicts(tgt, p.claims, p.entryId)) {
        // Held by an entry of the merge: free if it gives the value up, a clash above if not.
        if (planned.has(held.entryId)) continue;
        clashes.push({
          entryId: p.entryId,
          field: held.fieldApiId,
          value: held.value,
          heldBy: held.entryId,
        });
      }
    }
    if (!p.existing && p.contentType.singleton) {
      const live = await ctx.store.entries.list(tgt, {
        contentTypeApiId: p.contentType.apiId,
        limit: plan.length + 1,
      });
      const other = live.find((e) => !planned.has(e.entry.id));
      if (other) {
        clashes.push({
          entryId: p.entryId,
          field: SINGLETON_CLAIM_FIELD,
          value: p.contentType.apiId,
          heldBy: other.entry.id,
        });
      }
    }
  }
  if (clashes.length === 0) return;
  const unique = [
    ...new Map(clashes.map((c) => [`${c.entryId}|${c.field}|${c.value}`, c])).values(),
  ];
  const named = unique
    .slice(0, CLASHES_NAMED)
    .map((c) =>
      c.field === SINGLETON_CLAIM_FIELD
        ? `entry ${c.entryId} would be a second entry of the singleton "${c.value}", whose entry is ${c.heldBy}`
        : `entry ${c.entryId} would take ${c.field} "${c.value}", which entry ${c.heldBy} holds`,
    );
  const more = unique.length > CLASHES_NAMED ? ` and ${unique.length - CLASHES_NAMED} more` : '';
  throw new ConflictError(
    `The merge would take unique values twice, so nothing was merged: ${named.join('; ')}${more}`,
    { conflicts: unique },
  );
}

/**
 * Creates the entry in the target (preserving id), or appends a new version to the target's copy
 * with its unique values claimed in the same unit, as `updateEntry` does. A copy in the target's
 * trash stays there, holding no claims. A new one is the source's, merged: like a promotion, it
 * keeps who created it, when, and when it was first published, and the merge's actor made its
 * latest change. One the target already has keeps its own.
 */
async function applyEntry(ctx: AppContext, tgt: Scope, p: PlannedEntry): Promise<void> {
  const { entryId, from, contentType, fields, existing } = p;
  const now = ctx.clock.now().toISOString();
  const actor = actorOf(ctx);
  if (!existing) {
    const entry = stampCreated(
      {
        id: entryId,
        contentTypeApiId: contentType.apiId,
        status: 'draft',
        currentVersion: 1,
        publishedVersion: null,
        ...(from.createdAt ? { createdAt: from.createdAt } : {}),
        ...(from.createdBy !== undefined ? { createdBy: from.createdBy } : {}),
        ...(from.firstPublishedAt ? { firstPublishedAt: from.firstPublishedAt } : {}),
      },
      actor,
      now,
    );
    const version: EntryVersion = { entryId, version: 1, fields, createdAt: now, createdBy: actor };
    // A singleton in the target already holding its entry takes no second one from the source,
    // and the new entry stakes its unique values (the singleton's claim among them) as a create
    // does, in the same guarded unit.
    if (contentType.singleton) await assertSingletonFree(ctx.store.entries, tgt, contentType);
    await writeNewEntry(ctx, tgt, contentType, entry, version, p.claims);
    return;
  }
  const nextVersion = existing.currentVersion + 1;
  const trashed = existing.status === 'archived';
  const entry = stampChanged(
    {
      ...existing,
      currentVersion: nextVersion,
      status: trashed ? 'archived' : existing.publishedVersion === null ? 'draft' : 'changed',
    },
    actor,
  );
  const version: EntryVersion = {
    entryId,
    version: nextVersion,
    fields,
    createdAt: now,
    createdBy: actor,
  };
  if (trashed) {
    await ctx.store.entries.saveVersion(tgt, entry, version);
    return;
  }
  await assertClaimsFree(ctx.store.entries, tgt, p.claims, entryId);
  await ctx.store.withTransaction(async (tx) => {
    await tx.entries.saveVersion(tgt, entry, version);
    // Replace rather than add: a value the source no longer holds is given back.
    await tx.entries.replaceUniqueClaims(tgt, entryId, p.claims);
  });
}
