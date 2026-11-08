/**
 * What a write changed in an entry, as an audit row keeps it: where, never what. It is read off the
 * deterministic diff (`diffEntryFields`, structure only: this runs on every save) by walking the
 * content model, so a path can only ever be
 * made of model api ids. Nothing a writer typed reaches it: a JSON field, a `Seo` value and rich
 * text stop at the field, a block's `_key` is left out (a save keeps the key it was sent), a nested
 * key the model doesn't declare reports its parent, and a locale key counts only if the space has
 * that locale (a localized field stores whatever keys it is sent).
 */

import type { ContentType } from '../content-type/content-type';
import type { EntryFields } from '../types';
import { diffEntryFields, type NestedFieldDiff, type ValueDiff } from './entry-diff';

/** Largest `detail` a row keeps, in characters of its JSON. Past it, `truncated` says so. */
export const MAX_AUDIT_DETAIL_SIZE = 4096;

/** Most entries one row describes: an import of thousands is one row, not thousands of diffs. */
export const MAX_AUDIT_DETAIL_ENTRIES = 20;

/** Where a write changed one entry. */
export interface EntryChange {
  readonly entryId: string;
  /** The type's api id, so a reader can name the paths from the model as it stands. */
  readonly contentType: string;
  readonly kind: 'created' | 'updated';
  /** The version the write made; with the one before it, what a version diff compares. */
  readonly version: number;
  /**
   * The model's paths that changed: `fields.title`, `fields.hero.alt`, and `[]` for an element of
   * a list (`fields.sections[].heading`). Which element is left out: elements have no name in the
   * model. A created entry lists each field it was given, a whole component or list as one path.
   */
  readonly paths: readonly string[];
  /** The space's locales the change touched, among localized fields; sorted. */
  readonly locales: readonly string[];
  /** Fields the type no longer declares that changed: counted, as their keys aren't the model's. */
  readonly undeclaredFields?: number;
}

/** A row's structured `detail`: paths and small structural facts, never a value. */
export interface AuditDetail {
  readonly entries: readonly EntryChange[];
  /** Some of what changed isn't listed: the row hit a cap, or a change could not be read. */
  readonly truncated?: true;
}

/** The paths under a component, or null when part of the change has no name in the model. */
function componentPaths(path: string, fields: readonly NestedFieldDiff[]): string[] | null {
  const out: string[] = [];
  for (const field of fields) {
    if (field.kind === 'unchanged') continue;
    if (!field.fieldType) return null;
    const nested = `${path}.${field.field}`;
    out.push(...(field.kind === 'changed' ? valuePaths(nested, field.detail) : [nested]));
  }
  return out.length > 0 ? out : null;
}

/** The paths one changed value reports. Only components and lists of them go any deeper. */
function valuePaths(path: string, detail: ValueDiff | undefined): string[] {
  if (detail?.type === 'component') return componentPaths(path, detail.fields) ?? [path];
  if (detail?.type !== 'list') return [path];
  const out: string[] = [];
  for (const item of detail.items) {
    if (item.kind === 'unchanged' && !item.moved) continue;
    const inner =
      item.kind === 'changed' && !item.moved && item.detail?.type === 'component'
        ? componentPaths(`${path}[]`, item.detail.fields)
        : null;
    // An element added, removed or moved changes the list itself.
    out.push(...(inner ?? [path]));
  }
  return out;
}

/**
 * The paths and locales between two versions' fields. Pass the content type as the write saw it,
 * and the space's locales: anything either doesn't name is user data and stays out.
 */
export function changedPaths(
  before: EntryFields,
  after: EntryFields,
  contentType: ContentType,
  spaceLocales: readonly string[],
): Pick<EntryChange, 'paths' | 'locales' | 'undeclaredFields'> {
  const paths = new Set<string>();
  const locales = new Set<string>();
  let undeclaredFields = 0;
  const localized = new Set(contentType.fields.filter((f) => f.localized).map((f) => f.apiId));
  for (const diff of diffEntryFields(before, after, contentType, { structureOnly: true })) {
    const changed = diff.locales.filter((l) => l.kind !== 'unchanged');
    if (changed.length === 0) continue;
    if (!diff.fieldType) {
      undeclaredFields++;
      continue;
    }
    const path = `fields.${diff.field}`;
    for (const locale of changed) {
      const reported = locale.kind === 'changed' ? valuePaths(path, locale.detail) : [path];
      for (const p of reported) paths.add(p);
      if (localized.has(diff.field) && spaceLocales.includes(locale.locale)) {
        locales.add(locale.locale);
      }
    }
  }
  return {
    paths: [...paths],
    locales: [...locales].sort(),
    ...(undeclaredFields > 0 ? { undeclaredFields } : {}),
  };
}

const sizeOf = (value: unknown): number => JSON.stringify(value).length;

/** `detail` within {@link MAX_AUDIT_DETAIL_SIZE}: as much of it as fits, marked `truncated`. */
export function capAuditDetail(detail: AuditDetail): AuditDetail {
  if (sizeOf(detail) <= MAX_AUDIT_DETAIL_SIZE) return detail;
  let room = MAX_AUDIT_DETAIL_SIZE - sizeOf({ entries: [], truncated: true });
  const fit = (items: readonly string[]): string[] => {
    const kept: string[] = [];
    for (const item of items) {
      const cost = sizeOf(item) + 1;
      if (cost > room) break;
      room -= cost;
      kept.push(item);
    }
    return kept;
  };
  const entries: EntryChange[] = [];
  for (const entry of detail.entries) {
    const bare = { ...entry, paths: [], locales: [] };
    const cost = sizeOf(bare) + 1;
    if (cost > room) break;
    room -= cost;
    // Locales first: they are few, and say something about every path.
    const locales = fit(entry.locales);
    entries.push({ ...bare, locales, paths: fit(entry.paths) });
  }
  return { entries, truncated: true };
}
