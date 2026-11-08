import {
  type Asset,
  emptyAssetMetadata,
  NotFoundError,
  type Scope,
  ValidationError,
} from '@commerceworker/domain';
import type {
  BlobStore,
  BulkJob,
  ConvertedSpace,
  MissingLinkTarget,
  SpaceConfig,
  SpaceExportReader,
} from '@commerceworker/ports';
import { assetObjectKey } from './assets';
import type { AppContext } from './context';
import { startSnapshotImport } from './snapshot-jobs';
import { type EnvironmentSnapshot, SNAPSHOT_VERSION } from './snapshots';

/**
 * Importing a whole space from the JSON "space export" format: content model, locales, tags,
 * entries and assets, with every link remapped to the ids they take here.
 *
 * Two calls, like every import. **Analyze** reads the export and reports what would happen
 * (counts, the fields and validations with no equivalent, the links that would dangle, the
 * entries that would fail) without writing. **Start** does the same reading, then hands the
 * result to the environment import's job machinery: the content model and taxonomy are written
 * at once, the assets (files copied from the export's URLs) and entries are created by a
 * resumable job, and what the export marks published is published by the job it chains. Reusing
 * that path is the point: validation, the reference graph, the publish gate, ingest and the
 * read model all behave exactly as they do for any other import.
 *
 * Like an environment import, it needs an environment with no content types: merging another
 * system's model into an existing one is a different operation.
 */

/** Most missing links and invalid entries listed before the report only counts them. */
export const SPACE_EXPORT_MAX_REPORTED = 100;

export interface SpaceExportImportInput {
  /** The export file's text. */
  readonly payload: string;
  /** Publish what the export marks published (default true). */
  readonly publish?: boolean;
  /**
   * Add the export's locales the space lacks. Changing a space's locales is a space admin's call,
   * so the surface sets this only for a caller holding `space:admin`; without it, missing locales
   * stop the import.
   */
  readonly addLocales?: boolean;
}

export interface SpaceExportReport {
  readonly dryRun: boolean;
  /** False when `problems` is non-empty: nothing would be written. */
  readonly executable: boolean;
  /** What stops the import as a whole. */
  readonly problems: readonly string[];
  readonly locales: {
    readonly default: string;
    /** In the export, with their fallbacks. */
    readonly declared: readonly { readonly code: string; readonly fallback: string | null }[];
    /** In the export but not the space: added by the import (`addLocales`), else a problem. */
    readonly toAdd: readonly string[];
  };
  readonly contentTypes: number;
  readonly tags: number;
  readonly entries: {
    readonly read: number;
    readonly imported: number;
    readonly published: number;
    readonly invalid: number;
  };
  readonly assets: { readonly read: number; readonly imported: number; readonly published: number };
  readonly unmappedFields: readonly string[];
  readonly unmappedValidations: readonly string[];
  readonly warnings: readonly string[];
  /** Links dropped because their target is not imported (first {@link SPACE_EXPORT_MAX_REPORTED}). */
  readonly missingLinks: readonly MissingLinkTarget[];
  readonly missingLinkCount: number;
  /** Entries not imported, with why (first {@link SPACE_EXPORT_MAX_REPORTED}). */
  readonly invalidEntries: readonly {
    readonly entry: string;
    readonly messages: readonly string[];
  }[];
}

export interface StartedSpaceExportImport {
  readonly report: SpaceExportReport;
  /** Creates the assets and entries; null when the export holds neither. */
  readonly job: BulkJob | null;
  /** Publishes what the export marks published, once `job` completes with no failures. */
  readonly publishJobId: string | null;
}

/** Reads an export and reports what importing it into `scope` would do. Writes nothing. */
export async function analyzeSpaceExport(
  ctx: AppContext,
  scope: Scope,
  reader: SpaceExportReader,
  input: SpaceExportImportInput,
): Promise<SpaceExportReport> {
  return (await plan(ctx, scope, reader, input)).report;
}

/**
 * Imports an export into `scope`: everything `analyzeSpaceExport` checks is checked again (the
 * environment can change between the two calls), then locales, model and taxonomy are written
 * and the rest runs as jobs.
 */
export async function startSpaceExportImport(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  reader: SpaceExportReader,
  input: SpaceExportImportInput,
): Promise<StartedSpaceExportImport> {
  const { report, space, config } = await plan(ctx, scope, reader, input);
  if (!report.executable) {
    throw new ValidationError(report.problems.map((message) => ({ field: 'payload', message })));
  }

  const publishing = input.publish !== false;
  const assets = space.assets.map(
    (a): Asset => ({
      id: a.id,
      status: a.status,
      // The URL is the stored one, filled in once the file is copied (see copyRemoteAsset).
      file: {
        url: '',
        fileName: a.file.fileName,
        contentType: a.file.contentType,
        ...(a.file.size !== undefined ? { size: a.file.size } : {}),
        ...(a.file.width !== undefined ? { width: a.file.width } : {}),
        ...(a.file.height !== undefined ? { height: a.file.height } : {}),
      },
      title: a.title,
      description: a.description,
      metadata: emptyAssetMetadata,
      version: 1,
      r2Key: assetObjectKey(scope, a.id, a.file.fileName),
      createdAt: ctx.clock.now().toISOString(),
    }),
  );
  const snapshot: EnvironmentSnapshot = {
    snapshotVersion: SNAPSHOT_VERSION,
    exportedAt: ctx.clock.now().toISOString(),
    source: { spaceId: scope.spaceId, environmentId: scope.environmentId },
    contentTypes: space.contentTypes,
    entries: space.entries.map((e) => ({
      id: e.id,
      contentTypeApiId: e.contentTypeApiId,
      status: e.status,
      fields: e.fields,
      metadata: { tags: e.tags, concepts: [] },
    })),
    assets,
    taxonomy: { schemes: [], concepts: [], tags: space.tags },
    workflows: [],
  };

  // Locales before anything that is validated against them. Only added, never changed: an
  // existing locale keeps its fallback, and the default is the export's already (or this
  // would have been refused).
  if (report.locales.toAdd.length > 0) {
    const added = space.locales.filter((l) => report.locales.toAdd.includes(l.code));
    await ctx.store.spaces.create({
      ...config,
      locales: [...config.locales, ...added.map((l) => l.code)],
      fallbacks: {
        ...(config.fallbacks ?? {}),
        ...Object.fromEntries(added.map((l) => [l.code, l.fallback])),
      },
    });
  }

  const started = await startSnapshotImport(ctx, blob, scope, snapshot, {
    publish: publishing,
    remoteFiles: new Map(space.assets.map((a) => [a.id, a.file.url])),
  });
  return {
    report: { ...report, dryRun: false },
    job: started.job,
    publishJobId: started.publishJobId,
  };
}

interface Planned {
  readonly report: SpaceExportReport;
  readonly space: ConvertedSpace;
  readonly config: SpaceConfig;
}

/** The shared reading behind both calls, so the report describes the run that would happen. */
async function plan(
  ctx: AppContext,
  scope: Scope,
  reader: SpaceExportReader,
  input: SpaceExportImportInput,
): Promise<Planned> {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  const environments = await ctx.store.spaces.listEnvironments(scope.spaceId);
  if (!environments.some((e) => e.id === scope.environmentId)) {
    throw new NotFoundError('Environment', `${scope.spaceId}/${scope.environmentId}`);
  }

  let space: ConvertedSpace;
  try {
    space = await reader.read(input.payload, {
      newId: () => ctx.ids.newId(),
      locales: config.locales,
    });
  } catch (err) {
    // A file the reader can't read is bad input, not a server fault.
    throw new ValidationError([
      {
        field: 'payload',
        message: `${reader.name} could not be read: ${err instanceof Error ? err.message : String(err)}`,
      },
    ]);
  }

  const problems: string[] = [];
  const existing = await ctx.store.contentTypes.list(scope);
  if (existing.length > 0) {
    problems.push(
      `Environment "${scope.environmentId}" already defines ${existing.length} content type(s); import into an empty environment`,
    );
  }
  if (space.defaultLocale !== config.defaultLocale) {
    // Values of fields that aren't localized live under the default locale on both sides, so a
    // different default would put them under a locale the space doesn't treat as one.
    problems.push(
      `The export's default locale is ${space.defaultLocale}; this space's is ${config.defaultLocale}. Import into a space whose default locale is ${space.defaultLocale}.`,
    );
  }
  const toAdd = space.locales.map((l) => l.code).filter((code) => !config.locales.includes(code));
  if (toAdd.length > 0 && !input.addLocales) {
    problems.push(
      `This space has no ${toAdd.join(', ')} locale(s). A space admin can import with addLocales to add them, or add them to the space first.`,
    );
  }

  const publishing = input.publish !== false;
  const { findings } = space;
  return {
    space,
    config,
    report: {
      dryRun: true,
      executable: problems.length === 0,
      problems,
      locales: {
        default: space.defaultLocale,
        declared: space.locales.map((l) => ({ code: l.code, fallback: l.fallback })),
        toAdd,
      },
      contentTypes: space.contentTypes.length,
      tags: space.tags.length,
      entries: {
        read: space.entriesRead,
        imported: space.entries.length,
        published: publishing ? space.entries.filter((e) => e.status === 'published').length : 0,
        invalid: findings.invalidEntries.length,
      },
      assets: {
        read: space.assetsRead,
        imported: space.assets.length,
        published: publishing ? space.assets.filter((a) => a.status === 'published').length : 0,
      },
      unmappedFields: findings.unmappedFields,
      unmappedValidations: findings.unmappedValidations,
      warnings: findings.warnings,
      missingLinks: findings.missingLinks.slice(0, SPACE_EXPORT_MAX_REPORTED),
      missingLinkCount: findings.missingLinks.length,
      invalidEntries: findings.invalidEntries.slice(0, SPACE_EXPORT_MAX_REPORTED),
    },
  };
}
