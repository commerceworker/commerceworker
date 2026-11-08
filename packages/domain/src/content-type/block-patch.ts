import type { FieldIssue } from '../errors';
import type { EntryFields, LocaleCode } from '../types';
import type { ContentType } from './content-type';
import {
  BLOCK_KEY,
  BLOCK_TYPE_KEY,
  blockVariants,
  type ComponentVariant,
  type FieldDefinition,
  variantOf,
} from './field';
import { mayHoldBlocks } from './field-values';

/**
 * Key-addressed edits to a blocks field: insert, update, move, remove and duplicate one block,
 * addressed by its `_key` rather than its position, so an agent (or a live-preview client) can
 * change one block of a long page without resending the whole field, and without its edit landing
 * on the wrong block when someone reordered the page in between.
 *
 * Every op names a top-level blocks field and one locale of it; its keys are looked up in that
 * field's tree in that locale. A block's children are the blocks fields its variant declares
 * directly (its *slots*); blocks under a plain component or repeater inside a block are carried
 * along but not addressable here.
 *
 * `_key` is unique per array, not per tree: validation refuses two blocks sharing a key in one
 * field value at one level, but the same key at two depths (a section pasted inside itself with
 * its keys) is stored without complaint. Keys minted here are UUIDv7 and never collide, but a
 * caller-supplied one can, so an op that addresses a key held by more than one block in the tree
 * is refused as ambiguous rather than guessed at.
 *
 * A patch is all-or-nothing: the ops run in order against the result of the ones before, and the
 * first that can't apply refuses the whole patch with issues naming its index. Pure — the
 * use-case reads, saves and mints the ids.
 */

/** Where a block goes: into a parent block's slot, or the field itself when `parent` is absent. */
export interface BlockParent {
  /** The parent block's `_key` (or a `ref` an earlier op in the patch named). */
  readonly key: string;
  /** The blocks field of the parent's variant to put it in. */
  readonly slot: string;
}

/** A position in a slot: before or after a sibling, at an index, or at the end when none is given. */
export interface BlockPlace {
  readonly parent?: BlockParent;
  readonly before?: string;
  readonly after?: string;
  readonly index?: number;
}

interface BlockOpTarget {
  /** A top-level blocks field of the entry's content type. */
  readonly field: string;
  readonly locale: LocaleCode;
}

/**
 * Inserts a new block. Keys the block (and any blocks inside it) holds are kept, provided no
 * block in the field holds them already, and none is a ref of the patch; missing ones are minted.
 * `ref` names the new block for later ops on the same field and locale, and in the answer's key
 * map; ref names are unique across the patch.
 */
export interface InsertBlockOp extends BlockOpTarget, BlockPlace {
  readonly op: 'insert';
  readonly block: Readonly<Record<string, unknown>>;
  readonly ref?: string;
}

/**
 * Sets or clears named fields of one block; the fields it doesn't name keep their values. A field
 * that holds blocks is refused: its children change through the structural ops, so their keys
 * survive.
 */
export interface UpdateBlockOp extends BlockOpTarget {
  readonly op: 'update';
  readonly key: string;
  readonly set?: Readonly<Record<string, unknown>>;
  readonly unset?: readonly string[];
}

/** Moves a block (with its children) within the field: another slot, or another place in its own. */
export interface MoveBlockOp extends BlockOpTarget {
  readonly op: 'move';
  readonly key: string;
  readonly to: BlockPlace;
}

/** Removes a block and everything inside it. */
export interface RemoveBlockOp extends BlockOpTarget {
  readonly op: 'remove';
  readonly key: string;
}

/** Copies a block right after itself, with fresh keys on it and on every block inside it. */
export interface DuplicateBlockOp extends BlockOpTarget {
  readonly op: 'duplicate';
  readonly key: string;
  readonly ref?: string;
}

export type BlockOp =
  | InsertBlockOp
  | UpdateBlockOp
  | MoveBlockOp
  | RemoveBlockOp
  | DuplicateBlockOp;

export const BLOCK_OP_KINDS = ['insert', 'update', 'move', 'remove', 'duplicate'] as const;

/**
 * Why an op can't apply, as a stable code a client can act on without reading the message. The
 * message says the same in words, for a person or an agent reading it as is.
 */
export const BLOCK_PATCH_ISSUE_CODES = [
  'unknown_op',
  'not_a_blocks_field',
  'not_a_list',
  'unknown_key',
  'ambiguous_key',
  'keyless_parent',
  'unknown_type',
  'missing_type',
  'type_not_allowed',
  'not_a_slot',
  'bad_parent',
  'bad_position',
  'not_in_slot',
  'placed_by_itself',
  'into_itself',
  'bad_block',
  'key_taken',
  'key_is_ref',
  'bad_ref',
  'ref_taken',
  'ref_is_key',
  'nothing_to_update',
  'unknown_field',
  'holds_blocks',
  'set_and_unset',
  'not_invertible',
  'bad_locale',
] as const;
export type BlockPatchIssueCode = (typeof BLOCK_PATCH_ISSUE_CODES)[number];

/** A refusal, naming the op (its index in the patch) it came from. */
export interface BlockPatchIssue extends FieldIssue {
  readonly op: number;
  readonly code: BlockPatchIssueCode;
  /**
   * The existing block the refusal is about, by its `_key`, when there is one (the block that
   * can't be found has none): a client names it from its own read rather than from the message.
   */
  readonly key?: string;
}

export type BlockPatchResult =
  | {
      readonly ok: true;
      readonly fields: EntryFields;
      /** The key each `ref` was given. */
      readonly keys: Readonly<Record<string, string>>;
      /**
       * The patch as it applied, with nothing left to resolve: refs and before/after replaced by
       * keys and indexes, every inserted block (a duplicate's copy too) carrying all its keys.
       * What {@link invertBlockPatch} takes.
       */
      readonly applied: readonly BlockOp[];
    }
  | { readonly ok: false; readonly issues: readonly BlockPatchIssue[] };

/**
 * Applies `ops` to `fields`, returning the new fields or the issues of the first op that can't
 * apply. `newKey` mints a block key (`ctx.ids.newId`). `fields` is never mutated.
 */
export function applyBlockPatch(
  contentType: ContentType,
  fields: EntryFields,
  ops: readonly BlockOp[],
  newKey: () => string,
): BlockPatchResult {
  const run = runPatch(contentType, fields, ops, newKey);
  if (!run.ok) return run;
  return { ok: true, fields: run.fields, keys: run.keys, applied: run.applied };
}

/**
 * The ops that undo `ops` once applied to `before`: applied to the result, they give `before`
 * back (an emptied slot that was absent comes back as `[]`). `ops` are the `applied` ops
 * {@link applyBlockPatch} returned, which carry every key; ops that would have to mint one can't
 * be inverted, since what they minted is not in them. Refuses with the issues apply would give
 * when `ops` don't apply to `before`.
 */
export function invertBlockPatch(
  contentType: ContentType,
  before: EntryFields,
  ops: readonly BlockOp[],
): BlockPatchInversion {
  const run = runPatch(contentType, before, ops, () => {
    throw new MintRefused();
  });
  return run.ok ? { ok: true, ops: run.inverse } : run;
}

export type BlockPatchInversion =
  | { readonly ok: true; readonly ops: readonly BlockOp[] }
  | { readonly ok: false; readonly issues: readonly BlockPatchIssue[] };

// --- the outline -------------------------------------------------------------

/** One block in an entry's outline: what it is, where it is, and the blocks in its slots. */
export interface BlockOutline {
  readonly key: string | null;
  readonly type: string;
  /** Its variant's name ("Hero"); its `_type` when that names no variant. */
  readonly name: string;
  /** Its first non-empty text field, shortened: what an editor would call it. */
  readonly label?: string;
  /** Where it sits, as validation issues name fields: `body[2].items[0]`. */
  readonly path: string;
  /** Its key is held by another block in the tree too, so ops can't address it. */
  readonly ambiguous?: true;
  /** Its non-empty slots, by apiId. */
  readonly children?: Readonly<Record<string, readonly BlockOutline[]>>;
}

const LABEL_LENGTH = 60;

/**
 * The blocks fields of an entry as a compact tree: blocks field → locale → its blocks, each with
 * its key, type, label, path and children, and none of its other values. Enough to address any
 * block in a patch without reading the whole entry.
 */
export function outlineBlocks(
  contentType: ContentType,
  fields: EntryFields,
  opts: { readonly field?: string; readonly locale?: LocaleCode } = {},
): Record<string, Record<LocaleCode, readonly BlockOutline[]>> {
  const out: Record<string, Record<LocaleCode, readonly BlockOutline[]>> = {};
  for (const def of contentType.fields) {
    const variants = blockVariants(def);
    if (!variants || (opts.field !== undefined && def.apiId !== opts.field)) continue;
    const byLocale: Record<LocaleCode, readonly BlockOutline[]> = {};
    for (const [locale, value] of Object.entries(fields[def.apiId] ?? {})) {
      if (opts.locale !== undefined && locale !== opts.locale) continue;
      if (!Array.isArray(value)) continue;
      const counts = new Map<string, number>();
      for (const [key, held] of indexTree(value, variants)) counts.set(key, held.length);
      byLocale[locale] = outlineSlot(value, variants, def.apiId, counts);
    }
    out[def.apiId] = byLocale;
  }
  return out;
}

function outlineSlot(
  items: readonly unknown[],
  variants: readonly ComponentVariant[],
  path: string,
  counts: ReadonlyMap<string, number>,
): BlockOutline[] {
  const nodes: BlockOutline[] = [];
  items.forEach((item, index) => {
    if (!isRecord(item)) return;
    const at = `${path}[${index}]`;
    const key = keyOf(item) ?? null;
    const type = typeof item[BLOCK_TYPE_KEY] === 'string' ? String(item[BLOCK_TYPE_KEY]) : '';
    const variant = variantOf(variants, item);
    const children: Record<string, readonly BlockOutline[]> = {};
    for (const f of variant?.fields ?? []) {
      const slot = blockVariants(f);
      const value = item[f.apiId];
      if (slot && Array.isArray(value) && value.length > 0) {
        children[f.apiId] = outlineSlot(value, slot, `${at}.${f.apiId}`, counts);
      }
    }
    const label = variant ? labelOf(variant, item) : undefined;
    nodes.push({
      key,
      type,
      name: variant?.name ?? type,
      ...(label ? { label } : {}),
      path: at,
      ...(key !== null && (counts.get(key) ?? 0) > 1 ? { ambiguous: true as const } : {}),
      ...(Object.keys(children).length > 0 ? { children } : {}),
    });
  });
  return nodes;
}

function labelOf(variant: ComponentVariant, item: Record<string, unknown>): string | undefined {
  for (const f of variant.fields) {
    if (f.type !== 'Symbol' && f.type !== 'Text') continue;
    const value = item[f.apiId];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const text = value.trim().replace(/\s+/g, ' ');
    return text.length > LABEL_LENGTH ? `${text.slice(0, LABEL_LENGTH - 1)}…` : text;
  }
  return undefined;
}

// --- issues inside a block ---------------------------------------------------------

/**
 * The block a field issue's path falls in, by its key: validation names a value by position
 * (`body[1].label`), which says nothing once blocks move, so a patch's issue also carries the block
 * and the path inside it (`label`; empty for the block itself).
 */
export interface IssueBlock {
  readonly key: string;
  readonly type: string;
  readonly path: string;
}

/** A field issue, with the innermost keyed block its path falls in when it falls in one. */
export interface BlockFieldIssue extends FieldIssue {
  readonly block?: IssueBlock;
}

/** The innermost keyed block `path` (`body[1].items[0].label`) falls in, in `locale` of `fields`. */
export function blockAtPath(
  contentType: ContentType,
  fields: EntryFields,
  locale: LocaleCode,
  path: string,
): IssueBlock | undefined {
  const tokens = [...path.matchAll(/([A-Za-z]\w*)|\[(\d+)\]/g)];
  const top = tokens[0]?.[1];
  let def = contentType.fields.find((f) => f.apiId === top);
  let value: unknown = top !== undefined ? fields[top]?.[locale] : undefined;
  let defs: readonly FieldDefinition[] | undefined;
  let found: IssueBlock | undefined;
  for (const t of tokens.slice(1)) {
    if (t[2] !== undefined) {
      const item = Array.isArray(value) ? value[Number(t[2])] : undefined;
      const variants = def ? blockVariants(def) : undefined;
      if (variants && isRecord(item)) {
        const key = keyOf(item);
        const variant = variantOf(variants, item);
        if (key !== undefined && variant) {
          const rest = path.slice((t.index ?? 0) + t[0].length).replace(/^\./, '');
          found = { key, type: variant.apiId, path: rest };
        }
        defs = variant?.fields;
      } else {
        defs = def?.type === 'Array' ? def.items?.fields : undefined;
      }
      value = item;
    } else {
      def = (defs ?? (def?.type === 'Component' ? def.fields : undefined))?.find(
        (f) => f.apiId === t[1],
      );
      defs = def?.type === 'Component' ? def.fields : undefined;
      value = isRecord(value) && t[1] !== undefined ? value[t[1]] : undefined;
    }
  }
  return found;
}

// --- the engine ----------------------------------------------------------------

/** Thrown by invert's `newKey`: an op without its keys can't be replayed. */
class MintRefused extends Error {}

type Block = Record<string, unknown>;

/** Where one block sits in a field's tree. */
interface Location {
  readonly block: Block;
  /** The array holding it, and its index there. */
  readonly slot: unknown[];
  readonly index: number;
  /** The variants that array admits. */
  readonly variants: readonly ComponentVariant[];
  /** The block holding the array, and the array's apiId on it; absent at the field's top. */
  readonly parent?: BlockParent;
  /** Keys of every block above it. */
  readonly ancestors: readonly string[];
  /**
   * It sits in a slot of a block with no `_key`. Such a block's place can't be written down (an
   * inverse or a replay would name the field's top instead), so ops on it are refused.
   */
  readonly orphan?: true;
}

/** Every keyed block reachable through slots, by key; a key held twice has two locations. */
function indexTree(
  root: unknown[],
  variants: readonly ComponentVariant[],
): Map<string, Location[]> {
  const index = new Map<string, Location[]>();
  const walk = (
    slot: unknown[],
    admitted: readonly ComponentVariant[],
    parent: BlockParent | undefined,
    ancestors: readonly string[],
    orphan: boolean,
  ): void => {
    slot.forEach((item, i) => {
      if (!isRecord(item)) return;
      const key = keyOf(item);
      if (key !== undefined) {
        const at: Location = {
          block: item,
          slot,
          index: i,
          variants: admitted,
          ...(parent ? { parent } : {}),
          ancestors,
          ...(orphan ? { orphan: true as const } : {}),
        };
        index.set(key, [...(index.get(key) ?? []), at]);
      }
      const variant = variantOf(admitted, item);
      if (!variant) return;
      const below = key !== undefined ? [...ancestors, key] : ancestors;
      for (const f of variant.fields) {
        const child = blockVariants(f);
        const value = item[f.apiId];
        if (!child || !Array.isArray(value)) continue;
        // A keyless parent can't be named in `parent`; its children are indexed (their keys still
        // count for ambiguity) but marked, so an op on one is refused.
        walk(
          value,
          child,
          key !== undefined ? { key, slot: f.apiId } : undefined,
          below,
          key === undefined,
        );
      }
    });
  };
  walk(root, variants, undefined, [], false);
  return index;
}

interface RunOk {
  readonly ok: true;
  readonly fields: EntryFields;
  readonly keys: Record<string, string>;
  readonly applied: BlockOp[];
  readonly inverse: BlockOp[];
}
type RunResult = RunOk | { readonly ok: false; readonly issues: readonly BlockPatchIssue[] };

/** Why one op can't apply. Thrown inside an op, caught by the loop, tagged with the op's index. */
class OpRefused extends Error {
  constructor(
    readonly code: BlockPatchIssueCode,
    message: string,
    readonly key?: string,
  ) {
    super(message);
  }
}

function runPatch(
  contentType: ContentType,
  fields: EntryFields,
  ops: readonly BlockOp[],
  newKey: () => string,
): RunResult {
  // Copied per field on first touch, so the caller's fields are never mutated and untouched
  // fields are shared with the result as they are.
  const out: Record<string, Record<LocaleCode, unknown>> = { ...fields } as Record<
    string,
    Record<LocaleCode, unknown>
  >;
  const copied = new Set<string>();
  const refs = new Map<string, PatchRef>();
  const keys: Record<string, string> = {};
  const applied: BlockOp[] = [];
  const inverse: BlockOp[] = [];

  for (const [i, op] of ops.entries()) {
    const issue = (code: BlockPatchIssueCode, message: string, key?: string): BlockPatchIssue => ({
      op: i,
      field: `ops[${i}]`,
      ...(typeof op?.locale === 'string' ? { locale: op.locale } : {}),
      code,
      ...(key !== undefined ? { key } : {}),
      message,
    });
    try {
      const raw: unknown = op;
      if (!isRecord(raw) || !BLOCK_OP_KINDS.includes(op.op)) {
        throw new OpRefused('unknown_op', `Unknown op (one of: ${BLOCK_OP_KINDS.join(', ')})`);
      }
      const def = contentType.fields.find((f) => f.apiId === op.field);
      const rootVariants = def ? blockVariants(def) : undefined;
      if (!def || !rootVariants) {
        throw new OpRefused(
          'not_a_blocks_field',
          `"${op.field}" is not a blocks field of "${contentType.apiId}"`,
        );
      }
      if (!copied.has(def.apiId)) {
        out[def.apiId] = clone(fields[def.apiId] ?? {}) as Record<LocaleCode, unknown>;
        copied.add(def.apiId);
      }
      const localized = out[def.apiId] as Record<LocaleCode, unknown>;
      const held = localized[op.locale];
      if (held !== undefined && !Array.isArray(held)) {
        throw new OpRefused(
          'not_a_list',
          `${where(op)} holds something other than a list of blocks`,
        );
      }
      const tree = new Tree(op, rootVariants, localized, refs);
      const step = applyOne(tree, op, newKey);
      applied.push(step.applied);
      if (step.inverse) inverse.unshift(step.inverse);
      if (step.minted && (op.op === 'insert' || op.op === 'duplicate') && op.ref !== undefined) {
        refs.set(op.ref, { tree: tree.id, key: step.minted });
        keys[op.ref] = step.minted;
      }
    } catch (err) {
      if (err instanceof OpRefused)
        return { ok: false, issues: [issue(err.code, err.message, err.key)] };
      if (err instanceof MintRefused) {
        return {
          ok: false,
          issues: [
            issue(
              'not_invertible',
              'A block here has no _key: invert the applied ops, which carry them all',
            ),
          ],
        };
      }
      throw err;
    }
  }
  return { ok: true, fields: out as EntryFields, keys, applied, inverse };
}

const where = (op: BlockOpTarget): string => `${op.field} (${op.locale})`;

/**
 * A ref an earlier op named, and the tree (field and locale) its block is in. A ref resolves only
 * in its own tree: in another, the same string is taken as a key, so it can never reach a block in
 * a field or locale the op doesn't name. Ref names are unique across the patch, since `keys`
 * answers them by name alone.
 */
interface PatchRef {
  readonly tree: string;
  readonly key: string;
}

/** One op's view of the field it edits: lookups by key and places in slots. */
class Tree {
  readonly index: Map<string, Location[]>;
  readonly id: string;
  constructor(
    readonly op: BlockOp,
    readonly variants: readonly ComponentVariant[],
    readonly localized: Record<LocaleCode, unknown>,
    readonly refs: ReadonlyMap<string, PatchRef>,
  ) {
    const root = localized[op.locale];
    this.index = indexTree(Array.isArray(root) ? root : [], variants);
    this.id = `${op.field}\u0000${op.locale}`;
  }

  /** A key as given, or the key minted for it when it names a ref an earlier op gave in this tree. */
  resolve(key: string): string {
    const ref = this.refs.get(key);
    return ref?.tree === this.id ? ref.key : key;
  }

  /** The one block holding `key`; refused when none or several do. */
  find(key: string): Location {
    const resolved = this.resolve(key);
    const found = this.index.get(resolved) ?? [];
    if (found.length === 0)
      throw new OpRefused('unknown_key', `No block with _key "${key}" in ${where(this.op)}`);
    if (found.length > 1) {
      throw new OpRefused(
        'ambiguous_key',
        `_key "${key}" is held by ${found.length} blocks in ${where(this.op)}, so it can’t say ` +
          'which one: give one of them a new _key with a full save first',
        resolved,
      );
    }
    const at = found[0] as Location;
    if (at.orphan) {
      throw new OpRefused(
        'keyless_parent',
        `Block "${key}" sits in a block with no _key; save the entry once to key it`,
        resolved,
      );
    }
    return at;
  }

  /** The array a place names, and the variants it admits; created empty when absent. */
  slotOf(parent: BlockParent | undefined): {
    readonly slot: unknown[];
    readonly variants: readonly ComponentVariant[];
  } {
    if (!parent) {
      const held = this.localized[this.op.locale];
      if (Array.isArray(held)) return { slot: held, variants: this.variants };
      const slot: unknown[] = [];
      this.localized[this.op.locale] = slot;
      return { slot, variants: this.variants };
    }
    const at = this.find(parent.key);
    const variant = variantOf(at.variants, at.block);
    if (!variant)
      throw new OpRefused(
        'unknown_type',
        `Block "${parent.key}" names no known _type`,
        at.block[BLOCK_KEY] as string,
      );
    const def = variant.fields.find((f) => f.apiId === parent.slot);
    const variants = def ? blockVariants(def) : undefined;
    if (!variants) {
      throw new OpRefused(
        'not_a_slot',
        `"${parent.slot}" is not a blocks field of "${variant.apiId}" blocks`,
        parent.key,
      );
    }
    const held = at.block[parent.slot];
    if (Array.isArray(held)) return { slot: held, variants };
    if (held !== undefined) {
      throw new OpRefused(
        'not_a_slot',
        `"${parent.slot}" of block "${parent.key}" is not a list of blocks`,
        parent.key,
      );
    }
    const slot: unknown[] = [];
    at.block[parent.slot] = slot;
    return { slot, variants };
  }

  /** The index a place names in `slot` (which no longer holds a block being moved). */
  positionIn(slot: unknown[], place: BlockPlace): number {
    const given = [place.before, place.after, place.index].filter((v) => v !== undefined);
    if (given.length > 1)
      throw new OpRefused('bad_position', 'Give at most one of before, after and index');
    if (place.index !== undefined) {
      if (!Number.isInteger(place.index) || place.index < 0 || place.index > slot.length) {
        throw new OpRefused('bad_position', `index must be an integer from 0 to ${slot.length}`);
      }
      return place.index;
    }
    const sibling = place.before ?? place.after;
    if (sibling === undefined) return slot.length;
    const at = this.find(sibling);
    // Looked up in the slot as it is now: a move has taken its block out since the index was built.
    const index = slot.indexOf(at.block);
    if (at.slot !== slot || index < 0) {
      throw new OpRefused(
        'not_in_slot',
        `Block "${sibling}" is not in the target slot`,
        this.resolve(sibling),
      );
    }
    return place.before !== undefined ? index : index + 1;
  }

  /**
   * What an insert's own keys must avoid: every key the tree holds, and every ref of the patch (a
   * block keyed like a ref would be found by the ref's name and mistaken for the ref's block).
   */
  taken(): Set<string> {
    return new Set([...this.index.keys(), ...this.refs.keys()]);
  }
}

interface Step {
  readonly applied: BlockOp;
  /** Undoes the op on its result; absent when it changed nothing an undo must restore. */
  readonly inverse?: BlockOp;
  /** The key of the block an insert or duplicate made. */
  readonly minted?: string;
}

function applyOne(tree: Tree, op: BlockOp, newKey: () => string): Step {
  const target = { field: op.field, locale: op.locale };
  switch (op.op) {
    case 'insert': {
      const block = op.block;
      if (!isRecord(block)) throw new OpRefused('bad_block', 'block must be an object');
      checkRef(tree, op.ref);
      const { slot, variants } = tree.slotOf(op.parent && resolvedParent(tree, op.parent));
      admitted(variants, block);
      const taken = tree.taken();
      const copy = rekeyBlock(variants, clone(block), (old) => {
        if (old === undefined) return newKey();
        if (tree.refs.has(old)) {
          throw new OpRefused(
            'key_is_ref',
            `_key "${old}" is a ref in this patch; give the block another key`,
          );
        }
        if (taken.has(old)) {
          throw new OpRefused(
            'key_taken',
            `_key "${old}" is already held by a block in ${where(op)}`,
            old,
          );
        }
        taken.add(old);
        return old;
      });
      const index = tree.positionIn(slot, op);
      slot.splice(index, 0, copy);
      const key = copy[BLOCK_KEY] as string;
      return {
        applied: {
          op: 'insert',
          ...target,
          ...parentOf(op.parent, tree),
          index,
          block: clone(copy),
        },
        inverse: { op: 'remove', ...target, key },
        minted: key,
      };
    }
    case 'update': {
      const at = tree.find(op.key);
      const variant = variantOf(at.variants, at.block);
      if (!variant)
        throw new OpRefused(
          'unknown_type',
          `Block "${op.key}" names no known _type`,
          tree.resolve(op.key),
        );
      const set = op.set ?? {};
      if (!isRecord(set)) throw new OpRefused('bad_block', 'set must be an object');
      const unset = op.unset ?? [];
      const names = [...Object.keys(set), ...unset];
      if (names.length === 0)
        throw new OpRefused('nothing_to_update', 'Nothing to update: give set or unset');
      for (const name of names) {
        const f = variant.fields.find((d) => d.apiId === name);
        if (!f)
          throw new OpRefused(
            'unknown_field',
            `"${variant.apiId}" blocks have no field "${name}"`,
            tree.resolve(op.key),
          );
        if (mayHoldBlocks(f)) {
          throw new OpRefused(
            'holds_blocks',
            `"${name}" holds blocks: change them with insert, move, remove or duplicate`,
          );
        }
      }
      const both = unset.find((name) => Object.hasOwn(set, name));
      if (both) throw new OpRefused('set_and_unset', `"${both}" is both set and unset`);
      const key = tree.resolve(op.key);
      const restore: Record<string, unknown> = {};
      const clear: string[] = [];
      for (const name of new Set(names)) {
        if (at.block[name] === undefined) {
          if (Object.hasOwn(set, name)) clear.push(name);
        } else {
          restore[name] = clone(at.block[name]);
        }
      }
      for (const [name, value] of Object.entries(set)) at.block[name] = clone(value);
      for (const name of unset) delete at.block[name];
      const changed = Object.keys(restore).length > 0 || clear.length > 0;
      return {
        applied: {
          op: 'update',
          ...target,
          key,
          ...(Object.keys(set).length > 0 ? { set } : {}),
          ...(unset.length > 0 ? { unset } : {}),
        },
        ...(changed
          ? {
              inverse: {
                op: 'update',
                ...target,
                key,
                ...(Object.keys(restore).length > 0 ? { set: restore } : {}),
                ...(clear.length > 0 ? { unset: clear } : {}),
              },
            }
          : {}),
      };
    }
    case 'move': {
      const at = tree.find(op.key);
      const key = tree.resolve(op.key);
      const to = op.to ?? {};
      for (const sibling of [to.before, to.after]) {
        if (sibling !== undefined && tree.resolve(sibling) === key) {
          throw new OpRefused(
            'placed_by_itself',
            'A block can’t be placed before or after itself',
            key,
          );
        }
      }
      const parent = to.parent && resolvedParent(tree, to.parent);
      if (parent) {
        const holder = tree.find(parent.key);
        if (parent.key === key || holder.ancestors.includes(key)) {
          throw new OpRefused(
            'into_itself',
            'A block can’t be moved into itself or a block inside it',
            key,
          );
        }
      }
      const { slot, variants } = tree.slotOf(parent);
      admitted(variants, at.block, key);
      at.slot.splice(at.index, 1);
      // Positions are judged without the block being moved, so `index` is where it ends up.
      const index = tree.positionIn(slot, to);
      slot.splice(index, 0, at.block);
      return {
        applied: { op: 'move', ...target, key, to: { ...(parent ? { parent } : {}), index } },
        inverse: {
          op: 'move',
          ...target,
          key,
          to: { ...(at.parent ? { parent: at.parent } : {}), index: at.index },
        },
      };
    }
    case 'remove': {
      const at = tree.find(op.key);
      at.slot.splice(at.index, 1);
      return {
        applied: { op: 'remove', ...target, key: tree.resolve(op.key) },
        inverse: {
          op: 'insert',
          ...target,
          ...(at.parent ? { parent: at.parent } : {}),
          index: at.index,
          block: clone(at.block),
        },
      };
    }
    case 'duplicate': {
      const at = tree.find(op.key);
      checkRef(tree, op.ref);
      if (!variantOf(at.variants, at.block)) {
        throw new OpRefused(
          'unknown_type',
          `Block "${op.key}" names no known _type`,
          tree.resolve(op.key),
        );
      }
      const copy = rekeyBlock(at.variants, clone(at.block), () => newKey());
      const index = at.index + 1;
      at.slot.splice(index, 0, copy);
      const key = copy[BLOCK_KEY] as string;
      return {
        applied: {
          op: 'insert',
          ...target,
          ...(at.parent ? { parent: at.parent } : {}),
          index,
          block: clone(copy),
        },
        inverse: { op: 'remove', ...target, key },
        minted: key,
      };
    }
  }
}

/** A parent whose key may be a ref, with the key it stands for. */
function resolvedParent(tree: Tree, parent: BlockParent): BlockParent {
  if (!isRecord(parent) || typeof parent.key !== 'string' || typeof parent.slot !== 'string') {
    throw new OpRefused('bad_parent', 'parent must be { key, slot }');
  }
  return { key: tree.resolve(parent.key), slot: parent.slot };
}

const parentOf = (parent: BlockParent | undefined, tree: Tree) =>
  parent ? { parent: resolvedParent(tree, parent) } : {};

/** Refuses a ref that is reused or could be taken for a key. */
function checkRef(tree: Tree, ref: string | undefined): void {
  if (ref === undefined) return;
  if (typeof ref !== 'string' || ref === '')
    throw new OpRefused('bad_ref', 'ref must be a non-empty string');
  if (tree.refs.has(ref))
    throw new OpRefused('ref_taken', `ref "${ref}" is already used in this patch`);
  if (tree.index.has(ref))
    throw new OpRefused('ref_is_key', `ref "${ref}" is the _key of an existing block`, ref);
}

/** The variant `block` names, refused when the slot doesn't admit it. */
/**
 * The variant `block` names, refused when the slot doesn't admit it. `key` is the existing block
 * the refusal is about: a moved one; never a new block's own key, which names no existing block.
 */
function admitted(
  variants: readonly ComponentVariant[],
  block: Block,
  key?: string,
): ComponentVariant {
  const type = block[BLOCK_TYPE_KEY];
  const allowed = variants.map((v) => v.apiId).join(', ');
  if (typeof type !== 'string' || type === '') {
    throw new OpRefused('missing_type', `The block has no _type (one of: ${allowed})`, key);
  }
  const variant = variantOf(variants, block);
  if (!variant)
    throw new OpRefused(
      'type_not_allowed',
      `A "${type}" block can’t go here (one of: ${allowed})`,
      key,
    );
  return variant;
}

/**
 * `block` (already a copy) with every blocks element in it, itself included, keyed by `mint`,
 * which is given the key each held (or undefined). Walks plain components and repeaters too, so a
 * duplicate leaves no key of the original anywhere in the copy.
 */
function rekeyBlock(
  variants: readonly ComponentVariant[],
  block: Block,
  mint: (old: string | undefined) => string,
): Block {
  const key = mint(keyOf(block));
  const variant = variantOf(variants, block);
  const filled = variant ? rekeyObject(variant.fields, block, mint) : block;
  return { ...filled, [BLOCK_KEY]: key };
}

function rekeyObject(
  nested: readonly FieldDefinition[],
  value: Block,
  mint: (old: string | undefined) => string,
): Block {
  const out = { ...value };
  for (const f of nested) {
    const held = out[f.apiId];
    if (held === undefined) continue;
    if (f.type === 'Component') {
      if (isRecord(held)) out[f.apiId] = rekeyObject(f.fields ?? [], held, mint);
    } else if (f.type === 'Array' && f.items?.type === 'Component' && Array.isArray(held)) {
      const variants = blockVariants(f);
      const shape = f.items.fields ?? [];
      out[f.apiId] = held.map((item) => {
        if (!isRecord(item)) return item;
        return variants ? rekeyBlock(variants, item, mint) : rekeyObject(shape, item, mint);
      });
    }
  }
  return out;
}

/** A copy of a stored value; field values are JSON, so a JSON round trip copies them exactly. */
function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

const keyOf = (item: Block): string | undefined => {
  const key = item[BLOCK_KEY];
  return typeof key === 'string' && key !== '' ? key : undefined;
};

function isRecord(value: unknown): value is Block {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
