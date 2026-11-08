import type {
  ContentType,
  EntryFields,
  LocaleCode,
  LocalizedValue,
  Tag,
} from '@commerceworker/domain';

/**
 * Reading content out of somewhere else.
 *
 * A source's only job is to turn a payload into flat, neutral records. It does
 * not know about content types, locales, or this platform's shapes — mapping
 * those is the import pipeline's job, and keeping the two apart is what lets a
 * new source be a parser rather than a migration.
 */

/** One thing found in the source, before it means anything here. */
export interface SourceRecord {
  /**
   * The record's identity in the system it came from.
   *
   * Carried so a re-run recognises what it already imported instead of
   * duplicating it — the single most common way a migration goes wrong.
   */
  readonly externalId: string;
  /** Source-shaped values, keyed by whatever the source calls its fields. */
  readonly values: Readonly<Record<string, unknown>>;
  /** What the source considers this to be ("post", "page", a sheet name). */
  readonly kind?: string;
}

export interface SourceReadResult {
  readonly records: readonly SourceRecord[];
  /**
   * Every field name seen, in the order the source presents them.
   *
   * This is what a mapping screen offers, so it must include fields that are
   * empty in the sample — a column that is blank in the first ten rows is
   * still a column.
   */
  readonly fields: readonly string[];
  /**
   * What the source could not read. Named rather than dropped: an import that
   * silently skips a malformed row is how content disappears.
   */
  readonly warnings: readonly string[];
}

/**
 * A reader for one external format.
 *
 * Kept a port rather than a plain function because a source is not always a
 * parser: pulling from a live API is the same seam with I/O behind it.
 */
export interface ImportSource {
  /** Stable identifier, e.g. `csv`, `json`. */
  readonly id: string;
  /** Human-facing name for a chooser. */
  readonly name: string;
  read(payload: string, options?: Readonly<Record<string, unknown>>): Promise<SourceReadResult>;
}

/**
 * A reader for a whole-space export: the content model, locales, tags, entries and assets of
 * another system in one JSON document (the "space export" format). Unlike {@link ImportSource},
 * it does map onto this platform's shapes, because the export carries its own model: there is no
 * mapping screen to send flat records to, and links between entries only mean something once
 * every id has been translated at once.
 */
export interface SpaceExportReader {
  /** Stable identifier, e.g. `space-export`. */
  readonly id: string;
  /** Human-facing name for a chooser. */
  readonly name: string;
  read(payload: string, options: SpaceExportReadOptions): Promise<ConvertedSpace>;
}

export interface SpaceExportReadOptions {
  /**
   * Mints the id an entry or asset takes here. Called once per item, before any value is
   * converted, so a link to an item later in the file (or a cycle) resolves like any other.
   */
  newId(): string;
  /**
   * The locales the target space has. The export's own are added to them; entries are validated
   * against the union, as they will be when written.
   */
  readonly locales: readonly LocaleCode[];
}

/** One locale the export declares, with the locale it falls back to. */
export interface ConvertedLocale {
  readonly code: LocaleCode;
  readonly name: string;
  readonly fallback: LocaleCode | null;
  readonly default: boolean;
}

/** An entry as it will be written: its new id, its fields with every link remapped. */
export interface ConvertedEntry {
  readonly id: string;
  /** Its id in the export, for the report. */
  readonly sourceId: string;
  readonly contentTypeApiId: string;
  /** Published when the export marks its current version published; otherwise a draft. */
  readonly status: 'draft' | 'published';
  readonly fields: EntryFields;
  /** The export's tag ids (see {@link ConvertedSpace.tags}). */
  readonly tags: readonly string[];
}

/** An asset record and where its file is to be copied from. */
export interface ConvertedAsset {
  readonly id: string;
  readonly sourceId: string;
  readonly status: 'draft' | 'published';
  readonly title: LocalizedValue;
  readonly description: LocalizedValue;
  readonly file: {
    /** An absolute http(s) URL; the importer screens it before fetching. */
    readonly url: string;
    readonly fileName: string;
    readonly contentType: string;
    readonly size?: number;
    readonly width?: number;
    readonly height?: number;
  };
}

/** A link whose target the import will not carry, and so dropped from the value. */
export interface MissingLinkTarget {
  /** The linking entry's id in the export. */
  readonly entry: string;
  readonly field: string;
  readonly linkType: 'Entry' | 'Asset';
  /** The target's id in the export. */
  readonly target: string;
}

/** Everything about the export the import cannot carry as it is, named rather than dropped. */
export interface SpaceExportFindings {
  /** Fields not imported, as `contentType.field (Type): why`. */
  readonly unmappedFields: readonly string[];
  /** Validations with no equivalent here, as `contentType.field: rule`. */
  readonly unmappedValidations: readonly string[];
  readonly warnings: readonly string[];
  readonly missingLinks: readonly MissingLinkTarget[];
  /** Entries that would fail validation here, by export id, with why. Not imported. */
  readonly invalidEntries: readonly {
    readonly entry: string;
    readonly messages: readonly string[];
  }[];
}

export interface ConvertedSpace {
  /** The export's default locale. */
  readonly defaultLocale: LocaleCode;
  readonly locales: readonly ConvertedLocale[];
  readonly contentTypes: readonly ContentType[];
  /** Tags by their id in the export (the import creates its own and remaps). */
  readonly tags: readonly Tag[];
  readonly entries: readonly ConvertedEntry[];
  readonly assets: readonly ConvertedAsset[];
  readonly findings: SpaceExportFindings;
  /** Entries in the export, valid or not (`entries` holds the valid ones). */
  readonly entriesRead: number;
  /** Assets in the export, with a file or not (`assets` holds the ones with a file). */
  readonly assetsRead: number;
}
