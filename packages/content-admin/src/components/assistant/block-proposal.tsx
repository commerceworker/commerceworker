/**
 * A proposed block patch, as its confirm card reads it: the api's dry run of the very call that
 * runs on Confirm (`POST …/entries/blocks/validate`, `checkEntryBlocks`), so what the card says is
 * what the save would do. Its steps and its review name blocks by their type's name and label, from
 * the keys the api answers with, never by key and never by position; a refusal is read from the
 * api's structured answer (a 409's versions, a 403's details, a 422's issue code and block key),
 * never from its wording.
 */

import {
  applyBlockPatch,
  BLOCK_PATCH_ISSUE_CODES,
  type BlockOp,
  type BlockOutline,
  type BlockPatchIssueCode,
  blockVariants,
  type ComponentVariant,
  type ContentType,
  type EntryFields,
  type FieldDefinition,
  outlineBlocks,
} from '@commerceworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { TriangleAlert } from 'lucide-react';
import { ApiError, type EntryBlocksOutline, type ManagementClient } from '../../lib/management';
import { entryRef } from '../dashboard/entry-titles';
import { valueText } from '../EntryDiff';
import type { ReviewField } from '../entries/EntryReview';

/** Why a block patch can't be confirmed as it stands, as its dry run answered. */
export type BlockRefusal =
  /** The draft moved past the version the patch was made for: the save would be refused. */
  | { readonly why: 'moved'; readonly now?: number; readonly expected: number }
  /** A step doesn't apply to the draft, said in the card's words from the issue's code. */
  | { readonly why: 'step'; readonly step: number; readonly text: string }
  /** The result breaks a rule of the content model, where it would break it. */
  | { readonly why: 'invalid'; readonly where: string; readonly message: string }
  /** It edits fields this person can't read (their role can't write them either), counted. */
  | { readonly why: 'hidden'; readonly count: number }
  /** Fields this person can't read hold values a save refuses, counted: never named. */
  | { readonly why: 'hiddenInvalid'; readonly count: number }
  /** It edits a field this person can read but whose role makes it read-only. */
  | { readonly why: 'locked'; readonly field: string }
  /** The role can't change this entry at all. */
  | { readonly why: 'denied' }
  | { readonly why: 'nothing' }
  /** The call doesn't say which entry, at which version, or what to change. */
  | { readonly why: 'unclear' };

/** What the card shows of a patch the api would save. */
export interface BlockPatchRead {
  readonly status: 'ready';
  readonly title: string;
  /** Each step in words: what it does to which block, and where. */
  readonly steps: readonly string[];
  /** What changes: each touched slot's order, then each updated block's fields. */
  readonly fields: readonly ReviewField[];
}

export type BlockPatchReview =
  | BlockPatchRead
  | { readonly status: 'refused'; readonly title?: string; readonly refusal: BlockRefusal };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// --- the blocks of a draft, by key -----------------------------------------------

/** One field's tree in one locale: keys are unique only there (a copied locale keeps them). */
const treeOf = (field: string, locale: string) => `${field}\u0000${locale}`;
const at = (field: string, locale: string, key: string) => `${treeOf(field, locale)}\u0000${key}`;
/** A slot: a field's top in one locale, or a parent block's blocks field. */
const slotOf = (field: string, locale: string, parent?: { key: string; slot: string }) =>
  `${treeOf(field, locale)}\u0000${parent ? `${parent.key}\u0000${parent.slot}` : ''}`;
/** A block of a slot's tree, by key. */
const inSlot = (slot: string, key: string) =>
  `${slot.split('\u0000').slice(0, 2).join('\u0000')}\u0000${key}`;
/** The locale a slot's tree is in. */
const localeOfSlot = (slot: string) => slot.split('\u0000')[1] ?? '';

/** A draft's blocks, read from its outline: names, slots in order, and where each keyed one is. */
interface BlockIndex {
  /** "Hero “Spring launch”", or the type's name alone, by tree and key (or placeholder). */
  readonly names: Map<string, string>;
  /** The variant each keyed block is, for its fields' names. */
  readonly variants: Map<string, ComponentVariant>;
  /**
   * Each non-empty slot's blocks in order: a keyed block by its key, one with no key by a
   * placeholder (its type and how many of that type came before it), so positions line up with
   * the stored list the api's indexes count.
   */
  readonly slots: Map<string, string[]>;
  /** The slot each keyed block sits in. */
  readonly home: Map<string, string>;
  /** Each slot as a person reads it: "Body", "Section “Features” › Items". */
  readonly labels: Map<string, string>;
}

/** A keyless block's stand-in: stable across moves of its siblings, never a real key. */
const KEYLESS = '\u0001';

function indexBlocks(type: ContentType, fields: EntryFields): BlockIndex {
  const index: BlockIndex = {
    names: new Map(),
    variants: new Map(),
    slots: new Map(),
    home: new Map(),
    labels: new Map(),
  };
  const outline = outlineBlocks(type, fields);
  for (const def of type.fields) {
    const variants = blockVariants(def);
    if (!variants) continue;
    for (const [locale, nodes] of Object.entries(outline[def.apiId] ?? {})) {
      const walk = (
        list: readonly BlockOutline[],
        admitted: readonly ComponentVariant[],
        slot: string,
        label: string,
      ) => {
        index.labels.set(slot, label);
        const ids: string[] = [];
        const seen = new Map<string, number>();
        for (const n of list) {
          const name = n.label ? `${n.name} “${n.label}”` : n.name;
          if (n.key === null) {
            const nth = seen.get(n.type) ?? 0;
            seen.set(n.type, nth + 1);
            const id = `${KEYLESS}${n.type}#${nth}`;
            if (!index.names.has(at(def.apiId, locale, id)))
              index.names.set(at(def.apiId, locale, id), name);
            ids.push(id);
            continue;
          }
          const id = at(def.apiId, locale, n.key);
          const variant = admitted.find((v) => v.apiId === n.type);
          index.names.set(id, name);
          if (variant) index.variants.set(id, variant);
          index.home.set(id, slot);
          ids.push(n.key);
          for (const [child, kids] of Object.entries(n.children ?? {})) {
            const slotDef = variant?.fields.find((f) => f.apiId === child);
            walk(
              kids,
              (slotDef && blockVariants(slotDef)) ?? [],
              slotOf(def.apiId, locale, { key: n.key, slot: child }),
              `${name} › ${slotDef?.name ?? child}`,
            );
          }
        }
        index.slots.set(slot, ids);
      };
      walk(nodes, variants, slotOf(def.apiId, locale), def.name);
    }
  }
  return index;
}

/** The block a key names in one tree of `fields`, as stored. */
function findBlock(fields: EntryFields, field: string, locale: string, key: string) {
  const search = (v: unknown): Record<string, unknown> | undefined => {
    if (Array.isArray(v)) {
      for (const x of v) {
        const found = search(x);
        if (found) return found;
      }
    } else if (isRecord(v)) {
      if (v._key === key) return v;
      for (const x of Object.values(v)) {
        const found = search(x);
        if (found) return found;
      }
    }
    return undefined;
  };
  return search(fields[field]?.[locale]);
}

/** A variant by its apiId anywhere in a blocks field's tree of variants (for a block not yet read). */
function variantNamed(def: FieldDefinition, type: string): ComponentVariant | undefined {
  const search = (
    variants: readonly ComponentVariant[],
    seen: Set<ComponentVariant>,
  ): ComponentVariant | undefined => {
    for (const v of variants) {
      if (seen.has(v)) continue;
      seen.add(v);
      if (v.apiId === type) return v;
      for (const f of v.fields) {
        const inner = blockVariants(f);
        const found = inner ? search(inner, seen) : undefined;
        if (found) return found;
      }
    }
    return undefined;
  };
  const variants = blockVariants(def);
  return variants ? search(variants, new Set()) : undefined;
}

/**
 * The draft before each applied step, from the applied ops themselves (they carry every key and
 * position, so the domain's own patch replays them with nothing to mint). This decides only how a
 * step is worded; what the save does is the api's answer. Stops where one doesn't replay, so a
 * step past it is said without where it lands.
 */
function statesBefore(
  type: ContentType,
  before: EntryFields,
  applied: readonly BlockOp[],
): EntryFields[] {
  const states = [before];
  for (const op of applied) {
    try {
      const next = applyBlockPatch(type, states.at(-1) as EntryFields, [op], () => {
        throw new Error('An applied op carries its keys');
      });
      if (!next.ok) break;
      states.push(next.fields);
    } catch {
      break;
    }
  }
  return states;
}

// --- steps in words ------------------------------------------------------------------

/**
 * Where a block lands in `ids` (the slot without it) at `index`: the start, the end, after a
 * sibling, or into an empty slot. A move goes "to" the start; an insert lands "at" it.
 */
function landing(
  ids: readonly string[],
  index: number,
  where: string,
  name: (id: string) => string,
  verb: 'move' | 'insert',
): string {
  if (ids.length === 0) return `into ${where}`;
  if (index <= 0) return `${verb === 'move' ? 'to' : 'at'} the start of ${where}`;
  if (index >= ids.length) return `to the end of ${where}`;
  return `after ${name(ids[index - 1] as string)}`;
}

function stepText(
  verb: unknown,
  applied: BlockOp,
  state: BlockIndex | undefined,
  after: BlockIndex,
  type: ContentType,
  shown: string,
): string {
  const { field, locale } = applied;
  const name = (id: string) =>
    state?.names.get(at(field, locale, id)) ?? after.names.get(at(field, locale, id)) ?? 'a block';
  const fieldName = type.fields.find((f) => f.apiId === field)?.name ?? field;
  /**
   * Where a block goes: the field, or the slot of the block that takes it ("Section “Features” ›
   * Items", since a block may have several), and where in it when the draft before the step is
   * known.
   */
  const destination = (
    key: string,
    parent: { key: string; slot: string } | undefined,
    index: number | undefined,
    how: 'move' | 'insert',
  ) => {
    const target = slotOf(field, locale, parent);
    // A block with one place for blocks is named alone; one with several, by the place too.
    const host = parent
      ? (state?.variants.get(at(field, locale, parent.key)) ??
        after.variants.get(at(field, locale, parent.key)))
      : undefined;
    const places = host?.fields.filter((f) => blockVariants(f)).length ?? 1;
    const where = !parent
      ? fieldName
      : places > 1
        ? (state?.labels.get(target) ?? after.labels.get(target) ?? name(parent.key))
        : name(parent.key);
    if (!state || index === undefined) return `in ${where}`;
    const ids = (state.slots.get(target) ?? []).filter((k) => k !== key);
    const place = landing(ids, index, where, name, how);
    // A block crossing into another block's slot says which one, when its place names only a sibling.
    const crossing = state.home.get(at(field, locale, key)) !== target;
    return crossing && place.startsWith('after ') && parent ? `into ${where}, ${place}` : place;
  };
  let text: string;
  if (applied.op === 'insert') {
    const key = String(applied.block._key);
    text =
      verb === 'duplicate'
        ? `Duplicates ${name(findOriginal(applied, state, after) ?? key)}`
        : `Adds ${after.names.get(at(field, locale, key)) ?? 'a block'} ${destination(key, applied.parent, applied.index, 'insert')}`;
  } else if (applied.op === 'move') {
    text = `Moves ${name(applied.key)} ${destination(applied.key, applied.to.parent, applied.to.index, 'move')}`;
  } else if (applied.op === 'update') {
    text = `Changes ${name(applied.key)}`;
  } else {
    text = `Removes ${name(applied.key)}`;
  }
  return locale === shown ? text : `${text} (${locale})`;
}

/** A duplicate's original: the block right before its copy, in the draft before the step. */
function findOriginal(
  applied: Extract<BlockOp, { op: 'insert' }>,
  state: BlockIndex | undefined,
  after: BlockIndex,
): string | undefined {
  const slot = slotOf(applied.field, applied.locale, applied.parent);
  const ids = (state ?? after).slots.get(slot) ?? [];
  const index = applied.index ?? ids.length;
  return ids[index - 1];
}

// --- what changes ------------------------------------------------------------------

/** Two values the same as stored, whatever they read as (two links both read "Linked entry"). */
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * A slot's order before and after, by name. Whether it changed is judged by keys, never names:
 * two blocks of one name swapping places is a change. Names a slot holds twice are numbered.
 */
function orderRow(slot: string, before: BlockIndex, after: BlockIndex) {
  const was = before.slots.get(slot) ?? [];
  const now = after.slots.get(slot) ?? [];
  if (was.join('\u0000') === now.join('\u0000')) return undefined;
  const nameOf = (id: string) =>
    before.names.get(inSlot(slot, id)) ?? after.names.get(inSlot(slot, id)) ?? 'A block';
  const ids = [...new Set([...was, ...now])];
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(nameOf(id), (counts.get(nameOf(id)) ?? 0) + 1);
  const numbered = new Map<string, string>();
  const nth = new Map<string, number>();
  for (const id of ids) {
    const n = nameOf(id);
    if ((counts.get(n) ?? 0) < 2) numbered.set(id, n);
    else {
      const i = (nth.get(n) ?? 0) + 1;
      nth.set(n, i);
      numbered.set(id, `${n} (${i})`);
    }
  }
  const read = (list: readonly string[]) =>
    list.map((id) => numbered.get(id) ?? 'A block').join(' · ') || 'No blocks';
  return { before: read(was), after: read(now) };
}

/**
 * What a patch changes, by key: each slot a structural step touches as its order before and after
 * (by block name), each new block's own fields (what Coworker would write), then each updated
 * block's fields, before and after. Never by position: a text diff of a list compares whichever
 * blocks sit at the same index.
 */
function reviewOf(
  verbs: readonly unknown[],
  applied: readonly BlockOp[],
  states: readonly BlockIndex[],
  before: BlockIndex,
  after: BlockIndex,
  beforeFields: EntryFields,
  afterFields: EntryFields,
  shown: string,
): ReviewField[] {
  const slots = new Set<string>();
  const added: { field: string; locale: string; key: string }[] = [];
  const updates = new Map<
    string,
    { field: string; locale: string; key: string; names: Set<string> }
  >();
  applied.forEach((op, i) => {
    const state = states[i] ?? before;
    const { field, locale } = op;
    if (op.op === 'insert') {
      slots.add(slotOf(field, locale, op.parent));
      // A copy holds nothing new; a new block's content is what Coworker would write.
      if (verbs[i] !== 'duplicate') added.push({ field, locale, key: String(op.block._key) });
    } else if (op.op === 'move') {
      slots.add(slotOf(field, locale, op.to.parent));
      const from = state.home.get(at(field, locale, op.key));
      if (from) slots.add(from);
    } else if (op.op === 'remove') {
      const from = state.home.get(at(field, locale, op.key));
      if (from) slots.add(from);
    } else if (op.op === 'update') {
      const id = at(field, locale, op.key);
      const entry = updates.get(id) ?? { field, locale, key: op.key, names: new Set<string>() };
      for (const n of [...Object.keys(op.set ?? {}), ...(op.unset ?? [])]) entry.names.add(n);
      updates.set(id, entry);
    }
  });
  const out: ReviewField[] = [];
  const located = (locale: string) => (locale !== shown ? { locale } : {});
  for (const a of added) {
    const id = at(a.field, a.locale, a.key);
    const variant = after.variants.get(id);
    // Its own blocks are its slots, read as an order like any other.
    for (const f of variant?.fields ?? [])
      if (blockVariants(f)) slots.add(slotOf(a.field, a.locale, { key: a.key, slot: f.apiId }));
  }
  for (const slot of slots) {
    const row = orderRow(slot, before, after);
    if (!row) continue;
    out.push({
      field: `order:${slot}`,
      name: after.labels.get(slot) ?? before.labels.get(slot) ?? 'Blocks',
      kind: 'changed',
      rows: [{ ...located(localeOfSlot(slot)), ...row }],
    });
  }
  for (const a of added) {
    const id = at(a.field, a.locale, a.key);
    const name = after.names.get(id) ?? 'A new block';
    const block = findBlock(afterFields, a.field, a.locale, a.key);
    for (const f of after.variants.get(id)?.fields ?? []) {
      const value = valueText(block?.[f.apiId]);
      if (blockVariants(f) || !value) continue;
      out.push({
        field: `added:${id}:${f.apiId}`,
        name: `${name} › ${f.name}`,
        kind: 'added',
        rows: [{ ...located(a.locale), before: '', after: value }],
      });
    }
  }
  for (const [id, u] of updates) {
    const name = before.names.get(id) ?? after.names.get(id) ?? 'A block';
    const variant = after.variants.get(id) ?? before.variants.get(id);
    const was = findBlock(beforeFields, u.field, u.locale, u.key);
    const now = findBlock(afterFields, u.field, u.locale, u.key);
    for (const apiId of u.names) {
      // Judged on the stored values: a link pointed elsewhere reads the same, and still changed.
      if (same(was?.[apiId], now?.[apiId])) continue;
      const b = valueText(was?.[apiId]);
      const a = valueText(now?.[apiId]);
      out.push({
        field: `update:${id}:${apiId}`,
        name: `${name} › ${variant?.fields.find((f) => f.apiId === apiId)?.name ?? apiId}`,
        kind:
          was?.[apiId] === undefined ? 'added' : now?.[apiId] === undefined ? 'removed' : 'changed',
        rows: [{ ...located(u.locale), before: b, after: a }],
      });
    }
  }
  return out;
}

// --- refusals from the api's answer ------------------------------------------------

interface Issue {
  readonly op?: number;
  readonly code?: string;
  readonly key?: string;
  readonly field?: string;
  readonly locale?: string;
  readonly message?: string;
  readonly block?: { readonly key: string; readonly type: string; readonly path: string };
  /** On the issue that counts fields the caller can't read (`code: 'hidden'`). */
  readonly hidden?: number;
}

const issuesOf = (err: ApiError): Issue[] => {
  const issues = (err.body as { error?: { issues?: unknown } } | undefined)?.error?.issues;
  return Array.isArray(issues) ? (issues as Issue[]) : [];
};

const isIssueCode = (code: unknown): code is BlockPatchIssueCode =>
  typeof code === 'string' && (BLOCK_PATCH_ISSUE_CODES as readonly string[]).includes(code);

/**
 * A step's refusal in the card's words, from its code and the block its key names: one sentence
 * per code, so a new code fails to compile here until it has its own.
 */
function stepRefusal(
  issue: Issue & { readonly code: BlockPatchIssueCode },
  field: string,
  index: BlockIndex,
  type: ContentType,
  shown: string,
): string {
  const locale = issue.locale ?? '';
  const name = issue.key ? index.names.get(at(field, locale, issue.key)) : undefined;
  const fieldName = type.fields.find((f) => f.apiId === field)?.name ?? field;
  const inField = locale && locale !== shown ? `${fieldName} (${locale})` : fieldName;
  const it = name ?? 'The block it names';
  switch (issue.code) {
    case 'unknown_key':
      return `${inField} has no block with the key it names.`;
    case 'ambiguous_key':
      return `Two blocks in ${inField} share the key it names, so it can’t tell which one.`;
    case 'keyless_parent':
      return `${it} sits in a block with no key; save the entry once to give it one.`;
    case 'unknown_type':
      return `${it} is of a type ${fieldName} doesn’t declare.`;
    case 'missing_type':
      return 'The new block doesn’t say what type it is.';
    case 'type_not_allowed':
      return name
        ? `${name} can’t go there: that place doesn’t take its type.`
        : 'A block of that type can’t go there.';
    case 'not_a_slot':
      return `${it} has no place for blocks by the name the step gives.`;
    case 'bad_parent':
      return 'It names the block to put it in without saying which of its places.';
    case 'bad_position':
      return 'It gives a place in the list that doesn’t exist, or more than one.';
    case 'not_in_slot':
      return `${it} isn’t in the place this step puts the block.`;
    case 'placed_by_itself':
      return `${it} can’t be placed before or after itself.`;
    case 'into_itself':
      return `${it} can’t move into itself or a block inside it.`;
    case 'bad_block':
      return 'The block or the values it gives aren’t ones a block can hold.';
    case 'key_taken':
      return `The new block’s key is already ${name ? `${name}’s` : 'another block’s'}.`;
    case 'key_is_ref':
      return 'The new block’s key is a name another step uses for a new block.';
    case 'bad_ref':
    case 'ref_taken':
    case 'ref_is_key':
      return 'It names a new block with a name that is empty or already taken.';
    case 'nothing_to_update':
      return 'It changes a block without saying what to change.';
    case 'unknown_field':
      return `${it} has no field by the name the step gives.`;
    case 'holds_blocks':
      return `${it} keeps its blocks in a field a change can’t set; they move, get added or removed as blocks.`;
    case 'set_and_unset':
      return 'It both sets and clears the same field.';
    case 'not_a_blocks_field':
      return `${fieldName} isn’t a field of blocks.`;
    case 'not_a_list':
      return `${inField} doesn’t hold a list of blocks.`;
    case 'bad_locale':
      return `${fieldName} can’t hold blocks in ${locale || 'that locale'}.`;
    case 'unknown_op':
      return 'It asks for a change that isn’t one of add, change, move, remove or duplicate.';
    case 'not_invertible':
      return 'It can’t be undone as written.';
  }
}

/**
 * Where a rule breaks: the block by name and the field inside it, or the field by name. A new
 * block (its key minted by the api, so not in the draft) is named by its type.
 */
function ruleWhere(issue: Issue, index: BlockIndex, type: ContentType): string {
  const top = /^[A-Za-z]\w*/.exec(issue.field ?? '')?.[0] ?? '';
  const def = type.fields.find((f) => f.apiId === top);
  const block = issue.block;
  if (block && def) {
    const id = at(def.apiId, issue.locale ?? '', block.key);
    const variant = index.variants.get(id) ?? variantNamed(def, block.type);
    const name =
      index.names.get(id) ?? (variant ? `The new ${variant.name.toLowerCase()}` : 'A new block');
    const first = /^[A-Za-z]\w*/.exec(block.path)?.[0];
    const inner = variant?.fields.find((f) => f.apiId === first)?.name;
    return inner ? `${name} › ${inner}` : name;
  }
  return def?.name ?? (issue.field || 'The entry');
}

/**
 * What a block patch would make of the draft, from its dry run: the api's own checks with nothing
 * written. What would refuse the save on Confirm is said instead, in words; any other failure is a
 * failed read, offered again.
 */
export async function readBlockPatch(
  client: ManagementClient,
  p: {
    readonly entryId: string;
    readonly expectedVersion?: number;
    readonly ops: readonly unknown[];
  },
  types: readonly ContentType[],
  locale: string,
): Promise<BlockPatchReview> {
  const { expectedVersion } = p;
  if (!p.entryId || expectedVersion === undefined || p.ops.length === 0)
    return { status: 'refused', refusal: { why: 'unclear' } };
  let read: [Awaited<ReturnType<ManagementClient['getEntry']>>, EntryBlocksOutline];
  try {
    read = await Promise.all([client.getEntry(p.entryId), client.getBlocksOutline(p.entryId)]);
  } catch (err) {
    // Not this person's to read, so not theirs to change: a refusal, never Try again.
    if (err instanceof ApiError && err.status === 403)
      return { status: 'refused', refusal: { why: 'denied' } };
    throw err;
  }
  const [entry, outline] = read;
  const title = entryRef(entry, types, locale).title;
  const type = types.find((t) => t.apiId === entry.contentType);
  if (!type) throw new Error(`No content type "${entry.contentType}"`);
  const refused = (refusal: BlockRefusal): BlockPatchReview => ({
    status: 'refused',
    title,
    refusal,
  });
  // A shortcut, not the rule: a blocks field missing from the outline is one this person can't
  // read, and the dry run would refuse it the same way (a 403 counting it).
  const hidden = new Set(
    p.ops.flatMap((op) => {
      const f = isRecord(op) ? type.fields.find((d) => d.apiId === op.field) : undefined;
      return f && blockVariants(f) && !(f.apiId in outline.fields) ? [f.apiId] : [];
    }),
  );
  if (hidden.size > 0) return refused({ why: 'hidden', count: hidden.size });

  const beforeFields = entry.fields as EntryFields;
  const before = indexBlocks(type, beforeFields);
  let checked: Awaited<ReturnType<ManagementClient['checkBlockPatch']>>;
  try {
    checked = await client.checkBlockPatch(p.entryId, { expectedVersion, ops: p.ops });
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    const details = (err.body as { error?: { details?: Record<string, unknown> } } | undefined)
      ?.error?.details;
    if (err.status === 409) {
      const now = details?.currentVersion;
      return refused({
        why: 'moved',
        expected: expectedVersion,
        ...(typeof now === 'number' ? { now } : {}),
      });
    }
    // Every 403 is a refusal: a field named, fields counted, or the entry itself.
    if (err.status === 403) {
      if (details?.reason === 'hidden' && typeof details.hidden === 'number')
        return refused({ why: 'hidden', count: details.hidden });
      if (details?.reason === 'read_only' && typeof details.field === 'string') {
        const field = type.fields.find((f) => f.apiId === details.field)?.name ?? details.field;
        return refused({ why: 'locked', field });
      }
      return refused({ why: 'denied' });
    }
    if (err.status !== 422) throw err;
    const issues = issuesOf(err);
    const issue = issues[0];
    if (!issue) throw err;
    // Fields this person can't read come counted, after any they can: a rule they can act on first.
    if (issue.code === 'hidden' && typeof issue.hidden === 'number')
      return refused({ why: 'hiddenInvalid', count: issue.hidden });
    const code = issue.code;
    if (typeof issue.op === 'number' && isIssueCode(code)) {
      const op = p.ops[issue.op];
      const field = isRecord(op) && typeof op.field === 'string' ? op.field : '';
      return refused({
        why: 'step',
        step: issue.op + 1,
        text: stepRefusal({ ...issue, code }, field, before, type, locale),
      });
    }
    // The call's own shape (`ops.2.to`), or a code this card doesn't know: a step it can't read.
    const shape = /^ops\.(\d+)/.exec(issue.field ?? '');
    const unread = typeof issue.op === 'number' ? issue.op : shape ? Number(shape[1]) : undefined;
    if (unread !== undefined) {
      return refused({
        why: 'step',
        step: unread + 1,
        text: `Coworker wrote this step in a way the api can’t read (${issue.message ?? 'invalid'}).`,
      });
    }
    return refused({
      why: 'invalid',
      where: ruleWhere(issue, before, type),
      message: issue.message ?? 'It isn’t valid',
    });
  }
  const afterFields = checked.fields;
  const after = indexBlocks(type, afterFields);
  const states = statesBefore(type, beforeFields, checked.applied).map((s, i) =>
    i === 0 ? before : indexBlocks(type, s),
  );
  const verbs = checked.applied.map((_, i) => {
    const op = p.ops[i];
    return isRecord(op) ? op.op : undefined;
  });
  const fields = reviewOf(
    verbs,
    checked.applied,
    states,
    before,
    after,
    beforeFields,
    afterFields,
    locale,
  );
  if (fields.length === 0) return refused({ why: 'nothing' });
  const steps = checked.applied.map((step, i) =>
    stepText(verbs[i], step, states[i], after, type, locale),
  );
  return { status: 'ready', title, steps, fields };
}

// --- the refusal, said ----------------------------------------------------------------

const ASK_AGAIN = 'Choose Not now, then ask again.';

/** `text`, ending in a full stop unless it already ends a sentence. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** Why a refused block patch can't be confirmed, for the hold line Confirm is described by. */
export function refusalHold(refusal: BlockRefusal): string {
  switch (refusal.why) {
    case 'moved':
      return 'You can’t confirm this: the entry changed after it was proposed.';
    case 'step':
      return `You can’t confirm this: step ${refusal.step} doesn’t fit this entry.`;
    case 'invalid':
      return 'You can’t confirm this: the entry wouldn’t be valid after it.';
    case 'locked':
      return 'You can’t confirm this: it changes a field your role can’t change.';
    case 'denied':
      return 'You can’t confirm this: your role can’t change this entry.';
    case 'hidden':
      return 'You can’t confirm this: it changes a field you can’t read.';
    case 'hiddenInvalid':
      return 'You can’t confirm this: a field you can’t read isn’t valid.';
    case 'nothing':
      return 'You can’t confirm this: it changes nothing in the draft.';
    case 'unclear':
      return 'You can’t confirm this: it doesn’t say what to change.';
  }
}

const note = (text: string) => <p className="text-muted-foreground text-xs">{text}</p>;

function Refused({ title, children }: { title: string; children: string }) {
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p className="break-words">
          {sentence(children)} {ASK_AGAIN}
        </p>
      </AlertDescription>
    </Alert>
  );
}

/** A block patch that can't be saved as it stands, in words: what is wrong and what to do. */
export function BlockRefused({ refusal }: { refusal: BlockRefusal }) {
  switch (refusal.why) {
    case 'moved':
      return (
        <Refused title="The entry changed after this was proposed">
          {refusal.now === undefined
            ? `This change was made for version ${refusal.expected} of its draft, which has been saved since`
            : `Its draft is at version ${refusal.now}; this change was made for version ${refusal.expected}`}
        </Refused>
      );
    case 'step':
      return (
        <Refused title={`Step ${refusal.step} doesn’t fit this entry`}>{refusal.text}</Refused>
      );
    case 'invalid':
      return (
        <Refused title="The entry wouldn’t be valid after this">
          {`${refusal.where}: ${refusal.message}`}
        </Refused>
      );
    case 'locked':
      return (
        <Refused title={`Your role can’t change ${refusal.field}`}>
          You can read it, but your role makes it read-only, so this change can’t be saved
        </Refused>
      );
    case 'denied':
      return (
        <Refused title="Your role can’t change this entry">
          You can read this entry, but your role can’t save it, so this change can’t be saved
        </Refused>
      );
    case 'hidden':
      // Counted, never left out: the person's role can't write what it can't read either.
      return (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertDescription>
            {refusal.count} {refusal.count === 1 ? 'field' : 'fields'} you can’t read{' '}
            {refusal.count === 1 ? 'is' : 'are'} in this change, so it can’t be saved.
          </AlertDescription>
        </Alert>
      );
    case 'hiddenInvalid':
      // Counted, never named, as the other fields this person can't read.
      return (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertDescription>
            {refusal.count} {refusal.count === 1 ? 'field' : 'fields'} you can’t read{' '}
            {refusal.count === 1 ? 'isn’t' : 'aren’t'} valid, so this change can’t be saved until
            someone who can read {refusal.count === 1 ? 'it' : 'them'} fixes{' '}
            {refusal.count === 1 ? 'it' : 'them'}.
          </AlertDescription>
        </Alert>
      );
    case 'nothing':
      return note('The draft already holds this; the change does nothing.');
    case 'unclear':
      return note(`Coworker didn’t say which entry or what to change. ${ASK_AGAIN}`);
  }
}
