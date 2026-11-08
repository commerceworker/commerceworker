import {
  ConflictError,
  type ContentType,
  DomainError,
  defineContentType,
  deliveredContentType,
  fieldsLinkingTo,
  type LinkingField,
  menuTargets,
  NotFoundError,
  type Scope,
  ValidationError,
} from '@commerceworker/domain';
import {
  type BlobStore,
  type BulkItemFailure,
  type BulkJob,
  type BulkJobChunk,
  TransactionConflictError,
} from '@commerceworker/ports';
import { type BulkChunkOutcome, bulkMaxItemsOf, startBulkJob } from './bulk-jobs';
import {
  assertContentTypeCaller,
  authorizePreviewChange,
  type ContentTypeCaller,
} from './content-types';
import type { AppContext } from './context';
import { purgeEntry, trashEntry } from './entries';

/**
 * Deleting and cloning a content type. A delete removes a definition nothing depends on any
 * more: no entries (the trash included), no other type whose links are restricted to it, no menu
 * item or slug redirect naming one of its entries, no URL pattern a front end routes by. Or, at
 * the caller's choice, a resumable job deletes its entries first (each trashed, then purged, as
 * the single-entry use-cases do it) and the type once they are gone.
 */

/**
 * Entry ids read per page while listing the type's entries for the job: an id-only keyset read,
 * so a page this large is a few hundred kilobytes and the largest job a couple of dozen reads.
 */
const ID_PAGE = 5000;
/** Ids named per kind in a refusal's message; the details carry them all. */
const NAMED = 10;

/** What still depends on a content type: why a delete would be refused. */
export interface ContentTypeDependents {
  readonly contentType: string;
  /** Its entries outside the trash, and in it. */
  readonly entries: { readonly live: number; readonly trashed: number };
  /** Other types' fields whose links are restricted to it (components and blocks included). */
  readonly linkedFrom: readonly LinkingField[];
  /** Menus with an item linking one of its entries. */
  readonly menus: readonly { readonly id: string; readonly handle: string }[];
  /** Redirects made by a slug change of one of its entries (`origin: 'slug'`). */
  readonly redirects: readonly { readonly id: string; readonly source: string }[];
  /** Its URL pattern: Delivery's routes and sitemap serve it, and a front end routes by it. */
  readonly urlPattern?: string;
}

/**
 * Everything that depends on `apiId` in `scope`: what the admin shows before a delete, and what a
 * refused delete reports. Reads only: the type's entry counts (one grouped count), every type,
 * the menus and redirects (each capped by its own limit), and the entries those name.
 */
export async function contentTypeDependents(
  ctx: AppContext,
  scope: Scope,
  apiId: string,
): Promise<ContentTypeDependents> {
  const [type, kept, types, counts, menus, redirects] = await Promise.all([
    ctx.store.contentTypes.get(scope, apiId),
    ctx.store.contentTypes.publishedDefinitions(scope),
    ctx.store.contentTypes.list(scope),
    ctx.store.entries.countByStatus(scope),
    ctx.store.menus.all(scope),
    ctx.store.redirects.all(scope),
  ]);
  if (!type) throw new NotFoundError('ContentType', apiId);
  // The pattern Delivery serves, which a draft's change hasn't reached: a draft clearing it doesn't
  // take the type off the routes, so it doesn't free the type to go, and a draft adding one puts
  // nothing on them for a front end to route by yet.
  const { urlPattern } = deliveredContentType(type, kept.get(apiId) ?? null, false);
  let live = 0;
  let trashed = 0;
  for (const c of counts) {
    if (c.contentType !== apiId) continue;
    if (c.status === 'archived') trashed += c.count;
    else live += c.count;
  }

  // The entries menus and slug redirects name, read once, to see which are of this type. Only
  // when it has entries: without any, nothing can name one.
  const menuEntries = new Map(menus.map((m) => [m.id, menuTargets(m.items).entryIds]));
  const slugRedirects = redirects.filter((r) => r.origin === 'slug' && r.entryId);
  const named = new Set<string>([
    ...[...menuEntries.values()].flatMap((ids) => [...ids]),
    ...slugRedirects.map((r) => r.entryId as string),
  ]);
  const ours = new Set<string>();
  if (live + trashed > 0 && named.size > 0) {
    for (const e of await ctx.store.entries.getMany(scope, [...named])) {
      if (e.entry.contentTypeApiId === apiId) ours.add(e.entry.id);
    }
  }
  return {
    contentType: apiId,
    entries: { live, trashed },
    linkedFrom: fieldsLinkingTo(types, apiId),
    menus: menus
      .filter((m) => [...(menuEntries.get(m.id) ?? [])].some((id) => ours.has(id)))
      .map((m) => ({ id: m.id, handle: m.handle })),
    redirects: slugRedirects
      .filter((r) => ours.has(r.entryId as string))
      .map((r) => ({ id: r.id, source: r.source })),
    ...(urlPattern ? { urlPattern } : {}),
  };
}

const listed = (items: readonly string[]) =>
  items.slice(0, NAMED).join(', ') +
  (items.length > NAMED ? ` and ${items.length - NAMED} more` : '');

/** Why the dependents refuse a delete, one sentence each; `entries` false leaves them out. */
function blockers(d: ContentTypeDependents, entries: boolean): string[] {
  const out: string[] = [];
  const n = d.entries.live + d.entries.trashed;
  if (entries && n > 0) {
    out.push(
      `it has ${n} ${n === 1 ? 'entry' : 'entries'} (${d.entries.trashed} in the trash): delete ` +
        'them first, or delete them with the type (purgeEntries)',
    );
  }
  if (d.linkedFrom.length) {
    out.push(
      `other content types link to it: ${listed(d.linkedFrom.map((f) => `${f.contentType}.${f.field}`))}`,
    );
  }
  if (d.menus.length) out.push(`menus link its entries: ${listed(d.menus.map((m) => m.handle))}`);
  if (d.redirects.length) {
    out.push(`redirects point at its entries: ${listed(d.redirects.map((r) => r.source))}`);
  }
  if (d.urlPattern) {
    out.push(`its URL pattern ${d.urlPattern} is served as a site route: clear it first`);
  }
  return out;
}

function refuse(d: ContentTypeDependents, entries: boolean): void {
  const why = blockers(d, entries);
  if (why.length === 0) return;
  throw new ConflictError(`Cannot delete content type "${d.contentType}": ${why.join('; ')}.`, {
    dependents: d,
  });
}

/**
 * Deletes a content type nothing depends on (see {@link contentTypeDependents}), refusing with
 * every reason otherwise. One unit: the delete, which itself refuses a type revised since or an
 * entry written since the reads, and the `content_type.deleted` event. Losing the race to another
 * delete of the same type is a no-op.
 */
export async function deleteContentType(
  ctx: AppContext,
  scope: Scope,
  apiId: string,
): Promise<void> {
  const type = await ctx.store.contentTypes.get(scope, apiId);
  if (!type) throw new NotFoundError('ContentType', apiId);
  refuse(await contentTypeDependents(ctx, scope, apiId), true);
  try {
    await ctx.store.withTransaction(async (tx) => {
      await tx.contentTypes.delete(scope, apiId, type.version);
      await tx.outbox.append({
        id: ctx.ids.newId(),
        type: 'content_type.deleted',
        scope,
        occurredAt: ctx.clock.now().toISOString(),
        contentTypeApiId: apiId,
        version: type.version,
      });
    });
  } catch (err) {
    if (!(err instanceof TransactionConflictError)) throw err;
    // Another delete won: done. Otherwise the type changed, or gained an entry, since the reads.
    if (!(await ctx.store.contentTypes.get(scope, apiId))) return;
    throw new ConflictError(
      `Content type "${apiId}" changed or gained an entry while it was being deleted; try again`,
    );
  }
}

/** What a delete did: the type is gone, or a job is deleting its entries first. */
export type ContentTypeDeletion =
  | { readonly deleted: true }
  | { readonly deleted: false; readonly job: BulkJob };

/**
 * Deletes a content type together with its entries: refused for every reason a plain delete is
 * but the entries, then a resumable bulk job (`content_type_delete`) trashes and purges each entry
 * through the single-entry use-cases, and the type is deleted when the job completes cleanly
 * (`finishContentTypeDeletion`). A type with no entries is deleted at once.
 */
export async function deleteContentTypeWithEntries(
  ctx: AppContext,
  scope: Scope,
  apiId: string,
): Promise<ContentTypeDeletion> {
  const dependents = await contentTypeDependents(ctx, scope, apiId);
  refuse(dependents, false);
  const max = bulkMaxItemsOf('content_type_delete');
  const n = dependents.entries.live + dependents.entries.trashed;
  const tooMany = () =>
    new ValidationError([
      {
        field: 'purgeEntries',
        message: `"${apiId}" has more than ${max} entries: delete some first`,
      },
    ]);
  // Counted already: refuse past the cap before reading a single id.
  if (n > max) throw tooMany();
  const ids: string[] = [];
  for (let after: string | undefined; ; ) {
    const page = await ctx.store.entries.idsOfType(scope, apiId, {
      limit: ID_PAGE,
      ...(after ? { after } : {}),
    });
    ids.push(...page);
    if (ids.length > max) throw tooMany();
    if (page.length < ID_PAGE) break;
    after = page[page.length - 1];
  }
  if (ids.length === 0) {
    await deleteContentType(ctx, scope, apiId);
    return { deleted: true };
  }
  const job = await startBulkJob(ctx, scope, {
    action: 'content_type_delete',
    entryIds: ids,
    config: { contentType: apiId },
  });
  return { deleted: false, job };
}

/** The content type a `content_type_delete` job deletes. */
export const contentTypeOfJob = (job: Pick<BulkJob, 'config'>): string | undefined => {
  const t = (job.config as { contentType?: unknown } | undefined)?.contentType;
  return typeof t === 'string' ? t : undefined;
};

/**
 * The chunk runner for `content_type_delete` jobs: each entry of the chunk trashed (unpublished
 * first when live, as `trashEntry` does), then purged (`purgeEntry`). A purge is forced only past
 * links from entries of the same type, which the job deletes too; a link from any other published
 * entry keeps that entry, as a failure the report names, and so keeps the type.
 *
 * Safe to run twice: an entry already gone counts as done; one already trashed is purged.
 */
export function contentTypePurgeChunkRunner(
  ctx: AppContext,
  deps: { readonly blob?: BlobStore } = {},
): (scope: Scope, job: BulkJob, chunk: BulkJobChunk) => Promise<BulkChunkOutcome> {
  return async (scope, job, chunk) => {
    const apiId = contentTypeOfJob(job);
    if (!apiId) throw new Error(`Job ${job.id} names no content type`);
    const found = new Map(
      (await ctx.store.entries.getMany(scope, chunk.entryIds)).map((e) => [e.entry.id, e.entry]),
    );
    const failures: BulkItemFailure[] = [];
    for (const id of chunk.entryIds) {
      const entry = found.get(id);
      if (!entry) continue;
      try {
        if (entry.contentTypeApiId !== apiId) {
          failures.push({ id, error: `Not an entry of "${apiId}"` });
          continue;
        }
        if (entry.status !== 'archived') await trashEntry(ctx, scope, id);
        const inbound = (await ctx.store.references.findReverse(scope, id))
          .map((r) => r.fromEntryId)
          .filter((from) => from !== id);
        let force = false;
        if (inbound.length > 0) {
          const from = await ctx.store.entries.getMany(scope, inbound);
          force = from.every((e) => e.entry.contentTypeApiId === apiId);
        }
        await purgeEntry(ctx, scope, id, { force, ...(deps.blob ? { blob: deps.blob } : {}) });
      } catch (err) {
        // A rule's refusal is this entry's outcome; anything else (the database) fails the chunk.
        if (!(err instanceof DomainError)) throw err;
        failures.push({ id, error: err.message });
      }
    }
    return { succeeded: chunk.entryIds.length - failures.length, failures };
  };
}

/**
 * What became of the type a `content_type_delete` job deletes, recorded in the job's `config` as
 * `typeDeletion` once it is decided: when the job completes (`finishContentTypeDeletion`) or is
 * stopped. Absent while that is still to come, so REST, MCP and the admin wait for it, not only
 * for the job's status.
 */
export type ContentTypeDeletionOutcome =
  | { readonly deleted: true }
  | { readonly deleted: false; readonly reason: string };

/** The job's recorded {@link ContentTypeDeletionOutcome}, or undefined while undecided. */
export const contentTypeDeletionOf = (
  job: Pick<BulkJob, 'config'>,
): ContentTypeDeletionOutcome | undefined => {
  const o = (job.config as { typeDeletion?: ContentTypeDeletionOutcome } | undefined)?.typeDeletion;
  return o && typeof o.deleted === 'boolean' ? o : undefined;
};

/**
 * The last step of a `content_type_delete` job, on its `bulk.job_completed` event: with every
 * entry gone, the type goes too (`deleteContentType`, so a type that gained a dependent while the
 * job ran is kept). After a failure it stays, beside the entries the report names. Either way the
 * outcome is recorded on the job (`typeDeletion`). Safe to run twice: a type already gone is a
 * no-op, recorded as deleted. Returns why it kept the type, or null.
 */
export async function finishContentTypeDeletion(
  ctx: AppContext,
  scope: Scope,
  jobId: string,
): Promise<string | null> {
  const job = await ctx.store.bulkJobs.getJob(scope, jobId);
  const apiId = job ? contentTypeOfJob(job) : undefined;
  if (!job || !apiId || job.action !== 'content_type_delete') return null;
  const kept = await (async (): Promise<string | null> => {
    if (job.status !== 'completed') return `the job was ${job.status}`;
    if (job.failed > 0) {
      return `${job.failed} ${job.failed === 1 ? 'entry' : 'entries'} could not be deleted`;
    }
    try {
      if (await ctx.store.contentTypes.get(scope, apiId)) {
        await deleteContentType(ctx, scope, apiId);
      }
      return null;
    } catch (err) {
      if (err instanceof DomainError) return err.message;
      throw err;
    }
  })();
  const typeDeletion: ContentTypeDeletionOutcome =
    kept === null ? { deleted: true } : { deleted: false, reason: kept };
  await ctx.store.bulkJobs.mergeConfig(scope, jobId, { typeDeletion });
  return kept;
}

/**
 * Copies a content type's definition under `newApiId` and `name`: its fields, display field and
 * singleton flag, as a new draft at version 1 with no entries. Not its URL pattern, which would
 * route the same paths to two types. A link restricted to the source type stays restricted to it.
 * A copied preview URL is set on the new type, so `caller` is held to `authorizePreviewChange`
 * for it.
 */
export async function cloneContentType(
  ctx: AppContext,
  caller: ContentTypeCaller,
  scope: Scope,
  source: string,
  newApiId: string,
  name: string,
): Promise<ContentType> {
  assertContentTypeCaller(caller);
  const [from, taken] = await Promise.all([
    ctx.store.contentTypes.get(scope, source),
    ctx.store.contentTypes.get(scope, newApiId),
  ]);
  if (!from) throw new NotFoundError('ContentType', source);
  if (taken) throw new ConflictError(`A content type "${newApiId}" already exists`);
  authorizePreviewChange(caller, newApiId, undefined, from.preview);
  // The copy keeps what the source holds as it stands: a loopback URL saved on a local stack too.
  const clone = defineContentType(
    {
      apiId: newApiId,
      name,
      displayField: from.displayField,
      fields: [...from.fields],
      ...(from.singleton ? { singleton: true } : {}),
      ...(from.group ? { group: from.group } : {}),
      ...(from.description ? { description: from.description } : {}),
      ...(from.icon ? { icon: from.icon } : {}),
      ...(from.agentInstructions ? { agentInstructions: from.agentInstructions } : {}),
      ...(from.layout ? { layout: from.layout } : {}),
      ...(from.preview ? { preview: from.preview } : {}),
    },
    { previewLoopback: true },
  );
  // Insert-only: a clone (or create) of the same apiId that landed after the read keeps its type.
  try {
    await ctx.store.contentTypes.create(scope, clone);
  } catch (err) {
    if (!(err instanceof TransactionConflictError)) throw err;
    throw new ConflictError(`A content type "${newApiId}" already exists`);
  }
  return clone;
}
