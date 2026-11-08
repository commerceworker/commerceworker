import {
  createEntry,
  listConcepts,
  listPreviewEntries,
  listSchemes,
  listTags,
  publishEntry,
  setEntryMetadata,
  trashEntry,
  updateEntry,
} from '@commerceworker/application';
import type { EntryFields } from '@commerceworker/domain';
import { logger } from '@commerceworker/telemetry';
import type { EnterpriseRun } from './run';

/** One entry the brand needs: its key (a unique field's value), fields and lifecycle. */
export interface Spec {
  readonly key: string;
  readonly fields: EntryFields;
  /**
   * draft: never published. published. changed: published, then edited (the diff and "changed"
   * badge have something to show). trashed: published, then trashed (the trash has something).
   */
  readonly status?: 'draft' | 'published' | 'changed' | 'trashed';
  /** Tag names and concept slugs (`Scheme/slug`), resolved to ids by the writer. */
  readonly tags?: readonly string[];
  readonly concepts?: readonly string[];
  /** For `changed`: fields saved as a new draft after the publish. */
  readonly patch?: EntryFields;
}

/** Entry ids of one content type by the value of their key field, in the default locale. */
export async function keysOf(
  run: EnterpriseRun,
  contentTypeApiId: string,
  keyField = 'slug',
): Promise<Map<string, string>> {
  const rows = await listPreviewEntries(run.ctx, run.scope, {
    contentTypeApiId,
    locale: run.locale,
    limit: 1000,
  });
  const out = new Map<string, string>();
  for (const r of rows) {
    const v = (r.fields[keyField] as Record<string, unknown> | undefined)?.[run.locale];
    if (typeof v === 'string') out.set(v, r.id);
  }
  return out;
}

/** `keysOf`, failing loudly on a key an earlier phase should have made. */
export function need(map: Map<string, string>, key: string, what: string): string {
  const id = map.get(key);
  if (!id)
    throw new Error(`enterprise starter: missing ${what} "${key}" (an earlier phase failed?)`);
  return id;
}

/** Tag ids by name and concept ids by `Scheme/slug`, loaded once per phase. */
export interface Terms {
  readonly tags: Map<string, string>;
  readonly concepts: Map<string, string>;
}

export async function loadTerms(run: EnterpriseRun): Promise<Terms> {
  const tags = new Map((await listTags(run.ctx, run.scope)).map((t) => [t.name, t.id]));
  const concepts = new Map<string, string>();
  for (const scheme of await listSchemes(run.ctx, run.scope)) {
    for (const c of await listConcepts(run.ctx, run.scope, scheme.id)) {
      concepts.set(`${scheme.name}/${c.slug}`, c.id);
    }
  }
  return { tags, concepts };
}

/**
 * Creates every spec whose key isn't there yet (one list query finds the existing ones), each
 * through the ordinary use-cases: create, metadata, publish, and the after-publish edit or trash.
 * Returns ids by key for every spec, existing or new, so callers can link to them.
 */
export async function ensureEntries(
  run: EnterpriseRun,
  contentTypeApiId: string,
  specs: readonly Spec[],
  terms: Terms,
  keyField = 'slug',
): Promise<Map<string, string>> {
  const { ctx, scope } = run;
  const ids = await keysOf(run, contentTypeApiId, keyField);
  let created = 0;
  for (const spec of specs) {
    if (ids.has(spec.key)) continue;
    const view = await createEntry(ctx, scope, { contentTypeApiId, fields: spec.fields });
    const id = view.entry.id;
    const tags = (spec.tags ?? []).map((n) => terms.tags.get(n)).filter((x): x is string => !!x);
    const concepts = (spec.concepts ?? [])
      .map((n) => terms.concepts.get(n))
      .filter((x): x is string => !!x);
    if (tags.length || concepts.length) {
      await setEntryMetadata(ctx, scope, id, { tags, concepts });
    }
    const status = spec.status ?? 'published';
    if (status !== 'draft') {
      await publishEntry(ctx, scope, id);
      if (status === 'changed' && spec.patch) {
        await updateEntry(ctx, scope, id, { ...spec.fields, ...spec.patch });
      }
      if (status === 'trashed') await trashEntry(ctx, scope, id);
    }
    ids.set(spec.key, id);
    created++;
  }
  if (created) logger.info({ contentTypeApiId, created }, 'starter: enterprise entries');
  return ids;
}

/** Deterministic pick by index: the starter never uses randomness, so every install matches. */
export const pickOf = <T>(arr: readonly T[], n: number): T => arr[n % arr.length] as T;

/** ISO date `days` from the clock (negative: past), at a fixed hour UTC. */
export function dayOffset(now: Date, days: number, hour = 9, minute = 0): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

/** `dayOffset` as a calendar date (YYYY-MM-DD), for `date`-format fields. */
export const dayOnly = (now: Date, days: number) => dayOffset(now, days).slice(0, 10);

export const entry = (id: string) => ({ id, linkType: 'Entry' as const });
export const asset = (id: string) => ({ id, linkType: 'Asset' as const });
