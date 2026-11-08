/**
 * Pure generator: content-type definitions in → TypeScript source out.
 * The emitted module gives every SDK a typed field shape to plug into their
 * `F extends Fields` generics: `client.getEntry<ArticleFields>(id)`.
 */

/** The subset of a content-type definition the generator reads. Matches the
 *  Management API's `GET .../content-types` items (extra keys are ignored). */
export interface ContentTypeInput {
  readonly apiId: string;
  readonly name?: string;
  readonly fields: readonly FieldInput[];
}

/** An allowed value of an `in` rule: bare, or with the label an editor picks it by. */
export type OptionInput =
  | string
  | number
  | { readonly value: string | number; readonly label?: string };

export interface FieldInput {
  readonly apiId: string;
  readonly name?: string;
  readonly type: string;
  readonly localized?: boolean;
  readonly required?: boolean;
  /** What the field means; emitted as the property's doc comment. */
  readonly description?: string;
  /** How to fill it; emitted as the property's doc comment when there is no description. */
  readonly help?: string;
  readonly validations?: {
    readonly in?: readonly OptionInput[];
    readonly linkContentTypes?: readonly string[];
  };
  readonly linkType?: 'Entry' | 'Asset';
  /** Conditional rules; a field a rule can hide may be absent even when required. */
  readonly rules?: readonly { readonly action: string }[];
  /** For a Date field: `date`, `datetime` or `time`; noted in the doc comment. */
  readonly format?: string;
  readonly items?: {
    readonly type: string;
    readonly format?: string;
    readonly linkType?: 'Entry' | 'Asset';
    readonly validations?: { readonly in?: readonly OptionInput[] };
    readonly fields?: readonly FieldInput[];
    /** For a blocks field (Array-of-Component): the shapes an element may take. */
    readonly variants?: readonly VariantInput[];
  };
  /** For Component fields: the nested definitions. */
  readonly fields?: readonly FieldInput[];
}

/** One variant of a blocks field: an element `{ _type: apiId, _key, ...fields }`. */
export interface VariantInput {
  readonly apiId: string;
  readonly name?: string;
  readonly fields: readonly FieldInput[];
}

export interface GenerateOptions {
  /** Header comment noting provenance (defaults to a generic banner). */
  readonly banner?: string;
}

/** Shared helper types emitted once at the top of every generated module. */
const PRELUDE = `/** A reference to another entry. Delivery may embed the linked entry in place
 *  of this shape when \`include\` depth covers it. */
export interface EntryLink {
  id: string;
  linkType: 'Entry';
}

/** A reference to an asset. */
export interface AssetLink {
  id: string;
  linkType: 'Asset';
}

/** A published asset as Delivery embeds it in place of an \`AssetLink\` (within \`include\`). URLs
 *  are on the media origin: \`renditions\` by name, \`srcset\` the width ladder. Title,
 *  description and alt text are one locale's value with \`?locale=\`, else keyed by locale. */
export interface DeliveredAsset {
  id: string;
  title: string | Record<string, unknown> | null;
  description: string | Record<string, unknown> | null;
  altText: string | Record<string, unknown> | null;
  focalPoint: { x: number; y: number } | null;
  contentType: string;
  size: number | null;
  width: number | null;
  height: number | null;
  kind: 'image' | 'video' | 'audio' | 'document' | 'other';
  url: string;
  renditions: Record<string, string>;
  srcset: { width: number; url: string }[];
  /** ThumbHash (base64) and dominant colour (#rrggbb) to show while it loads; null until ingested. */
  placeholder: { thumbhash: string; dominantColor: string } | null;
  video?: {
    status: string;
    hlsUrl?: string;
    dashUrl?: string;
    thumbnailUrl?: string;
    durationSeconds?: number;
  };
  rights?: { credit?: string; license?: string };
  file: Record<string, unknown>;
}

export interface RichTextMark {
  type: string;
}

/** The data of an \`embed\` node: external media (a video, a post, a track) as structured
 *  metadata, never the provider's HTML. \`url\` is an https page on an allowed provider; render a
 *  player for \`provider\` from it, or a link card. */
export interface EmbedData {
  url: string;
  provider: 'youtube' | 'vimeo' | 'x' | 'bluesky' | 'spotify' | 'soundcloud' | 'mastodon' | (string & {});
  kind?: 'video' | 'post' | 'audio' | 'other';
  title?: string;
  authorName?: string;
  thumbnail?: { url: string; width?: number; height?: number };
  width?: number;
  height?: number;
  aspectRatio?: number;
}

/** A rich-text node. Reference nodes carry \`data.target\`; an \`embed\` node's data is \`EmbedData\`. */
export interface RichTextNode {
  nodeType: string;
  content?: RichTextNode[];
  value?: string;
  marks?: RichTextMark[];
  data?: { target?: EntryLink | AssetLink } & Partial<EmbedData> & Record<string, unknown>;
}

export interface RichTextDocument {
  nodeType: 'document';
  content: RichTextNode[];
  data?: Record<string, unknown>;
}

export interface Location {
  lat: number;
  lon: number;
}

/** Management (draft) values are keyed by locale code. */
export type Localized<T> = Record<string, T>;
`;

/** Generates a self-contained TypeScript module from content-type definitions. */
export function generateTypes(
  contentTypes: readonly ContentTypeInput[],
  opts: GenerateOptions = {},
): string {
  const banner =
    opts.banner ??
    'Generated by @commerceworker/sdk-codegen from your content model. Do not edit by hand.';
  const names = assignTypeNames(contentTypes);
  const sections: string[] = [`// ${banner}\n`, PRELUDE];

  for (const ct of contentTypes) {
    const typeName = names.get(ct.apiId) as string;
    sections.push(renderContentType(ct, typeName));
  }

  if (contentTypes.length > 0) {
    const ids = contentTypes.map((ct) => literal(ct.apiId)).join(' | ');
    const deliveryRows = contentTypes
      .map((ct) => `  ${propertyKey(ct.apiId)}: ${names.get(ct.apiId)}Fields;`)
      .join('\n');
    const draftRows = contentTypes
      .map((ct) => `  ${propertyKey(ct.apiId)}: ${names.get(ct.apiId)}DraftFields;`)
      .join('\n');
    sections.push(
      `export type ContentTypeApiId = ${ids};\n`,
      `/** Delivery field shapes by content type apiId. */\nexport interface FieldsByContentType {\n${deliveryRows}\n}\n`,
      `/** Management (locale-keyed) field shapes by content type apiId. */\nexport interface DraftFieldsByContentType {\n${draftRows}\n}\n`,
    );
  }

  return sections.join('\n');
}

function renderContentType(ct: ContentTypeInput, typeName: string): string {
  const label = escapeComment(ct.name ? `${ct.name} (\`${ct.apiId}\`)` : `\`${ct.apiId}\``);
  const delivery: string[] = [];
  const draft: string[] = [];

  for (const field of ct.fields) {
    const key = propertyKey(field.apiId);
    const opt = present(field) ? '' : '?';
    const comment = fieldComment(field);
    delivery.push(`${comment}  ${key}${opt}: ${fieldValueType(field, { delivered: true })};`);
    draft.push(`${comment}  ${key}${opt}: Localized<${fieldValueType(field)}>;`);
  }

  // Type aliases, not interfaces: aliases get an implicit index signature, so
  // they satisfy the SDKs' `F extends Record<string, unknown>` generics.
  return [
    `/** ${label} — Delivery shape (locale-flattened; request with \`?locale=\`). */\nexport type ${typeName}Fields = {\n${delivery.join('\n')}\n};\n`,
    `/** ${label} — Management shape (locale-keyed draft values). */\nexport type ${typeName}DraftFields = {\n${draft.join('\n')}\n};\n`,
  ].join('\n');
}

/**
 * Maps a field definition to the TypeScript type of a single (locale-resolved) value. With
 * `delivered`, an asset link may arrive embedded (Delivery resolves it within `include`); a draft
 * value is always the bare link.
 */
export function fieldValueType(field: FieldInput, opts: { delivered?: boolean } = {}): string {
  const asset = opts.delivered ? 'AssetLink | DeliveredAsset' : 'AssetLink';
  // `in` validations narrow to a literal union only where the domain actually
  // enforces them (Symbol/Text/Integer/Number) — elsewhere stored values may
  // legally fall outside the list, so the wider type is the truthful one.
  switch (field.type) {
    case 'Symbol':
    case 'Text':
      return literalUnion(field.validations?.in) ?? 'string';
    // A Slug is a constrained string; the constraint is enforced on write, and
    // a narrower TS type would only make consumers cast.
    case 'Slug':
      return 'string';
    case 'Date':
      return 'string';
    case 'Integer':
    case 'Number':
      return literalUnion(field.validations?.in) ?? 'number';
    case 'Boolean':
      return 'boolean';
    case 'Location':
      return 'Location';
    case 'JSON':
      return 'Record<string, unknown>';
    case 'RichText':
      return 'RichTextDocument';
    case 'Link':
      return field.linkType === 'Asset' ? asset : 'EntryLink';
    // Emitted inline rather than as a named interface: a component's shape has
    // no identity outside the field that holds it, and naming it would mean
    // inventing collision-prone names for something nobody imports by name.
    case 'Component':
      return componentType(field.fields, opts);
    // A component of fixed shape (the domain's SEO_FIELDS), spelled out: the SDK depends on nothing.
    case 'Seo':
      return `{ title?: string; description?: string; canonicalUrl?: string; noindex?: boolean; ogImage?: ${asset} }`;
    case 'Array': {
      const items = field.items;
      if (items?.type === 'Link') {
        return items.linkType === 'Asset'
          ? opts.delivered
            ? '(AssetLink | DeliveredAsset)[]'
            : 'AssetLink[]'
          : 'EntryLink[]';
      }
      if (items?.type === 'Component' && items.variants?.length) {
        return `(${items.variants.map((v) => blockType(v, opts)).join(' | ')})[]`;
      }
      if (items?.type === 'Component') return `${componentType(items.fields, opts)}[]`;
      if (items?.type === 'Integer' || items?.type === 'Number') return 'number[]';
      // Symbol, Text and Date elements are strings.
      return 'string[]';
    }
    default:
      return 'unknown';
  }
}

/**
 * Whether a value is always there: a required field, unless a rule can hide it (a hidden field is
 * not required, so its value may be missing).
 */
function present(field: FieldInput): boolean {
  if (!field.required) return false;
  return !(Array.isArray(field.rules) && field.rules.some((r) => r?.action === 'hide'));
}

/** A component's nested fields as an inline object type. */
function componentType(
  fields: readonly FieldInput[] | undefined,
  opts: { delivered?: boolean } = {},
): string {
  if (!fields || fields.length === 0) return 'Record<string, unknown>';
  const rows = fields
    .map((f) => `${propertyKey(f.apiId)}${present(f) ? '' : '?'}: ${fieldValueType(f, opts)}`)
    .join('; ');
  // No `Localized<>` on nested values: a component is localized as a whole, so
  // the locale is resolved one level up and every leaf here is a bare value.
  return `{ ${rows} }`;
}

/**
 * One blocks variant as an inline object type, discriminated on `_type`, so a
 * `switch (block._type)` narrows to the variant's fields. `_key` is always
 * present on a stored block: the server assigns one on write.
 */
function blockType(variant: VariantInput, opts: { delivered?: boolean } = {}): string {
  const rows = variant.fields
    .map((f) => `${propertyKey(f.apiId)}${present(f) ? '' : '?'}: ${fieldValueType(f, opts)}`)
    .join('; ');
  return `{ _type: ${literal(variant.apiId)}; _key: string${rows ? `; ${rows}` : ''} }`;
}

/** An `in` validation becomes a literal union of its stored values (`'a' | 'b'`); absent → null. */
function literalUnion(options: readonly OptionInput[] | undefined): string | null {
  if (!Array.isArray(options) || options.length === 0) return null;
  return options.map((o) => literal(typeof o === 'object' ? o.value : o)).join(' | ');
}

function literal(value: string | number): string {
  return typeof value === 'number' ? String(value) : `'${escapeString(value)}'`;
}

/** Escapes a value for a single-quoted TS string literal. */
function escapeString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Quotes a property key unless it is already a valid identifier. */
function propertyKey(apiId: string): string {
  return IDENTIFIER.test(apiId) ? apiId : `'${escapeString(apiId)}'`;
}

function fieldComment(field: FieldInput): string {
  const notes: string[] = [];
  if (field.name && field.name !== field.apiId) notes.push(escapeComment(field.name));
  // One line of guidance: the description says what the field means, which is what someone
  // reading a type wants; help is the fallback.
  const guidance = (field.description ?? field.help)?.replace(/\s+/g, ' ').trim();
  if (guidance) notes.push(escapeComment(guidance));
  const format =
    field.type === 'Date'
      ? field.format
      : field.items?.type === 'Date'
        ? field.items.format
        : undefined;
  const written = format ? DATE_WRITTEN[format] : undefined;
  if (written) notes.push(written);
  if (field.localized) notes.push('localized');
  if (Array.isArray(field.rules) && field.rules.length > 0) {
    const actions = [...new Set(field.rules.map((r) => r?.action).filter(Boolean))];
    notes.push(escapeComment(`conditional: ${actions.join(', ')} by rules`));
  }
  if (field.linkType || field.items?.linkType) {
    const allowed = field.validations?.linkContentTypes;
    if (allowed?.length) notes.push(escapeComment(`links: ${allowed.join(', ')}`));
  }
  return notes.length ? `  /** ${notes.join(' — ')} */\n` : '';
}

/** How each Date format is written, for the doc comment. */
const DATE_WRITTEN: Readonly<Record<string, string>> = {
  date: 'date: YYYY-MM-DD',
  datetime: 'date and time: YYYY-MM-DDThh:mm',
  time: 'time: hh:mm',
};

function escapeComment(text: string): string {
  return text.replace(/\*\//g, '*\\/');
}

/** apiId → PascalCase type name, deduplicated across the model. */
function assignTypeNames(contentTypes: readonly ContentTypeInput[]): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const ct of contentTypes) {
    let name = pascalCase(ct.apiId);
    if (!name) name = 'ContentType';
    let candidate = name;
    let n = 2;
    while (taken.has(candidate)) candidate = `${name}${n++}`;
    taken.add(candidate);
    names.set(ct.apiId, candidate);
  }
  return names;
}

function pascalCase(apiId: string): string {
  return apiId
    .replace(/^[0-9]+/, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
