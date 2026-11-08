import type { EntryFields } from '../types';
import { BLOCK_TYPE_KEY, blockVariants, type FieldDefinition, variantOf } from './field';

/**
 * Schema evolution for blocks fields.
 *
 * Adding a variant, or an optional field to one, never strands content. Removing
 * a variant does when an entry still holds a block of it: the block's `_type`
 * would name nothing, so the entry could no longer be saved, delivery's GraphQL
 * union could not type it, and generated client types would not describe it.
 * These two functions let the content-type update refuse that change, naming
 * the entries, instead of discovering it later on someone else's save.
 *
 * Removing a field, at any depth, strands content the same way: an entry that
 * still holds a value for it fails its next save ("Unknown field"), and the
 * value would be silently dropped from delivery. `removedFields` and
 * `removedFieldUses` are the same pair for that change.
 *
 * A blocks field is located by its path of apiIds, with the variant a nested
 * field sits in shown in brackets: `body`, `body[hero].ctas`, `meta.blocks`.
 */

/** Variant apiIds that `after` drops from blocks fields `before` declared, by location. */
export function removedVariants(
  before: readonly FieldDefinition[],
  after: readonly FieldDefinition[],
): Map<string, Set<string>> {
  const removed = new Map<string, Set<string>>();
  const walk = (
    prev: readonly FieldDefinition[] | undefined,
    next: readonly FieldDefinition[] | undefined,
    prefix: string,
  ): void => {
    for (const f of prev ?? []) {
      const g = next?.find((n) => n.apiId === f.apiId);
      // A field that is removed outright is a different change, with its own
      // rules; only a field that survives can lose a variant.
      if (!g) continue;
      const at = prefix ? `${prefix}.${f.apiId}` : f.apiId;
      const variants = blockVariants(f);
      if (variants) {
        const kept = blockVariants(g) ?? [];
        for (const v of variants) {
          const survivor = kept.find((k) => k.apiId === v.apiId);
          if (!survivor) {
            const set = removed.get(at) ?? new Set<string>();
            set.add(v.apiId);
            removed.set(at, set);
          } else {
            walk(v.fields, survivor.fields, `${at}[${v.apiId}]`);
          }
        }
      } else if (f.type === 'Component') {
        walk(f.fields, g.fields, at);
      } else if (f.type === 'Array' && f.items?.type === 'Component') {
        walk(f.items.fields, g.items?.fields, at);
      }
    }
  };
  walk(before, after, '');
  return removed;
}

/**
 * The removed variants an entry's values still use, as `location: variant`
 * strings (empty when none). `fields` are the definitions the values were
 * written against, i.e. the content type before the change.
 */
export function removedVariantUses(
  fields: readonly FieldDefinition[],
  values: EntryFields,
  removed: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  if (removed.size === 0) return [];
  const uses = new Set<string>();
  const visit = (f: FieldDefinition, value: unknown, at: string): void => {
    if (value === undefined || value === null) return;
    const variants = blockVariants(f);
    if (variants) {
      if (!Array.isArray(value)) return;
      for (const item of value) {
        const type = (item as Record<string, unknown> | null)?.[BLOCK_TYPE_KEY];
        if (typeof type === 'string' && removed.get(at)?.has(type)) uses.add(`${at}: ${type}`);
        const variant = variantOf(variants, item);
        if (variant) visitObject(variant.fields, item, `${at}[${variant.apiId}]`);
      }
    } else if (f.type === 'Component') {
      visitObject(f.fields ?? [], value, at);
    } else if (f.type === 'Array' && f.items?.type === 'Component' && Array.isArray(value)) {
      for (const item of value) visitObject(f.items.fields ?? [], item, at);
    }
  };
  const visitObject = (nested: readonly FieldDefinition[], value: unknown, at: string): void => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    const obj = value as Record<string, unknown>;
    for (const f of nested) visit(f, obj[f.apiId], `${at}.${f.apiId}`);
  };
  for (const f of fields) {
    for (const value of Object.values(values[f.apiId] ?? {})) visit(f, value, f.apiId);
  }
  return [...uses];
}

/**
 * Fields `after` drops that `before` declared, at any depth, by location. A
 * field inside a removed field or a removed variant is not listed again: the
 * outer removal covers it (and `removedVariants` reports the variant).
 */
export function removedFields(
  before: readonly FieldDefinition[],
  after: readonly FieldDefinition[],
): Set<string> {
  const removed = new Set<string>();
  const walk = (
    prev: readonly FieldDefinition[] | undefined,
    next: readonly FieldDefinition[] | undefined,
    prefix: string,
  ): void => {
    for (const f of prev ?? []) {
      const at = prefix ? `${prefix}.${f.apiId}` : f.apiId;
      const g = next?.find((n) => n.apiId === f.apiId);
      if (!g) {
        removed.add(at);
        continue;
      }
      const variants = blockVariants(f);
      if (variants) {
        const kept = blockVariants(g) ?? [];
        for (const v of variants) {
          const survivor = kept.find((k) => k.apiId === v.apiId);
          if (survivor) walk(v.fields, survivor.fields, `${at}[${v.apiId}]`);
        }
      } else if (f.type === 'Component') {
        walk(f.fields, g.fields, at);
      } else if (f.type === 'Array' && f.items?.type === 'Component') {
        walk(f.items.fields, g.items?.fields, at);
      }
    }
  };
  walk(before, after, '');
  return removed;
}

/**
 * The removed fields an entry's values still hold a value for (anything but
 * absent or null), by location; empty when none. `fields` are the definitions
 * the values were written against, i.e. the content type before the change.
 */
export function removedFieldUses(
  fields: readonly FieldDefinition[],
  values: EntryFields,
  removed: ReadonlySet<string>,
): string[] {
  if (removed.size === 0) return [];
  const uses = new Set<string>();
  const visit = (f: FieldDefinition, value: unknown, at: string): void => {
    if (value === undefined || value === null) return;
    if (removed.has(at)) {
      uses.add(at);
      return;
    }
    const variants = blockVariants(f);
    if (variants) {
      if (!Array.isArray(value)) return;
      for (const item of value) {
        const variant = variantOf(variants, item);
        if (variant) visitObject(variant.fields, item, `${at}[${variant.apiId}]`);
      }
    } else if (f.type === 'Component') {
      visitObject(f.fields ?? [], value, at);
    } else if (f.type === 'Array' && f.items?.type === 'Component' && Array.isArray(value)) {
      for (const item of value) visitObject(f.items.fields ?? [], item, at);
    }
  };
  const visitObject = (nested: readonly FieldDefinition[], value: unknown, at: string): void => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    const obj = value as Record<string, unknown>;
    for (const f of nested) visit(f, obj[f.apiId], `${at}.${f.apiId}`);
  };
  for (const f of fields) {
    for (const value of Object.values(values[f.apiId] ?? {})) visit(f, value, f.apiId);
  }
  return [...uses];
}
