import { type FieldType, type Scope, ValidationError } from '@commerceworker/domain';
import type { FieldValueCount } from '@commerceworker/ports';
import { getContentType } from './content-types';
import type { AppContext } from './context';

/**
 * The field types whose values are listed: short scalars a filter compares, and lists of Symbols.
 * Long text is left out: its values are prose, not choices, and each would be grouped whole.
 */
const VALUE_FIELD_TYPES: readonly FieldType[] = [
  'Symbol',
  'Slug',
  'Integer',
  'Number',
  'Boolean',
  'Date',
];

/** The most values one page returns, and the page size when none is asked for. */
export const MAX_FIELD_VALUES_PAGE = 100;

/** One page of a field's distinct values ({@link listFieldValues}). */
export interface FieldValuesPage {
  readonly items: readonly FieldValueCount[];
  /** Pass back as `cursor` for the next page; absent on the last one. */
  readonly nextCursor?: string;
}

const encodeCursor = (value: string | number | boolean): string =>
  btoa(encodeURIComponent(JSON.stringify([value])))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

function decodeCursor(cursor: string): string | number | boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))));
  } catch {
    // Falls through to the refusal.
  }
  const v = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  throw new ValidationError([
    { field: 'cursor', message: 'cursor is not one this list of values returned' },
  ]);
}

/**
 * The distinct values a content type's field holds across its entries (current versions, the
 * trash left out), each with how many entries hold it: what a filter's value picker or a facet
 * offers. Booleans first, then numbers, then strings, each ascending; one page of at most
 * {@link MAX_FIELD_VALUES_PAGE}, walked with the returned cursor. A list of Symbols contributes
 * each element; `locale` narrows to that locale's values.
 *
 * Only short scalar fields (and lists of Symbols) have values to list: a long-text, rich-text,
 * JSON, link or component field is refused, since its values are prose or structures, not
 * something to pick from. A type with more entries than the store's scan cap is refused too
 * (`QueryTooBroadError`): each page groups the whole type.
 */
export async function listFieldValues(
  ctx: AppContext,
  scope: Scope,
  contentTypeApiId: string,
  field: string,
  opts: { readonly locale?: string; readonly limit?: number; readonly cursor?: string } = {},
): Promise<FieldValuesPage> {
  const type = await getContentType(ctx, scope, contentTypeApiId);
  const def = type.fields.find((f) => f.apiId === field);
  if (!def) {
    throw new ValidationError([
      { field: 'field', message: `${contentTypeApiId} has no field "${field}"` },
    ]);
  }
  const listable =
    VALUE_FIELD_TYPES.includes(def.type) || (def.type === 'Array' && def.items?.type === 'Symbol');
  if (!listable) {
    throw new ValidationError([
      {
        field: 'field',
        message: `${field} is a ${def.type} field; only short scalar fields and lists of Symbols have values to list`,
      },
    ]);
  }
  const limit = Math.min(Math.max(1, opts.limit ?? MAX_FIELD_VALUES_PAGE), MAX_FIELD_VALUES_PAGE);
  const after = opts.cursor === undefined ? undefined : { value: decodeCursor(opts.cursor) };
  const rows = await ctx.store.entries.distinctFieldValues(scope, {
    contentTypeApiId,
    field,
    ...(opts.locale ? { locale: opts.locale } : {}),
    limit: limit + 1,
    ...(after ? { after } : {}),
  });
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    ...(rows.length > limit && last ? { nextCursor: encodeCursor(last.value) } : {}),
  };
}
