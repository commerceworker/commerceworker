/**
 * A readable diff between two versions of an entry: per field, per locale, what was added,
 * removed or changed, with detail shaped by the field's type. Text changes word by word; a link
 * or an asset by its target id; a list by element, matched by identity (a block's `_key`, a
 * link's target, a tag's text) or by content, with moves told apart from edits; rich text by
 * block, with a word diff inside each changed block. Every part is typed data, never markup.
 */

import type { ContentType } from '../content-type/content-type';
import {
  BLOCK_KEY,
  BLOCK_TYPE_KEY,
  type FieldDefinition,
  type FieldType,
  type LinkType,
  nestedFieldsFor,
} from '../content-type/field';
import { isRichTextDocument } from '../rich-text/rich-text';
import { diffRichText, type RichTextBlockDiff } from '../rich-text/rich-text-diff';
import type { EntryFields, LocalizedValue } from '../types';
import {
  type Aligned,
  alignByContent,
  alignByKey,
  type DiffKind,
  diffText,
  sameValue,
  type TextSegment,
} from './sequence-diff';

export type { DiffKind, TextSegment } from './sequence-diff';
export { diffText } from './sequence-diff';

/** What a `Link` field (or one element of an array of links) points at. */
export interface LinkRef {
  readonly id: string;
  readonly linkType: LinkType;
}

/** The type-aware detail of one changed value. */
export type ValueDiff =
  /** `Symbol`, `Slug` and `Text`: the text, word by word. */
  | { readonly type: 'text'; readonly segments: readonly TextSegment[] }
  /** Numbers, booleans, dates, locations and JSON: the values side by side. */
  | { readonly type: 'value'; readonly before: unknown; readonly after: unknown }
  /** A `Link`: the entry or asset it pointed at, and points at now. */
  | { readonly type: 'link'; readonly before: LinkRef | null; readonly after: LinkRef | null }
  /** A `Component`: its nested fields. */
  | { readonly type: 'component'; readonly fields: readonly NestedFieldDiff[] }
  /** An `Array`: its elements, in the newer version's reading order. */
  | { readonly type: 'list'; readonly items: readonly ListItemDiff[] }
  /** `RichText`: its blocks, in the newer version's reading order. */
  | { readonly type: 'richText'; readonly blocks: readonly RichTextBlockDiff[] };

/** One element of a list field. */
export interface ListItemDiff {
  readonly kind: DiffKind;
  /** The element is in both versions but sits elsewhere among its neighbours. */
  readonly moved?: true;
  /** Its position in the older version, or null when it was added. */
  readonly beforeIndex: number | null;
  /** Its position in the newer version, or null when it was removed. */
  readonly afterIndex: number | null;
  /** A block's `_key`, which identifies it across versions. */
  readonly key?: string;
  /** A block's variant (`_type`). */
  readonly variant?: string;
  /** What a link element points at. */
  readonly link?: LinkRef;
  readonly before?: unknown;
  readonly after?: unknown;
  /** How a changed element changed. */
  readonly detail?: ValueDiff;
}

/** One field of a component (no locales: a component's fields share its locale). */
export interface NestedFieldDiff {
  readonly field: string;
  /** The field's name in the content type; absent when the type no longer declares it. */
  readonly name?: string;
  readonly fieldType?: FieldType;
  readonly kind: DiffKind;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly detail?: ValueDiff;
}

/** One locale of a field. */
export interface LocaleDiff {
  readonly locale: string;
  readonly kind: DiffKind;
  readonly before?: unknown;
  readonly after?: unknown;
  /** How the value changed; absent when it did not. */
  readonly detail?: ValueDiff;
}

/** One field of the entry, across its locales. */
export interface FieldDiff {
  readonly field: string;
  /** The field's name in the content type; absent when the type no longer declares it. */
  readonly name?: string;
  readonly fieldType?: FieldType;
  /** `added`/`removed` when the whole field appeared or went; `changed` when any locale did. */
  readonly kind: DiffKind;
  /** The field's localized values in each version. */
  readonly before?: LocalizedValue;
  readonly after?: LocalizedValue;
  /** Each locale either version holds, in locale order. */
  readonly locales: readonly LocaleDiff[];
}

const absent = (v: unknown) => v === undefined || v === null;

function kindOf(before: unknown, after: unknown): DiffKind {
  if (absent(before) && absent(after)) return 'unchanged';
  if (absent(before)) return 'added';
  if (absent(after)) return 'removed';
  return sameValue(before, after) ? 'unchanged' : 'changed';
}

/**
 * Diffs two versions' fields. `before` is the baseline, so each `kind` reads as the change made
 * going from `before` to `after`. Fields follow the content type's order, then any field the type
 * no longer declares (diffed by the shape of its values) by name. Pass the content type as it is
 * now: its names label the result and its types pick the detail.
 *
 * `structureOnly` says what changed and where without working out how: text and rich text get no
 * word diff and a list with no identity no alignment, each a plain `value` detail. It costs a
 * comparison per value, so a save can afford it whatever a writer sends; the full diff can't be.
 */
export function diffEntryFields(
  before: EntryFields,
  after: EntryFields,
  contentType?: ContentType,
  { structureOnly = false }: { readonly structureOnly?: boolean } = {},
): FieldDiff[] {
  const declared = [...(contentType?.fields ?? [])].sort((x, y) => x.position - y.position);
  const known = new Set(declared.map((f) => f.apiId));
  const extra = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => !known.has(k))
    .sort();
  const out: FieldDiff[] = [];
  for (const def of declared) {
    if (before[def.apiId] === undefined && after[def.apiId] === undefined) continue;
    out.push(fieldDiff(def.apiId, before[def.apiId], after[def.apiId], def, structureOnly));
  }
  for (const apiId of extra) {
    out.push(fieldDiff(apiId, before[apiId], after[apiId], undefined, structureOnly));
  }
  return out;
}

function fieldDiff(
  field: string,
  before: LocalizedValue | undefined,
  after: LocalizedValue | undefined,
  def: FieldDefinition | undefined,
  structureOnly: boolean,
): FieldDiff {
  const locales = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  const perLocale = locales.map((locale): LocaleDiff => {
    const b = before?.[locale];
    const a = after?.[locale];
    const kind = kindOf(b, a);
    return {
      locale,
      kind,
      ...(b === undefined ? {} : { before: b }),
      ...(a === undefined ? {} : { after: a }),
      ...(kind === 'unchanged' ? {} : { detail: diffValue(b, a, def, structureOnly) }),
    };
  });
  const kind: DiffKind =
    before === undefined
      ? 'added'
      : after === undefined
        ? 'removed'
        : perLocale.every((l) => l.kind === 'unchanged')
          ? 'unchanged'
          : 'changed';
  return {
    field,
    ...(def ? { name: def.name, fieldType: def.type } : {}),
    kind,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    locales: perLocale,
  };
}

/**
 * The detail of one value's change, picked by its field definition, or by the shape of the values
 * when there is none (a field the content type no longer declares). Either side may be absent.
 */
export function diffValue(
  before: unknown,
  after: unknown,
  def?: FieldDefinition,
  structureOnly = false,
): ValueDiff {
  switch (def?.type ?? inferType(before ?? after)) {
    case 'Symbol':
    case 'Slug':
    case 'Text':
      if (!structureOnly && isText(before) && isText(after)) {
        return { type: 'text', segments: diffText(before ?? '', after ?? '') };
      }
      break;
    case 'RichText':
      if (!structureOnly && isDocOrNothing(before) && isDocOrNothing(after)) {
        return { type: 'richText', blocks: diffRichText(before, after) };
      }
      break;
    case 'Link':
      return { type: 'link', before: asLink(before), after: asLink(after) };
    case 'Component':
      if (isRecordOrNothing(before) && isRecordOrNothing(after)) {
        const fields = diffComponent(before, after, def?.fields, structureOnly);
        return { type: 'component', fields };
      }
      break;
    case 'Array':
      if (isListOrNothing(before) && isListOrNothing(after)) {
        const b = before ?? [];
        const a = after ?? [];
        if (!structureOnly || identityOf(def, b, a).by === 'key') {
          return { type: 'list', items: diffList(b, a, def, structureOnly) };
        }
      }
      break;
  }
  return { type: 'value', before: before ?? null, after: after ?? null };
}

function inferType(value: unknown): FieldType | undefined {
  if (typeof value === 'string') return 'Text';
  if (Array.isArray(value)) return 'Array';
  if (isRichTextDocument(value)) return 'RichText';
  if (asLink(value)) return 'Link';
  return undefined;
}

const isText = (v: unknown): v is string | null | undefined => absent(v) || typeof v === 'string';
const isDocOrNothing = (v: unknown) => absent(v) || isRichTextDocument(v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isRecordOrNothing = (v: unknown): v is Record<string, unknown> | null | undefined =>
  absent(v) || isRecord(v);
const isListOrNothing = (v: unknown): v is unknown[] | null | undefined =>
  absent(v) || Array.isArray(v);

function asLink(value: unknown): LinkRef | null {
  if (!isRecord(value)) return null;
  const { id, linkType } = value;
  return typeof id === 'string' && (linkType === 'Entry' || linkType === 'Asset')
    ? { id, linkType }
    : null;
}

/** A component's own fields; `_type` and `_key` describe the element and are not compared here. */
function diffComponent(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  defs: readonly FieldDefinition[] = [],
  structureOnly = false,
): NestedFieldDiff[] {
  const b = before ?? {};
  const a = after ?? {};
  const known = new Set(defs.map((d) => d.apiId));
  const extra = [...new Set([...Object.keys(b), ...Object.keys(a)])]
    .filter((k) => !known.has(k) && k !== BLOCK_KEY && k !== BLOCK_TYPE_KEY)
    .sort();
  const fields: { apiId: string; def?: FieldDefinition }[] = [
    ...[...defs].sort((x, y) => x.position - y.position).map((def) => ({ apiId: def.apiId, def })),
    ...extra.map((apiId) => ({ apiId })),
  ];
  const out: NestedFieldDiff[] = [];
  for (const { apiId, def } of fields) {
    const was = b[apiId];
    const now = a[apiId];
    if (was === undefined && now === undefined) continue;
    const kind = kindOf(was, now);
    out.push({
      field: apiId,
      ...(def ? { name: def.name, fieldType: def.type } : {}),
      kind,
      ...(was === undefined ? {} : { before: was }),
      ...(now === undefined ? {} : { after: now }),
      ...(kind === 'unchanged' ? {} : { detail: diffValue(was, now, def, structureOnly) }),
    });
  }
  return out;
}

/** How a list's elements are told apart, by what the field holds. */
type Identity =
  | { readonly by: 'key'; readonly keyOf: (item: unknown, index: number) => string }
  | { readonly by: 'content' };

function identityOf(
  def: FieldDefinition | undefined,
  before: unknown[],
  after: unknown[],
): Identity {
  const items = def?.items;
  const all = [...before, ...after];
  if (items?.type === 'Symbol' || (!items && all.every((v) => typeof v === 'string'))) {
    return { by: 'key', keyOf: (v) => String(v) };
  }
  if (items?.type === 'Link' || (!items && all.length > 0 && all.every((v) => asLink(v)))) {
    return { by: 'key', keyOf: (v, i) => linkKey(asLink(v)) ?? `#${i}` };
  }
  // Blocks carry a `_key`; one that changes variant under the same key is a different block.
  if (all.length > 0 && all.every((v) => isRecord(v) && typeof v[BLOCK_KEY] === 'string')) {
    return {
      by: 'key',
      keyOf: (v) => {
        const r = v as Record<string, unknown>;
        return `${String(r[BLOCK_TYPE_KEY] ?? '')}\u0000${String(r[BLOCK_KEY])}`;
      },
    };
  }
  return { by: 'content' };
}

const linkKey = (l: LinkRef | null) => (l ? `${l.linkType}:${l.id}` : undefined);

function diffList(
  before: unknown[],
  after: unknown[],
  def: FieldDefinition | undefined,
  structureOnly: boolean,
): ListItemDiff[] {
  const identity = identityOf(def, before, after);
  const aligned: Aligned[] =
    identity.by === 'key'
      ? alignByKey(before, after, identity.keyOf)
      : alignByContent(before, after, sameValue, (x, y) => isRecord(x) && isRecord(y));
  // An element of an Array-of-Component is described by the same definitions as a Component.
  const elementDef = (item: unknown): FieldDefinition | undefined => {
    if (!def) return undefined;
    if (def.items?.type === 'Component') {
      return { ...def, type: 'Component', fields: nestedFieldsFor(def, item) ?? [] };
    }
    return def.items
      ? { ...def, type: def.items.type, linkType: def.items.linkType, items: undefined }
      : undefined;
  };
  return aligned.map(({ beforeIndex, afterIndex, moved }): ListItemDiff => {
    const was = beforeIndex === null ? undefined : before[beforeIndex];
    const now = afterIndex === null ? undefined : after[afterIndex];
    const item = now ?? was;
    const kind =
      beforeIndex === null ? 'added' : afterIndex === null ? 'removed' : kindOf(was, now);
    const record = isRecord(item) ? item : undefined;
    const link = asLink(item);
    return {
      kind,
      ...(moved ? { moved: true } : {}),
      beforeIndex,
      afterIndex,
      ...(typeof record?.[BLOCK_KEY] === 'string' ? { key: record[BLOCK_KEY] } : {}),
      ...(typeof record?.[BLOCK_TYPE_KEY] === 'string' ? { variant: record[BLOCK_TYPE_KEY] } : {}),
      ...(link ? { link } : {}),
      ...(was === undefined ? {} : { before: was }),
      ...(now === undefined ? {} : { after: now }),
      ...(kind === 'changed'
        ? { detail: diffValue(was, now, elementDef(item), structureOnly) }
        : {}),
    };
  });
}
