import type { ContentType } from '@commerceworker/domain';
import type { ManagementClient, PreviewEntry } from '../../lib/management';

/** An entry with no title yet; its content type names it beside this. */
export const UNTITLED = 'Untitled entry';

/** What a dashboard row needs to name and link an entry. */
export interface EntryRef {
  readonly id: string;
  readonly contentType: string;
  readonly typeName: string;
  readonly title: string;
  readonly status: string;
}

/**
 * Resolves an entry to the title an editor recognises: its display field in
 * `locale`, else any locale's value, else "Untitled entry" (the type name rides beside it). Never
 * an id prefix: UUIDv7 ids share their leading digits, so every prefix reads the same. Preview
 * list fields keep the localized `{ field: { locale: value } }` shape.
 */
export function entryRef(
  entry: PreviewEntry,
  types: readonly ContentType[],
  locale: string,
): EntryRef {
  const type = types.find((t) => t.apiId === entry.contentType);
  const raw = type?.displayField ? entry.fields[type.displayField] : undefined;
  let title: unknown = raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const byLocale = raw as Record<string, unknown>;
    title = byLocale[locale] ?? Object.values(byLocale).find((v) => typeof v === 'string' && v);
  }
  return {
    id: entry.id,
    contentType: entry.contentType,
    typeName: type?.name ?? entry.contentType,
    title: typeof title === 'string' && title.trim() ? title : UNTITLED,
    status: entry.status,
  };
}

export const entryPath = (e: { contentType: string; id: string }) =>
  `/content/${e.contentType}/${e.id}`;

/** "Nov 2, 14:00" — short, local, no seconds. */
export function shortDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The preview list's largest page, and so the most ids one `sys.id[in]` request can resolve. */
const BY_ID_PAGE = 100;

/**
 * The current (draft) versions of the given entries, in as few requests as the page cap allows:
 * the preview list filtered by `sys.id[in]`, which the store resolves with one JSON parameter.
 * An id that isn't returned was deleted or isn't visible to this principal.
 */
export async function fetchEntriesById(
  client: Pick<ManagementClient, 'listEntries'>,
  ids: readonly string[],
): Promise<PreviewEntry[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  const pages: string[][] = [];
  for (let i = 0; i < unique.length; i += BY_ID_PAGE) pages.push(unique.slice(i, i + BY_ID_PAGE));
  const results = await Promise.all(
    pages.map((page) =>
      client.listEntries(undefined, {
        filters: [{ field: 'sys.id', op: 'in', value: page }],
        limit: BY_ID_PAGE,
      }),
    ),
  );
  return results.flat();
}
