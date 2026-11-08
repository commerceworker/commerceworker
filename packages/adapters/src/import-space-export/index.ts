import {
  applyDefaults,
  type ContentType,
  type EntryFields,
  FIELD_GUIDANCE_LIMITS,
  type FieldDefinition,
  type LinkType,
  type LocalizedValue,
  type Tag,
  validateEntryFields,
} from '@commerceworker/domain';
import type {
  ConvertedAsset,
  ConvertedEntry,
  ConvertedLocale,
  ConvertedSpace,
  MissingLinkTarget,
  SpaceExportReader,
  SpaceExportReadOptions,
} from '@commerceworker/ports';
import { MAX_PAYLOAD_BYTES } from '../import-structured/shared';
import {
  isObject,
  type Json,
  type MappedContentType,
  type ModelFindings,
  mapContentTypes,
  str,
  sysId,
} from './model';
import { convertRichText } from './rich-text';

/**
 * Reads the widely used JSON space export: one document holding a space's `contentTypes`,
 * `entries`, `assets`, `locales`, `tags` and `editorInterfaces`, whose rich text is a typed node
 * tree (`nodeType`, `content`, `data`, `marks`) with embedded entries and assets named by
 * `data.target.sys`.
 *
 * Everything is mapped here, in one pass over the whole file, because the parts only mean
 * something together: an entry's links name entries further down the file (or each other, in a
 * cycle), so every entry and asset gets its new id before any value is converted, and a link
 * whose target is not coming along is dropped and reported rather than left dangling.
 *
 * Entries are validated against the mapped model the way they will be written, and one that would
 * fail is left out and named, together with the links to it. That can make another entry invalid
 * (a required link now empty), so it repeats until nothing changes.
 */
export function createSpaceExportReader(): SpaceExportReader {
  return {
    id: 'space-export',
    name: 'Space export (JSON)',
    async read(payload, options) {
      if (payload.length > MAX_PAYLOAD_BYTES) {
        throw new Error(`Payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch (err) {
        throw new Error(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!isObject(parsed) || !Array.isArray(parsed.contentTypes)) {
        throw new Error('Not a space export: expected an object with a contentTypes array');
      }
      return convertSpace(parsed, options);
    },
  };
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function convertSpace(doc: Json, options: SpaceExportReadOptions): ConvertedSpace {
  const findings: ModelFindings = { unmappedFields: [], unmappedValidations: [], warnings: [] };
  const locales = readLocales(list(doc.locales), findings.warnings);
  const defaultLocale = locales.find((l) => l.default)?.code;
  if (!defaultLocale) throw new Error('The export declares no default locale');
  const exportLocales = new Set(locales.map((l) => l.code));

  const types = mapContentTypes(list(doc.contentTypes), findings);
  importHelpTexts(list(doc.editorInterfaces), types, findings.warnings);
  for (const key of ['webhooks', 'roles']) {
    const n = list(doc[key]).length;
    if (n > 0) findings.warnings.push(`${n} ${key} in the export are not imported`);
  }

  const tags: Tag[] = list(doc.tags).flatMap((t) => {
    const id = sysId(t);
    const name = isObject(t) ? str(t.name) : undefined;
    // No slug: the snapshot import makes one from the name (as for a term older code wrote).
    return id && name ? [{ id, name, slug: '', description: null, labels: {} }] : [];
  });
  const tagIds = new Set(tags.map((t) => t.id));

  // Every id first, so a link to anything later in the file resolves.
  const rawEntries = list(doc.entries).filter(isObject);
  const rawAssets = list(doc.assets).filter(isObject);
  const entryIds = new Map<string, string>();
  for (const e of rawEntries) {
    const id = sysId(e);
    if (id && !entryIds.has(id)) entryIds.set(id, options.newId());
  }

  const assets = rawAssets.flatMap((a) => {
    const asset = convertAsset(a, defaultLocale, exportLocales, options, findings.warnings);
    return asset ? [asset] : [];
  });
  const assetIds = new Map(assets.map((a) => [a.sourceId, a.id]));

  const vctx = {
    defaultLocale,
    locales: [...new Set([...options.locales, ...exportLocales])],
  };

  // Which entries survive validation, to a fixed point (see above).
  const candidates = new Map<string, Json>();
  let skippedEntries = 0;
  for (const e of rawEntries) {
    const id = sysId(e);
    const typeId = isObject(e.sys) ? sysId(e.sys.contentType) : undefined;
    if (!id || !typeId || !types.has(typeId) || candidates.has(id)) {
      skippedEntries += 1;
      continue;
    }
    candidates.set(id, e);
  }
  if (skippedEntries > 0) {
    findings.warnings.push(
      `${skippedEntries} entr(y/ies) have no id, a repeated id, or a content type not in the export, and were skipped`,
    );
  }

  const invalid = new Map<string, string[]>();
  let converted: ConvertedEntry[] = [];
  let missing: MissingLinkTarget[] = [];
  let warnings: string[] = [];
  for (let pass = 0; pass <= candidates.size; pass++) {
    const resolve = (linkType: LinkType, sourceId: string) =>
      linkType === 'Asset'
        ? assetIds.get(sourceId)
        : candidates.has(sourceId) && !invalid.has(sourceId)
          ? entryIds.get(sourceId)
          : undefined;
    converted = [];
    missing = [];
    warnings = [];
    const unique = new Map<string, string>();
    let changed = false;
    for (const [sourceId, raw] of candidates) {
      if (invalid.has(sourceId)) continue;
      const mapped = types.get(sysId((raw.sys as Json).contentType) ?? '') as MappedContentType;
      const dropped: MissingLinkTarget[] = [];
      const entry = convertEntry(raw, sourceId, mapped, {
        id: entryIds.get(sourceId) as string,
        defaultLocale,
        exportLocales,
        tagIds,
        resolve,
        missing: (field, linkType, target) =>
          dropped.push({ entry: sourceId, field, linkType, target }),
        warn: (message) => warnings.push(message),
      });
      const problems = problemsOf(entry, mapped.contentType, vctx, unique);
      if (problems.length > 0) {
        // The links it lost are often why (a required link to an entry left out), so they're named.
        for (const d of dropped) {
          problems.push(
            `${d.field}: links ${d.linkType.toLowerCase()} ${d.target}, which is not imported`,
          );
        }
        invalid.set(sourceId, problems);
        changed = true;
        continue;
      }
      missing.push(...dropped);
      converted.push(entry);
    }
    if (!changed) break;
  }

  return {
    defaultLocale,
    locales,
    contentTypes: [...types.values()].map((t) => t.contentType),
    tags,
    entries: converted,
    assets,
    entriesRead: rawEntries.length,
    assetsRead: rawAssets.length,
    findings: {
      unmappedFields: findings.unmappedFields,
      unmappedValidations: [...new Set(findings.unmappedValidations)],
      warnings: [...findings.warnings, ...summarize(warnings)],
      missingLinks: missing,
      invalidEntries: [...invalid].map(([entry, messages]) => ({ entry, messages })),
    },
  };
}

function readLocales(raw: readonly unknown[], warnings: string[]): ConvertedLocale[] {
  const declared = raw.filter(isObject).flatMap((l) => {
    const code = str(l.code);
    return code
      ? [
          {
            code,
            name: str(l.name) ?? code,
            fallback: str(l.fallbackCode) ?? null,
            default: l.default === true,
          },
        ]
      : [];
  });
  const codes = new Set(declared.map((l) => l.code));
  return declared.map((l) => {
    if (l.fallback && !codes.has(l.fallback)) {
      warnings.push(
        `Locale ${l.code} falls back to ${l.fallback}, which the export doesn't declare`,
      );
      return { ...l, fallback: null };
    }
    return l;
  });
}

/**
 * Editor interfaces describe the source's editing widgets, which have no counterpart here. The
 * one thing in them that is content, help text written for editors, becomes the field's `help`.
 * One for a field that was not imported, or longer than a field's help may be, is counted, so its
 * loss is visible.
 */
function importHelpTexts(
  raw: readonly unknown[],
  types: Map<string, MappedContentType>,
  warnings: string[],
): void {
  let dropped = 0;
  for (const ei of raw) {
    if (!isObject(ei)) continue;
    const mapped = types.get(sysId(isObject(ei.sys) ? ei.sys.contentType : undefined) ?? '');
    const apiIdOf = new Map(
      [...(mapped?.sourceFieldIds ?? [])].map(([apiId, sourceId]) => [sourceId, apiId]),
    );
    const help = new Map<string, string>();
    for (const control of list(ei.controls)) {
      if (!isObject(control) || !isObject(control.settings)) continue;
      const text = str(control.settings.helpText)?.trim();
      if (!text) continue;
      const apiId = apiIdOf.get(str(control.fieldId) ?? '');
      if (apiId && text.length <= FIELD_GUIDANCE_LIMITS.help) help.set(apiId, text);
      else dropped += 1;
    }
    if (!mapped || help.size === 0) continue;
    const fields = mapped.contentType.fields.map((f) =>
      help.has(f.apiId) ? { ...f, help: help.get(f.apiId) } : f,
    );
    types.set(mapped.sourceId, { ...mapped, contentType: { ...mapped.contentType, fields } });
  }
  if (dropped > 0)
    warnings.push(`${dropped} field help text(s) from editor interfaces are not imported`);
}

/**
 * The export's publication state: published when the current version is the published one plus
 * one (every save bumps the version, and publishing is a save). A newer draft on top of a
 * published version can't be reproduced: the export carries only the draft, so the entry imports
 * as a draft and the count says so.
 */
function publicationOf(sys: Json): 'published' | 'changed' | 'archived' | 'draft' {
  if (sys.archivedVersion !== undefined || sys.archivedAt !== undefined) return 'archived';
  const published = sys.publishedVersion;
  const version = sys.version;
  if (typeof published === 'number') {
    return typeof version !== 'number' || version === published + 1 ? 'published' : 'changed';
  }
  return sys.publishedAt !== undefined ? 'published' : 'draft';
}

function convertAsset(
  raw: Json,
  defaultLocale: string,
  exportLocales: ReadonlySet<string>,
  options: SpaceExportReadOptions,
  warnings: string[],
): ConvertedAsset | undefined {
  const sourceId = sysId(raw);
  const fields = isObject(raw.fields) ? raw.fields : {};
  const files = isObject(fields.file) ? fields.file : {};
  const fileLocale = isObject(files[defaultLocale])
    ? defaultLocale
    : Object.keys(files).find((l) => isObject(files[l]));
  const file = fileLocale ? (files[fileLocale] as Json) : undefined;
  const url = file ? absoluteUrl(str(file.url)) : undefined;
  if (!sourceId || !file || !url) {
    // An upload that was never processed has no URL: there is nothing to copy.
    warnings.push(`Asset ${sourceId ?? '(no id)'} has no file URL and was skipped`);
    return undefined;
  }
  if (Object.keys(files).filter((l) => isObject(files[l])).length > 1) {
    warnings.push(
      `Asset ${sourceId} has a file per locale; the ${fileLocale} one is imported (an asset here has one file)`,
    );
  }
  const details = isObject(file.details) ? file.details : {};
  const image = isObject(details.image) ? details.image : {};
  const sys = isObject(raw.sys) ? raw.sys : {};
  const localized = (value: unknown): LocalizedValue =>
    Object.fromEntries(
      Object.entries(isObject(value) ? value : {}).filter(
        ([locale, v]) => exportLocales.has(locale) && typeof v === 'string',
      ),
    );
  return {
    id: options.newId(),
    sourceId,
    status: publicationOf(sys) === 'published' ? 'published' : 'draft',
    title: localized(fields.title),
    description: localized(fields.description),
    file: {
      url,
      fileName: str(file.fileName) ?? url.split('/').pop() ?? 'file',
      contentType: str(file.contentType) ?? 'application/octet-stream',
      ...(typeof details.size === 'number' ? { size: details.size } : {}),
      ...(typeof image.width === 'number' ? { width: image.width } : {}),
      ...(typeof image.height === 'number' ? { height: image.height } : {}),
    },
  };
}

/** The export writes file URLs protocol-relative (`//host/path`). */
function absoluteUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('//')) return `https:${url}`;
  return /^https?:\/\//i.test(url) ? url : undefined;
}

interface EntryContext {
  readonly id: string;
  readonly defaultLocale: string;
  readonly exportLocales: ReadonlySet<string>;
  readonly tagIds: ReadonlySet<string>;
  resolve(linkType: LinkType, sourceId: string): string | undefined;
  missing(field: string, linkType: LinkType, target: string): void;
  warn(message: string): void;
}

function convertEntry(
  raw: Json,
  sourceId: string,
  mapped: MappedContentType,
  ctx: EntryContext,
): ConvertedEntry {
  const sys = raw.sys as Json;
  const values = isObject(raw.fields) ? raw.fields : {};
  const fields: EntryFields = {};
  const known = new Set(mapped.sourceFieldIds.values());
  for (const key of Object.keys(values)) {
    if (!known.has(key))
      ctx.warn(`values of unmapped field ${mapped.sourceId}.${key} are not imported`);
  }

  for (const field of mapped.contentType.fields) {
    const sourceField = mapped.sourceFieldIds.get(field.apiId) as string;
    const perLocale = values[sourceField];
    if (!isObject(perLocale)) continue;
    const out: LocalizedValue = {};
    for (const [locale, value] of Object.entries(perLocale)) {
      // A field that is not localized keeps one value, under the default locale.
      if (!field.localized && locale !== ctx.defaultLocale) continue;
      if (!ctx.exportLocales.has(locale)) {
        ctx.warn(`values in locale ${locale}, which the export doesn't declare, are not imported`);
        continue;
      }
      const where = `entry ${sourceId} ${field.apiId} (${locale})`;
      const v = convertValue(field, value, where, {
        ...ctx,
        missing: (linkType, target) => ctx.missing(field.apiId, linkType, target),
      });
      if (v !== undefined) out[locale] = v;
    }
    if (Object.keys(out).length > 0) fields[field.apiId] = out;
  }

  const publication = publicationOf(sys);
  if (publication === 'changed') {
    ctx.warn('published entries with newer unpublished changes are imported as drafts');
  } else if (publication === 'archived') {
    ctx.warn('archived entries are imported as drafts');
  }
  const metadata = isObject(raw.metadata) ? raw.metadata : {};
  return {
    id: ctx.id,
    sourceId,
    contentTypeApiId: mapped.contentType.apiId,
    status: publication === 'published' ? 'published' : 'draft',
    fields,
    tags: list(metadata.tags)
      .map(sysId)
      .filter((t): t is string => t !== undefined && ctx.tagIds.has(t)),
  };
}

interface ValueContext {
  resolve(linkType: LinkType, sourceId: string): string | undefined;
  missing(linkType: LinkType, target: string): void;
  warn(message: string): void;
}

function convertValue(
  field: FieldDefinition,
  value: unknown,
  where: string,
  ctx: ValueContext,
): unknown {
  if (value === null || value === undefined) return undefined;
  switch (field.type) {
    case 'Link':
      return convertLink(value, field.linkType, ctx);
    case 'Array': {
      if (!Array.isArray(value)) return value;
      if (field.items?.type !== 'Link') return value;
      const links = value
        .map((item) => convertLink(item, field.items?.linkType, ctx))
        .filter((l) => l !== undefined);
      return links.length > 0 ? links : undefined;
    }
    case 'RichText':
      return convertRichText(value, ctx, where);
    default:
      return value;
  }
}

/** `{ sys: { type: 'Link', linkType, id } }` → `{ id, linkType }` with the id it takes here. */
function convertLink(
  value: unknown,
  expected: LinkType | undefined,
  ctx: ValueContext,
): { id: string; linkType: LinkType } | undefined {
  const sys = isObject(value) && isObject(value.sys) ? value.sys : undefined;
  const sourceId = str(sys?.id);
  const linkType = sys?.linkType === 'Asset' || sys?.linkType === 'Entry' ? sys.linkType : expected;
  if (!sourceId || !linkType) return undefined;
  const id = ctx.resolve(linkType, sourceId);
  if (!id) {
    ctx.missing(linkType, sourceId);
    return undefined;
  }
  return { id, linkType };
}

/**
 * Why an entry would be refused when written: its fields against the mapped content type (with
 * defaults applied first, as a write does) and, for a unique field, a value an earlier entry in
 * the file already holds.
 */
function problemsOf(
  entry: ConvertedEntry,
  type: ContentType,
  vctx: { defaultLocale: string; locales: readonly string[] },
  unique: Map<string, string>,
): string[] {
  const withDefaults = applyDefaults(type, entry.fields, vctx.locales, vctx.defaultLocale);
  const problems = validateEntryFields(type, withDefaults, vctx).map(
    (i) => `${i.field}${i.locale ? ` (${i.locale})` : ''}: ${i.message}`,
  );
  if (problems.length > 0) return problems;
  const claims: string[] = [];
  for (const field of type.fields) {
    if (!field.unique) continue;
    for (const [locale, value] of Object.entries(withDefaults[field.apiId] ?? {})) {
      const key = `${type.apiId}\n${field.apiId}\n${locale}\n${JSON.stringify(value)}`;
      const holder = unique.get(key);
      if (holder) problems.push(`${field.apiId} (${locale}): same value as entry ${holder}`);
      claims.push(key);
    }
  }
  if (problems.length === 0) for (const key of claims) unique.set(key, entry.sourceId);
  return problems;
}

/** Repeated warnings collapse to one line each with a count, so a report stays readable. */
function summarize(warnings: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const w of warnings) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts].map(([w, n]) => (n > 1 ? `${w} (×${n})` : w));
}
