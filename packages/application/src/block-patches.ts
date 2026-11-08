import {
  applyBlockPatch,
  authorizeContent,
  type BlockFieldIssue,
  type BlockOp,
  type BlockOutline,
  type BlockPatchIssue,
  blockAtPath,
  type ContentType,
  deniedFieldsFor,
  type Entry,
  type EntryFields,
  type FieldIssue,
  ForbiddenError,
  invertBlockPatch,
  type LocaleCode,
  NotFoundError,
  outlineBlocks,
  type Principal,
  type Scope,
  unwritableFieldsFor,
  ValidationError,
} from '@commerceworker/domain';
import type { AppContext } from './context';
import { type EntryView, getEntry, saveEntryDraft, validateEntry } from './entries';
import { assertExpectedVersion } from './publishing';

/**
 * Key-addressed edits to an entry's blocks fields (`block-patch.ts` in the domain), saved as a new
 * draft version through the same save a whole-entry edit makes (`saveEntryDraft`): validated,
 * hooked, versioned and noted for the audit trail as `updateEntry` is. One patch is one save, so
 * either every op lands or none does.
 */

/** The most ops one patch carries. */
export const BLOCK_PATCH_MAX_OPS = 100;
/** The largest `ops` one patch carries, serialized: as large as a bulk field edit's values. */
export const BLOCK_PATCH_MAX_BYTES = 64 * 1024;

/** An op as a caller sends it: the locale may be left out, for the space's default. */
export type BlockOpInput = BlockOp extends infer O
  ? O extends BlockOp
    ? Omit<O, 'locale'> & { readonly locale?: LocaleCode }
    : never
  : never;

export interface PatchEntryBlocksInput {
  /** The `currentVersion` the caller read: a patch addresses blocks it saw, so it is required. */
  readonly expectedVersion: number;
  readonly ops: readonly BlockOpInput[];
}

export interface PatchEntryBlocksOptions {
  /**
   * Top-level fields the caller's role denies or makes read-only (`unwritableFieldsFor`): an op
   * on one of them is refused, as sending it in a whole-entry save is.
   */
  readonly unwritable?: readonly string[];
  /**
   * Those of them the role denies outright (`deniedFieldsFor`): the caller can't read them either,
   * so a refusal counts them instead of naming them.
   */
  readonly unreadable?: readonly string[];
}

export interface BlockPatchView extends EntryView {
  /** The key each `ref` in the patch was given. */
  readonly keys: Readonly<Record<string, string>>;
  /**
   * The ops that undo this patch, applied to the version it saved (`invertBlockPatch`). Null when
   * the save stored other blocks than the patch made (an `entry:beforeSave` plugin rewrote them):
   * an undo built from the patch would not restore what was there, so none is offered.
   */
  readonly inverse: readonly BlockOp[] | null;
}

/**
 * Refuses a principal who may not write the entry's type, and answers the fields its role denies or
 * makes read-only, which `patchEntryBlocks` refuses ops on. One rule for both surfaces. Reads the
 * entry only for a principal with content grants; an unrestricted one writes every field.
 */
export async function authorizeBlockPatch(
  ctx: AppContext,
  scope: Scope,
  principal: Principal,
  id: string,
): Promise<PatchEntryBlocksOptions> {
  if (!principal.contentGrants) return {};
  const { entry } = await getEntry(ctx, scope, id);
  authorizeContent(principal, 'write', entry.contentTypeApiId);
  return {
    unwritable: unwritableFieldsFor(principal, entry.contentTypeApiId),
    unreadable: deniedFieldsFor(principal, entry.contentTypeApiId),
  };
}

/**
 * The issue a save's refusal makes of fields the caller can't read: counted, never named. A stored
 * value it may not see can still fail a rule (a required field left empty by someone else), and
 * its path and message would say what it holds.
 */
export interface HiddenFieldsIssue extends FieldIssue {
  readonly code: 'hidden';
  readonly hidden: number;
}

/**
 * A save's field issues as the caller may see them: each with the block it falls in, by key
 * (`blockAtPath`), since `body[1].label` says nothing once the patch has moved the blocks; and
 * those in fields it can't read folded into one issue that counts the fields.
 */
function withBlocks(
  err: unknown,
  contentType: ContentType,
  fields: EntryFields,
  defaultLocale: string,
  unreadable: readonly string[] = [],
): unknown {
  if (!(err instanceof ValidationError)) return err;
  const hidden = new Set<string>();
  const shown = err.issues.flatMap((issue): BlockFieldIssue[] => {
    const top = /^[A-Za-z]\w*/.exec(issue.field)?.[0] ?? '';
    if (unreadable.includes(top)) {
      hidden.add(top);
      return [];
    }
    const block = blockAtPath(contentType, fields, issue.locale ?? defaultLocale, issue.field);
    return [block ? { ...issue, block } : issue];
  });
  if (hidden.size === 0) return new ValidationError(shown);
  const n = hidden.size;
  const counted: HiddenFieldsIssue = {
    field: '',
    code: 'hidden',
    hidden: n,
    message: `${n} ${n === 1 ? 'field' : 'fields'} you can’t read ${n === 1 ? 'isn’t' : 'aren’t'} valid; someone who can read ${n === 1 ? 'it' : 'them'} has to fix ${n === 1 ? 'it' : 'them'} first`,
  };
  return new ValidationError([...shown, counted]);
}

/** A patch with every read and check done, ready to save (or to answer as a dry run). */
interface PreparedPatch {
  readonly entry: Entry;
  readonly contentType: ContentType;
  readonly config: { readonly defaultLocale: string; readonly locales: readonly string[] };
  /** The fields as the entry holds them, and as the patch leaves them (before the save's hook). */
  readonly before: EntryFields;
  readonly after: EntryFields;
  readonly ops: readonly BlockOp[];
  readonly applied: readonly BlockOp[];
  readonly keys: Readonly<Record<string, string>>;
  readonly inverse: readonly BlockOp[];
}

/**
 * Every check a patch makes before its save, in order: the caps, the entry at `expectedVersion`,
 * the caller's unwritable fields, the locales, then the ops themselves. One path for the save and
 * its dry run, so a dry run passes exactly when the save's own checks would.
 */
async function preparePatch(
  ctx: AppContext,
  scope: Scope,
  id: string,
  input: PatchEntryBlocksInput,
  options: PatchEntryBlocksOptions,
): Promise<PreparedPatch> {
  // The caps are judged on the request alone, before anything is read.
  const capped: { field: string; message: string }[] = [];
  if (input.ops.length === 0) capped.push({ field: 'ops', message: 'No ops to apply' });
  if (input.ops.length > BLOCK_PATCH_MAX_OPS) {
    capped.push({ field: 'ops', message: `At most ${BLOCK_PATCH_MAX_OPS} ops per patch` });
  }
  if (new TextEncoder().encode(JSON.stringify(input.ops)).length > BLOCK_PATCH_MAX_BYTES) {
    capped.push({ field: 'ops', message: `Ops exceed ${BLOCK_PATCH_MAX_BYTES} bytes` });
  }
  if (capped.length > 0) throw new ValidationError(capped);

  const { entry, fields } = await getEntry(ctx, scope, id);
  assertExpectedVersion(entry, input);
  const [contentType, config] = await Promise.all([
    ctx.store.contentTypes.get(scope, entry.contentTypeApiId),
    ctx.store.spaces.getConfig(scope),
  ]);
  if (!contentType) throw new NotFoundError('ContentType', entry.contentTypeApiId);
  if (!config) throw new NotFoundError('Space', scope.spaceId);

  // A field the caller can't read is counted, never named; one it can read but not write is named.
  const hidden = new Set(
    input.ops.flatMap((op) => (options.unreadable?.includes(op.field) ? [op.field] : [])),
  );
  if (hidden.size > 0) {
    throw new ForbiddenError(`content:write:${contentType.apiId}`, {
      reason: 'hidden',
      hidden: hidden.size,
    });
  }
  const blocked = input.ops.find((op) => options.unwritable?.includes(op.field));
  if (blocked) {
    throw new ForbiddenError(`content:write:${contentType.apiId}.${blocked.field}`, {
      reason: 'read_only',
      field: blocked.field,
    });
  }

  // Validation reads a localized field in the space's locales only, and a field that isn't
  // localized in the default locale only: a block put anywhere else would be stored and never read.
  const issues: BlockPatchIssue[] = [];
  const ops = input.ops.map((op, i) => {
    const locale = op.locale ?? config.defaultLocale;
    const def = contentType.fields.find((f) => f.apiId === op.field);
    const issue = (message: string) =>
      issues.push({ op: i, field: `ops[${i}]`, locale, code: 'bad_locale', message });
    if (!config.locales.includes(locale)) {
      issue(`"${locale}" is not one of this space’s locales`);
    } else if (def && !def.localized && locale !== config.defaultLocale) {
      issue(`"${op.field}" is not localized; only ${config.defaultLocale} is allowed`);
    }
    return { ...op, locale } as BlockOp;
  });
  if (issues.length > 0) throw new ValidationError(issues);

  const result = applyBlockPatch(contentType, fields, ops, () => ctx.ids.newId());
  if (!result.ok) throw new ValidationError(result.issues);
  const inverse = invertBlockPatch(contentType, fields, result.applied);
  // The applied ops carry every key they made, so they replay on the fields they came from; should
  // one not, the patch is refused as its op would have been, before anything is saved.
  if (!inverse.ok) throw new ValidationError(inverse.issues);
  return {
    entry,
    contentType,
    config,
    before: fields,
    after: result.fields,
    ops,
    applied: result.applied,
    keys: result.keys,
    inverse: inverse.ops,
  };
}

/**
 * Applies `ops` to the entry's blocks fields and saves the result as a new draft version. Refused
 * with 409 when the entry is no longer at `expectedVersion` (or another save takes the version
 * first), 403 for an op on a field the caller may not write, and 422 with the failing op's index
 * when an op can't apply; nothing is saved in any of these cases.
 */
export async function patchEntryBlocks(
  ctx: AppContext,
  scope: Scope,
  id: string,
  input: PatchEntryBlocksInput,
  options: PatchEntryBlocksOptions = {},
): Promise<BlockPatchView> {
  const prepared = await preparePatch(ctx, scope, id, input, options);
  const { entry, contentType, config, before, after } = prepared;
  const view = await saveEntryDraft(
    ctx,
    scope,
    entry,
    contentType,
    { defaultLocale: config.defaultLocale, locales: config.locales, previous: before },
    after,
    before,
  ).catch((err: unknown) => {
    throw withBlocks(err, contentType, after, config.defaultLocale, options.unreadable);
  });
  return { ...view, keys: prepared.keys, inverse: undoFor(prepared, view.fields) };
}

/**
 * The inverse, when the stored fields the patch wrote are the ones it made: after the hook, the
 * slugs and the block keys. A plugin that rewrote them leaves no undo to offer.
 */
function undoFor(prepared: PreparedPatch, stored: EntryFields): readonly BlockOp[] | null {
  const touched = new Set(prepared.ops.map((op) => op.field));
  const kept = [...touched].every(
    (apiId) => JSON.stringify(stored[apiId]) === JSON.stringify(prepared.after[apiId]),
  );
  return kept ? prepared.inverse : null;
}

export interface BlockPatchCheck {
  readonly valid: true;
  readonly contentTypeApiId: string;
  /** The draft's fields as the save would store them (after the hook, slugs and block keys). */
  readonly fields: EntryFields;
  /** The patch as it would apply: refs, positions and locales resolved, every key present. */
  readonly applied: readonly BlockOp[];
  /** The key each `ref` would be given; minted for this answer only, never stored. */
  readonly keys: Readonly<Record<string, string>>;
  /** Plugins on `entry:beforeSave` that hold capabilities and so did not run (`validateEntry`). */
  readonly skippedHooks: readonly string[];
}

/**
 * A dry run of {@link patchEntryBlocks}: the same checks, refused with the same errors (409, 403,
 * 422 with the op's index), then the result judged exactly as a save judges it (`validateEntry`),
 * and nothing written. What a confirm card shows before the person agrees to the patch.
 */
export async function checkEntryBlocks(
  ctx: AppContext,
  scope: Scope,
  id: string,
  input: PatchEntryBlocksInput,
  options: PatchEntryBlocksOptions = {},
): Promise<BlockPatchCheck> {
  const prepared = await preparePatch(ctx, scope, id, input, options);
  const judged = await validateEntry(
    ctx,
    scope,
    { entryId: id, fields: prepared.after },
    options.unwritable ? { unwritable: options.unwritable } : {},
  ).catch((err: unknown) => {
    throw withBlocks(
      err,
      prepared.contentType,
      prepared.after,
      prepared.config.defaultLocale,
      options.unreadable,
    );
  });
  return {
    valid: true,
    contentTypeApiId: prepared.entry.contentTypeApiId,
    fields: judged.fields,
    applied: prepared.applied,
    keys: prepared.keys,
    skippedHooks: judged.skippedHooks,
  };
}

export interface EntryBlocksOutline {
  readonly entryId: string;
  /** The version outlined: what a patch built from it passes as `expectedVersion`. */
  readonly version: number;
  /** Blocks field → locale → its blocks (`outlineBlocks`). */
  readonly fields: Readonly<Record<string, Readonly<Record<LocaleCode, readonly BlockOutline[]>>>>;
}

/**
 * The entry's blocks fields (the current draft) as a compact tree of keys, types and labels:
 * enough to build a patch without reading every value. Narrowed to one field or locale when given.
 */
export async function outlineEntryBlocks(
  ctx: AppContext,
  scope: Scope,
  id: string,
  opts: { readonly field?: string; readonly locale?: LocaleCode } = {},
): Promise<EntryBlocksOutline> {
  const { entry, fields } = await getEntry(ctx, scope, id);
  const contentType = await ctx.store.contentTypes.get(scope, entry.contentTypeApiId);
  if (!contentType) throw new NotFoundError('ContentType', entry.contentTypeApiId);
  return {
    entryId: entry.id,
    version: entry.currentVersion,
    fields: outlineBlocks(contentType, fields, opts),
  };
}
