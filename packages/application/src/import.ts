import {
  applyDefaults,
  assertQueryRespectsFieldRules,
  authorize,
  authorizeContent,
  type ContentType,
  type EntryFields,
  NotFoundError,
  normalizeSlugFields,
  type Principal,
  richTextFromHtml,
  SCOPES,
  type Scope,
  unwritableFields,
  ValidationError,
  validateEntryFields,
} from '@commerceworker/domain';
import type { ImportSource, SourceRecord } from '@commerceworker/ports';
import type { AppContext } from './context';
import { createEntry, updateEntry } from './entries';

/**
 * Importing content from somewhere else, in two phases.
 *
 * **Analyze** reads the payload, maps it, and reports exactly what would
 * happen — without writing anything. **Execute** does that same work and
 * commits it. The split is the whole point: a migration is irreversible in
 * practice (nobody un-imports four thousand entries by hand), so the decision
 * to run one should be made while looking at its consequences rather than
 * after them.
 *
 * The two phases share one code path — `plan()` — so the report is not a
 * prediction of what execute will do, it is the same computation.
 *
 * Both run as the `principal` who asked, with the same authority as writing each entry by hand:
 * `write` on the target type (refused up front, before the payload is read), and no record
 * writes a field the role denies or makes read-only (that record is reported and skipped, like
 * one that fails validation). An update keeps what those fields hold (`updateImportedEntry`). An
 * unrestricted principal (no role) is held to the scope alone.
 */

/** How many records the synchronous path will read. */
export const IMPORT_MAX_RECORDS = 10_000;

/**
 * How many the durable path will read.
 *
 * Planning is still one pass over the whole file — it has to be, to report
 * accurately — so this bounds memory, not time. Writing is what gets chunked.
 */
export const IMPORT_JOB_MAX_RECORDS = 250_000;

/** Records staged per durable chunk. */
export const IMPORT_JOB_CHUNK_SIZE = 200;

/** How many existing entries are indexed to detect conflicts. */
export const IMPORT_MAX_EXISTING = 50_000;

/** How many per-record problems are listed before the report just counts them. */
export const IMPORT_MAX_REPORTED_ISSUES = 100;

export interface ImportMapping {
  /** The content type records become. */
  readonly contentTypeApiId: string;
  /** Target field apiId → source field name. Unlisted target fields stay empty. */
  readonly fields: Readonly<Record<string, string>>;
  /**
   * The target field holding each record's source identity.
   *
   * This is what makes an import re-runnable: with it, a second run recognises
   * what it already created. Without it every run creates everything again,
   * which the analysis says out loud rather than leaving to be discovered.
   */
  readonly identityField?: string;
  /** Locale the values are written under. Defaults to the space's default. */
  readonly locale?: string;
}

/** What to do when a record matches an entry that already exists. */
export type ImportConflictPolicy = 'skip' | 'update' | 'fail';

export interface ImportRunOptions {
  /**
   * What to do about a record that matches an existing entry. Defaults to
   * `skip`: leaving what is already there alone is the reversible choice, and
   * an import that overwrites by default destroys edits made since the last run.
   */
  readonly conflicts?: ImportConflictPolicy;
  // Nothing here publishes. Imported entries arrive as drafts, and publishing
  // them is the existing bulk job — which is resumable, cancellable and
  // reportable, none of which a flag on this call would be.
}

/** One record's fate, decided identically by analyze and execute. */
export interface PlannedRecord {
  readonly externalId: string;
  readonly action: 'create' | 'update' | 'skip';
  /** Set when `action` is `update`. */
  readonly entryId?: string;
  readonly fields: EntryFields;
  /** Why it cannot proceed; present means it will not be written. */
  readonly issues: readonly string[];
}

export interface ImportAnalysis {
  readonly contentTypeApiId: string;
  readonly locale: string;
  readonly records: number;
  readonly willCreate: number;
  readonly willUpdate: number;
  readonly willSkip: number;
  /** Records that cannot be written as mapped. */
  readonly invalid: number;
  /**
   * Source fields nothing maps to — the data this import throws away. Reported
   * because "I lost the excerpt column" is only findable before the run.
   */
  readonly unmappedSourceFields: readonly string[];
  /** Required target fields with no source behind them. Blocking. */
  readonly missingRequiredFields: readonly string[];
  /** Target fields the content type does not define. Blocking. */
  readonly unknownTargetFields: readonly string[];
  /** Whatever the source could not read. */
  readonly warnings: readonly string[];
  /** A bounded sample of per-record problems, newest concerns first. */
  readonly issues: readonly { externalId: string; messages: readonly string[] }[];
  /** True when nothing blocks execution. */
  readonly executable: boolean;
}

export interface ImportResult {
  readonly analysis: ImportAnalysis;
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly failed: readonly { externalId: string; message: string }[];
}

export interface ImportInput {
  readonly payload: string;
  readonly mapping: ImportMapping;
  readonly sourceOptions?: Readonly<Record<string, unknown>>;
}

/**
 * Reads a payload and reports what importing it would do. Writes nothing.
 */
export async function analyzeImport(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  source: ImportSource,
  input: ImportInput,
  options: ImportRunOptions = {},
): Promise<ImportAnalysis> {
  // Bounded by the *durable* cap, not the synchronous one. Analysis writes
  // nothing, so what limits it is memory — the same limit a job has. Refusing
  // to describe a file the durable path would happily import would mean an
  // operator could not even find out how big their problem was.
  return (await plan(ctx, principal, scope, source, input, options, IMPORT_JOB_MAX_RECORDS))
    .analysis;
}

/**
 * Imports a payload.
 *
 * Re-analyzes rather than trusting an analysis handed in from outside: the
 * environment can change between the two calls, and acting on a stale plan is
 * how an import overwrites something that appeared in between.
 */
export async function executeImport(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  source: ImportSource,
  input: ImportInput,
  options: ImportRunOptions = {},
): Promise<ImportResult> {
  const { analysis, planned, contentType, blockedFields } = await plan(
    ctx,
    principal,
    scope,
    source,
    input,
    options,
  );
  if (!analysis.executable) {
    throw new ValidationError([
      {
        field: 'mapping',
        message: analysis.missingRequiredFields.length
          ? `Required field(s) with no source: ${analysis.missingRequiredFields.join(', ')}`
          : `Target field(s) not defined on "${contentType.apiId}": ${analysis.unknownTargetFields.join(', ')}`,
      },
    ]);
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const failed: { externalId: string; message: string }[] = [];

  for (const record of planned) {
    if (record.issues.length > 0 || record.action === 'skip') {
      skipped += 1;
      continue;
    }
    try {
      // Judged as the plan judged it: on the record's values (see `EntryWriteOptions.copy`).
      if (record.action === 'update' && record.entryId) {
        await updateImportedEntry(ctx, scope, record.entryId, record.fields, blockedFields);
        updated += 1;
      } else {
        await createEntry(
          ctx,
          scope,
          { contentTypeApiId: contentType.apiId, fields: record.fields },
          { copy: true },
        );
        created += 1;
      }
    } catch (err) {
      // One bad record does not abandon the other nine thousand — the report
      // names it so the operator can fix and re-run just that one.
      failed.push({
        externalId: record.externalId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { analysis, created, updated, skipped, failed };
}

export interface Plan {
  readonly analysis: ImportAnalysis;
  readonly planned: readonly PlannedRecord[];
  readonly contentType: ContentType;
  /** The fields of the type the principal may not write; an update keeps what they hold. */
  readonly blockedFields: readonly string[];
}

/**
 * Writes a planned update, keeping what `blockedFields` hold now. An update's fields become the
 * whole new version, so leaving a field out would clear it, and for a field the role may not
 * write that is a write too. Read here, as the record is written, so neither the plan nor its
 * report depends on those values, and a value set after planning survives a job's later chunk.
 */
export async function updateImportedEntry(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
  fields: EntryFields,
  blockedFields: readonly string[],
): Promise<void> {
  if (blockedFields.length === 0) {
    await updateEntry(ctx, scope, entryId, fields, { copy: true });
    return;
  }
  const found = await ctx.store.entries.get(scope, entryId);
  if (!found) throw new NotFoundError('Entry', entryId);
  const stored = found.fields;
  await updateEntry(
    ctx,
    scope,
    entryId,
    Object.fromEntries([
      ...Object.entries(fields).filter(([apiId]) => !blockedFields.includes(apiId)),
      ...blockedFields.filter((f) => Object.hasOwn(stored, f)).map((f) => [f, stored[f]] as const),
    ]) as EntryFields,
    { copy: true },
  );
}

/**
 * Plans an import without running it, for callers that will run it elsewhere.
 *
 * Exported so the durable path stages exactly the records the synchronous path
 * would have written — one planner, so a job cannot import something the
 * report never described.
 */
export async function planImport(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  source: ImportSource,
  input: ImportInput,
  options: ImportRunOptions = {},
  maxRecords = IMPORT_MAX_RECORDS,
): Promise<Plan> {
  return plan(ctx, principal, scope, source, input, options, maxRecords);
}

/**
 * The shared computation behind both phases.
 *
 * Everything the report says is decided here, so analyze cannot describe an
 * execution that would go differently.
 */
async function plan(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  source: ImportSource,
  input: ImportInput,
  options: ImportRunOptions,
  maxRecords = IMPORT_MAX_RECORDS,
): Promise<Plan> {
  // Every record is a create or an update of this one type, so the type's `write` grant covers
  // the whole run; a type the role can't write is refused before anything is read.
  authorize(principal, SCOPES.contentWrite, scope.spaceId);
  authorizeContent(principal, 'write', input.mapping.contentTypeApiId);
  // Matching on the identity field is a query over it: what the role can't read would answer
  // which values exist (through the skip, update and conflict counts), so it needs `read` on the
  // type and is refused like a filter on a hidden field.
  if (input.mapping.identityField) {
    authorizeContent(principal, 'read', input.mapping.contentTypeApiId);
    assertQueryRespectsFieldRules(principal, {
      contentTypeApiId: input.mapping.contentTypeApiId,
      filters: [{ field: input.mapping.identityField }],
    });
  }
  const contentType = await ctx.store.contentTypes.get(scope, input.mapping.contentTypeApiId);
  if (!contentType) throw new NotFoundError('ContentType', input.mapping.contentTypeApiId);

  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  const locale = input.mapping.locale ?? config.defaultLocale;
  if (!config.locales.includes(locale)) {
    throw new ValidationError([
      { field: 'locale', message: `Locale "${locale}" is not configured for this space` },
    ]);
  }

  // A file the source cannot read is bad input, not a server fault. Without
  // this, a truncated export or a stray character is a 500 and the operator is
  // told nothing about what to fix.
  let read: Awaited<ReturnType<ImportSource['read']>>;
  try {
    read = await source.read(input.payload, input.sourceOptions);
  } catch (err) {
    throw new ValidationError([
      {
        field: 'payload',
        message: `${source.name} source could not read the payload: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
    ]);
  }
  if (read.records.length > maxRecords) {
    throw new ValidationError([
      {
        field: 'payload',
        message: `Source holds ${read.records.length} records; this endpoint reads at most ${maxRecords}. Split the file.`,
      },
    ]);
  }

  const defined = new Map(contentType.fields.map((f) => [f.apiId, f]));
  const mapped = Object.entries(input.mapping.fields);
  const unknownTargetFields = mapped
    .filter(([apiId]) => !defined.has(apiId))
    .map(([apiId]) => apiId);
  const usedSourceFields = new Set(mapped.map(([, sourceField]) => sourceField));
  const unmappedSourceFields = read.fields.filter((f) => !usedSourceFields.has(f));
  const missingRequiredFields = contentType.fields
    .filter((f) => f.required && f.defaultValue === undefined && !(f.apiId in input.mapping.fields))
    .map((f) => f.apiId);

  const blockedFields = unwritableFields(principal, contentType.apiId, Object.fromEntries(defined));
  const existing =
    input.mapping.identityField && unknownTargetFields.length === 0
      ? await indexExisting(ctx, scope, contentType.apiId, input.mapping.identityField, locale)
      : new Map<string, string>();

  const vctx = { defaultLocale: config.defaultLocale, locales: config.locales };
  const planned: PlannedRecord[] = [];
  const seen = new Set<string>();

  for (const record of read.records) {
    const issues: string[] = [];
    // A payload that repeats an id would otherwise import the same thing twice
    // and then look like it worked.
    if (seen.has(record.externalId)) {
      issues.push(`Duplicate identity "${record.externalId}" in the source`);
    }
    seen.add(record.externalId);

    const fields = toFields(record, input.mapping, contentType, locale);
    // Checked on what the record sets, before defaults: a default the role didn't write is
    // allowed, as it is for an entry created by hand.
    for (const apiId of unwritableFields(principal, contentType.apiId, fields)) {
      issues.push(`${apiId}: your role may not write this field`);
    }
    const identity = input.mapping.identityField
      ? asText(record.values[input.mapping.fields[input.mapping.identityField] ?? ''])
      : undefined;
    const match = identity ? existing.get(identity) : undefined;

    let action: PlannedRecord['action'] = 'create';
    if (match) {
      if (options.conflicts === 'fail') {
        issues.push(`An entry already exists with ${input.mapping.identityField} "${identity}"`);
      }
      action = options.conflicts === 'update' ? 'update' : 'skip';
    }

    // Defaults are for a new entry: on an update they would overwrite what the entry holds, as
    // `saveEntryDraft` says. A skipped record is checked as the create it would have been.
    const withDefaults =
      action === 'update'
        ? fields
        : applyDefaults(contentType, fields, config.locales, config.defaultLocale);
    const normalized = normalizeSlugFields(contentType, withDefaults);
    for (const issue of validateEntryFields(contentType, normalized, vctx)) {
      issues.push(`${issue.field}: ${issue.message}`);
    }

    planned.push({
      externalId: record.externalId,
      action,
      ...(match ? { entryId: match } : {}),
      fields: normalized,
      issues,
    });
  }

  const invalid = planned.filter((p) => p.issues.length > 0);
  const analysis: ImportAnalysis = {
    contentTypeApiId: contentType.apiId,
    locale,
    records: planned.length,
    willCreate: planned.filter((p) => p.action === 'create' && p.issues.length === 0).length,
    willUpdate: planned.filter((p) => p.action === 'update' && p.issues.length === 0).length,
    willSkip: planned.filter((p) => p.action === 'skip' || p.issues.length > 0).length,
    invalid: invalid.length,
    unmappedSourceFields,
    missingRequiredFields,
    unknownTargetFields,
    warnings: read.warnings,
    issues: invalid
      .slice(0, IMPORT_MAX_REPORTED_ISSUES)
      .map((p) => ({ externalId: p.externalId, messages: p.issues })),
    // Per-record problems do not block: they are skipped and reported. A
    // mapping that cannot work at all does, because every record would fail
    // the same way and reporting it ten thousand times helps nobody.
    executable: missingRequiredFields.length === 0 && unknownTargetFields.length === 0,
  };

  return { analysis, planned, contentType, blockedFields };
}

/**
 * Indexes existing entries by their identity value.
 *
 * One paged scan rather than a query per record: at a few thousand records the
 * difference is minutes.
 */
async function indexExisting(
  ctx: AppContext,
  scope: Scope,
  contentTypeApiId: string,
  identityField: string,
  locale: string,
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  let cursor = '';
  const pageSize = 500;
  while (index.size < IMPORT_MAX_EXISTING) {
    const page = await ctx.store.entries.list(scope, {
      contentTypeApiId,
      limit: pageSize,
      afterEntryId: cursor,
      select: [identityField],
      // Trashed entries are not matches: an import must not silently revive
      // something someone deleted.
      archived: false,
    });
    for (const found of page) {
      const value = asText(found.fields[identityField]?.[locale]);
      // First write wins, so a re-run updates the same entry it created rather
      // than picking a different duplicate each time.
      if (value !== undefined && !index.has(value)) index.set(value, found.entry.id);
    }
    if (page.length < pageSize) break;
    cursor = page[page.length - 1]?.entry.id ?? '';
    if (!cursor) break;
  }
  return index;
}

/** Maps one source record onto the target content type's field shape. */
function toFields(
  record: SourceRecord,
  mapping: ImportMapping,
  contentType: ContentType,
  locale: string,
): EntryFields {
  const out: EntryFields = {};
  for (const [targetApiId, sourceField] of Object.entries(mapping.fields)) {
    const definition = contentType.fields.find((f) => f.apiId === targetApiId);
    if (!definition) continue;
    const raw = record.values[sourceField];
    if (raw === undefined || raw === null || raw === '') continue;
    const coerced = coerce(raw, definition.type);
    if (coerced === undefined) continue;
    // Non-localized fields live under the default locale, which for an import
    // is the locale being written — the same rule the rest of the platform uses.
    out[targetApiId] = { [locale]: coerced };
  }
  return out;
}

/**
 * Turns a source value into what the field type expects.
 *
 * Sources are mostly stringly-typed (a CSV has no numbers), so this is where a
 * spreadsheet column becomes an Integer. A value that cannot become the target
 * type is passed through untouched rather than dropped, so validation reports
 * it against the record instead of the import silently emptying the field.
 */
function coerce(value: unknown, type: string): unknown {
  switch (type) {
    case 'Integer':
    case 'Number': {
      if (typeof value === 'number') return value;
      const n = Number(String(value).trim());
      return Number.isFinite(n) ? n : value;
    }
    case 'Boolean': {
      if (typeof value === 'boolean') return value;
      const text = String(value).trim().toLowerCase();
      if (['true', 'yes', '1'].includes(text)) return true;
      if (['false', 'no', '0'].includes(text)) return false;
      return value;
    }
    case 'Symbol':
    case 'Slug':
    case 'Text':
    case 'Date':
      return typeof value === 'string' ? value : String(value);
    case 'RichText': {
      // Text arriving for a rich-text field is HTML (a blog export) or plain
      // prose (a spreadsheet cell) — both read as HTML, since plain text is
      // HTML with no tags. A value that is already a document is left alone.
      if (typeof value !== 'string') return value;
      const document = richTextFromHtml(value);
      // Markup with no text in it (an empty block from the editor) is an empty
      // value, so a required field reports it rather than storing a blank document.
      return document.content.length ? document : undefined;
    }
    case 'Array':
      if (Array.isArray(value)) return value;
      // A delimited cell is how a spreadsheet spells a list.
      return typeof value === 'string'
        ? value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
        : value;
    default:
      return value;
  }
}

function asText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' ? value : String(value);
}
