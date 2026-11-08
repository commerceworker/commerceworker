import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  ContentType,
  ContentTypeDraft,
  FieldDefinition,
} from '@commerceworker/sdk-management';
import { usageError } from './output.js';

/**
 * The content model as a file: `model export` writes one, `model apply` makes a space match it.
 * A model file is JSON (`{ "contentTypes": [...] }`, `{ "items": [...] }` or a bare array) or a
 * TypeScript module whose default export is the array, so it can live in a repository, be
 * reviewed in a pull request, and be applied to each environment in turn.
 */

export type Field = FieldDefinition;

/** The draft of each type: what `POST …/content-types` takes, without server bookkeeping. */
export function toDrafts(types: readonly ContentType[]): ContentTypeDraft[] {
  return types.map((type) => {
    const { apiId, name, displayField, fields, group, description, icon, layout } = type;
    const { agentInstructions } = type;
    return {
      apiId,
      name,
      displayField,
      fields,
      ...(group ? { group } : {}),
      ...(description ? { description } : {}),
      ...(icon ? { icon } : {}),
      ...(agentInstructions ? { agentInstructions } : {}),
      ...(layout ? { layout } : {}),
    };
  });
}

export function renderModel(drafts: readonly ContentTypeDraft[], format: 'json' | 'ts'): string {
  const json = JSON.stringify(drafts, null, 2);
  if (format === 'json') return `${JSON.stringify({ contentTypes: drafts }, null, 2)}\n`;
  return [
    '// The content model, exported by `commerceworker model export`.',
    '// Edit it, then `commerceworker model apply <this file> --dry-run` to see the change.',
    "import type { ContentTypeDraft } from '@commerceworker/sdk-management';",
    '',
    `export default ${json} satisfies ContentTypeDraft[];`,
    '',
  ].join('\n');
}

export const formatOf = (path: string): 'json' | 'ts' =>
  ['.ts', '.mts'].includes(extname(path)) ? 'ts' : 'json';

/** The mtime each module file was first imported at, by path. */
const imported = new Map<string, number>();

/**
 * A module is cached by URL, so a file edited since it was imported needs a new one: the same
 * path with its mtime as a query. The first import keeps the plain URL.
 */
async function moduleUrl(path: string): Promise<string> {
  const href = pathToFileURL(path).href;
  const mtime = (await stat(path)).mtimeMs;
  const first = imported.get(path);
  if (first === undefined) imported.set(path, mtime);
  return first === undefined || first === mtime ? href : `${href}?v=${mtime}`;
}

/** Reads a model file (JSON, or a TypeScript module Node can load by stripping its types). */
export async function loadModel(path: string, cwd: string): Promise<ContentTypeDraft[]> {
  const full = resolve(cwd, path);
  let raw: unknown;
  if (formatOf(full) === 'ts' || ['.js', '.mjs'].includes(extname(full))) {
    const mod = (await import(await moduleUrl(full))) as { default?: unknown };
    raw = mod.default;
  } else {
    raw = JSON.parse(await readFile(full, 'utf8'));
  }
  const list = Array.isArray(raw)
    ? raw
    : ((raw as { contentTypes?: unknown; items?: unknown } | undefined)?.contentTypes ??
      (raw as { items?: unknown } | undefined)?.items);
  if (!Array.isArray(list)) {
    throw usageError(`${path}: expected an array of content types, or { "contentTypes": [...] }`);
  }
  for (const [i, t] of list.entries()) {
    const ct = t as Partial<ContentTypeDraft>;
    if (typeof ct?.apiId !== 'string' || typeof ct.name !== 'string' || !Array.isArray(ct.fields)) {
      throw usageError(`${path}: content type ${i + 1} needs an apiId, a name and fields`);
    }
  }
  return (list as ContentTypeDraft[]).map(normalizeDraft);
}

/**
 * Fills what the server would: `localized` and `required` false, `position` the field's index,
 * `displayField` the first field. A file can then leave them out and still diff clean.
 */
export function normalizeDraft(draft: ContentTypeDraft): ContentTypeDraft {
  return {
    ...draft,
    displayField: draft.displayField ?? draft.fields[0]?.apiId ?? '',
    fields: normalizeFields(draft.fields),
  };
}

function normalizeFields(fields: readonly Field[]): Field[] {
  return fields.map((f, i) => {
    const items = f.items as { fields?: Field[]; variants?: { fields: Field[] }[] } | undefined;
    return {
      ...f,
      localized: f.localized ?? false,
      required: f.required ?? false,
      position: (f.position as number | undefined) ?? i,
      ...(Array.isArray(f.fields) ? { fields: normalizeFields(f.fields as Field[]) } : {}),
      ...(items
        ? {
            items: {
              ...items,
              ...(items.fields ? { fields: normalizeFields(items.fields) } : {}),
              ...(items.variants
                ? {
                    variants: items.variants.map((v) => ({
                      ...v,
                      fields: normalizeFields(v.fields),
                    })),
                  }
                : {}),
            },
          }
        : {}),
    };
  });
}

// --- the plan ----------------------------------------------------------------

/** One difference between the file and the space. */
export interface Change {
  /** Dotted path to what changes: `article`, `article.title`, `page.body[hero].heading`. */
  readonly path: string;
  readonly kind:
    | 'add-type'
    | 'change-type'
    | 'add-field'
    | 'remove-field'
    | 'change-field'
    | 'add-variant'
    | 'remove-variant';
  /** Loses or reshapes stored values: a removed field or block type, a changed type or localization. */
  readonly destructive: boolean;
  readonly detail: string;
}

export interface TypePlan {
  readonly apiId: string;
  readonly action: 'create' | 'update' | 'unchanged';
  readonly changes: readonly Change[];
  readonly draft: ContentTypeDraft;
}

export interface Plan {
  readonly types: readonly TypePlan[];
  /** Types in the space but not in the file. Left alone: the CLI never deletes a type. */
  readonly untouched: readonly string[];
  readonly destructive: number;
  readonly changes: number;
}

/** What `model apply` would change, type by type, field by field. */
export function planModel(
  desired: readonly ContentTypeDraft[],
  current: readonly ContentType[],
): Plan {
  const byId = new Map(current.map((t) => [t.apiId, t]));
  const wanted = new Set(desired.map((t) => t.apiId));
  const types: TypePlan[] = desired.map((draft) => {
    const live = byId.get(draft.apiId);
    if (!live) {
      return {
        apiId: draft.apiId,
        action: 'create',
        draft,
        changes: [
          {
            path: draft.apiId,
            kind: 'add-type',
            destructive: false,
            detail: `new content type with ${draft.fields.length} field(s)`,
          },
        ],
      };
    }
    const changes: Change[] = [];
    if (live.name !== draft.name) {
      changes.push(typeChange(draft.apiId, `name "${live.name}" → "${draft.name}"`));
    }
    if (live.displayField !== draft.displayField) {
      changes.push(
        typeChange(draft.apiId, `displayField ${live.displayField} → ${draft.displayField}`),
      );
    }
    // Left out of the file, these keep what the space has (as the API does), so only a value the
    // file states is compared.
    for (const key of ['group', 'description', 'icon', 'agentInstructions'] as const) {
      const wanted = draft[key];
      if (wanted !== undefined && (wanted ?? undefined) !== live[key]) {
        const show = (v: unknown) => JSON.stringify(v ?? null);
        changes.push(typeChange(draft.apiId, `${key} ${show(live[key])} → ${show(wanted)}`));
      }
    }
    if (
      draft.layout !== undefined &&
      JSON.stringify(draft.layout ?? null) !== JSON.stringify(live.layout ?? null)
    ) {
      changes.push(typeChange(draft.apiId, draft.layout ? 'layout changed' : 'layout removed'));
    }
    diffFields(draft.apiId, normalizeFields(live.fields), draft.fields, changes);
    return {
      apiId: draft.apiId,
      action: changes.length ? 'update' : 'unchanged',
      draft,
      changes,
    };
  });
  const all = types.flatMap((t) => t.changes);
  return {
    types,
    untouched: current.map((t) => t.apiId).filter((id) => !wanted.has(id)),
    destructive: all.filter((c) => c.destructive).length,
    changes: all.length,
  };
}

const typeChange = (path: string, detail: string): Change => ({
  path,
  kind: 'change-type',
  destructive: false,
  detail,
});

/** Attributes whose change reshapes stored values: the old values no longer fit. */
const RESHAPING = ['type', 'linkType', 'localized'] as const;

function diffFields(
  at: string,
  before: readonly Field[],
  after: readonly Field[],
  out: Change[],
): void {
  const old = new Map(before.map((f) => [f.apiId, f]));
  const next = new Map(after.map((f) => [f.apiId, f]));
  for (const f of before) {
    if (!next.has(f.apiId)) {
      out.push({
        path: `${at}.${f.apiId}`,
        kind: 'remove-field',
        destructive: true,
        detail: `remove ${f.type} field (its values are lost)`,
      });
    }
  }
  for (const f of after) {
    const path = `${at}.${f.apiId}`;
    const was = old.get(f.apiId);
    if (!was) {
      out.push({
        path,
        kind: 'add-field',
        destructive: false,
        detail: `add ${f.type} field${f.required ? ' (required: existing entries have no value)' : ''}`,
      });
      continue;
    }
    const reshaped = RESHAPING.filter((k) => !same(was[k], f[k])).map(
      (k) => `${k} ${String(was[k])} → ${String(f[k])}`,
    );
    const wasItems = was.items as { type?: string; linkType?: string } | undefined;
    const nowItems = f.items as { type?: string; linkType?: string } | undefined;
    if (describeItems(wasItems) !== describeItems(nowItems)) {
      reshaped.push(`items ${describeItems(wasItems)} → ${describeItems(nowItems)}`);
    }
    if (reshaped.length) {
      out.push({ path, kind: 'change-field', destructive: true, detail: reshaped.join(', ') });
    }
    const changed = Object.keys({ ...was, ...f }).filter(
      (k) =>
        !RESHAPING.includes(k as (typeof RESHAPING)[number]) &&
        k !== 'fields' &&
        k !== 'items' &&
        !same(was[k], f[k]),
    );
    if (changed.length) {
      out.push({
        path,
        kind: 'change-field',
        destructive: false,
        detail: `${changed.join(', ')} changed`,
      });
    }
    // Nested shapes: a component's fields, a repeater's fields, each block type's fields.
    if (Array.isArray(was.fields) || Array.isArray(f.fields)) {
      diffFields(path, (was.fields as Field[]) ?? [], (f.fields as Field[]) ?? [], out);
    }
    const wasNested = was.items as { fields?: Field[]; variants?: Variant[] } | undefined;
    const nowNested = f.items as { fields?: Field[]; variants?: Variant[] } | undefined;
    if (wasNested?.fields || nowNested?.fields) {
      diffFields(`${path}[]`, wasNested?.fields ?? [], nowNested?.fields ?? [], out);
    }
    if (wasNested?.variants || nowNested?.variants) {
      diffVariants(path, wasNested?.variants ?? [], nowNested?.variants ?? [], out);
    }
  }
}

interface Variant {
  readonly apiId: string;
  readonly name: string;
  readonly fields: readonly Field[];
}

function diffVariants(
  at: string,
  before: readonly Variant[],
  after: readonly Variant[],
  out: Change[],
): void {
  const next = new Map(after.map((v) => [v.apiId, v]));
  const old = new Map(before.map((v) => [v.apiId, v]));
  for (const v of before) {
    if (!next.has(v.apiId)) {
      out.push({
        path: `${at}[${v.apiId}]`,
        kind: 'remove-variant',
        destructive: true,
        detail: 'remove block type (blocks of it are lost)',
      });
    }
  }
  for (const v of after) {
    const was = old.get(v.apiId);
    if (!was) {
      out.push({
        path: `${at}[${v.apiId}]`,
        kind: 'add-variant',
        destructive: false,
        detail: `add block type with ${v.fields.length} field(s)`,
      });
      continue;
    }
    if (was.name !== v.name) {
      out.push({
        path: `${at}[${v.apiId}]`,
        kind: 'change-field',
        destructive: false,
        detail: `name "${was.name}" → "${v.name}"`,
      });
    }
    diffFields(`${at}[${v.apiId}]`, was.fields, v.fields, out);
  }
}

const describeItems = (items: { type?: string; linkType?: string } | undefined) =>
  items ? [items.type, items.linkType].filter(Boolean).join(':') : 'none';

/** Structural equality, independent of key order. */
function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  return (
    JSON.stringify(value, (_k, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)))
        : v,
    ) ?? 'undefined'
  );
}
