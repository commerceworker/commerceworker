import { ConflictError, ValidationError } from '../errors';
import type { ContentTypeStatus } from '../types';
import { DATE_FORMAT_EXAMPLES, dateSortKey } from './dates';
import {
  ARRAY_ITEM_TYPES,
  type ComponentVariant,
  DATE_FORMATS,
  type DateFormat,
  FIELD_GUIDANCE_LIMITS,
  type FieldDefinition,
  type FieldOption,
  type FieldValidations,
  isValidApiId,
  MAX_COMPONENT_DEPTH,
  MESSAGE_RULES,
  type MessageRule,
  normalizeOptions,
  optionKey,
  optionProblem,
  optionValue,
  UNIQUE_FIELD_TYPES,
  unsafeRegexReason,
} from './field';
import { MAX_FIELD_RULES, ruleProblem, ruleTarget } from './field-rules';
import { type ContentTypeLayout, checkLayout } from './layout';
import { isPatternPreset, PATTERN_PRESETS, presetRegexp } from './patterns';
import { type ContentTypePreview, checkPreviewTemplate } from './preview';

/** What a define or revision may allow, by deployment rather than by type. */
export interface ContentTypeOptions {
  /** A preview URL on plain http to localhost or 127.0.0.1: a local stack only. */
  readonly previewLoopback?: boolean;
}

/**
 * A content type: the schema for a class of entries. Definitions are versioned
 * and environment-scoped (carried by the repository, not the entity itself).
 */
export interface ContentType {
  readonly apiId: string;
  readonly name: string;
  /** apiId of the field used as the entry's display title. */
  readonly displayField: string;
  readonly fields: readonly FieldDefinition[];
  /**
   * Where the type's entries live on the site, e.g. `/blog/{slug}` (`urlPath`). A publish that
   * changes a slug it names redirects the old path to the new one; a preview link can be built
   * from it too.
   */
  readonly urlPattern?: string;
  /**
   * At most one entry outside the trash: a site's settings, its home page, its footer. Delivery
   * serves it at `GET …/singletons/:apiId`. Present only when true. Held by a unique claim
   * ({@link singletonClaim}), so two concurrent creates can't both win.
   */
  readonly singleton?: true;
  /** The admin's sidebar lists types under their group (`Marketing`, `Docs`). Plain text. */
  readonly group?: string;
  /** What the type is for, for editors choosing one and agents reading the model. Plain text. */
  readonly description?: string;
  /** A short icon name the admin draws beside the type, in kebab case (`newspaper`). */
  readonly icon?: string;
  /**
   * How an agent should write this type's entries (tone, what to avoid, which fields go together).
   * Plain text, returned with the model. Written by whoever may manage the model; never delivered.
   */
  readonly agentInstructions?: string;
  /**
   * How the admin's entry form arranges the fields into tabs and groups. Editor-only: it changes
   * nothing stored or validated, and Delivery never serves it.
   */
  readonly layout?: ContentTypeLayout;
  /**
   * Where the admin previews the type's entries on the customer's frontend
   * ({@link ContentTypePreview}). Editor-only: Delivery never serves it.
   */
  readonly preview?: ContentTypePreview;
  readonly version: number;
  readonly status: ContentTypeStatus;
}

/**
 * The definition a type last published, kept while a draft revision holds its row: what Delivery
 * serves until the draft is published. Only what Delivery reads; the admin-only details aren't in
 * it. `version` is the published revision's, so a schema cached by version survives a draft.
 */
export interface PublishedContentTypeDefinition {
  readonly name: string;
  readonly displayField: string;
  readonly fields: readonly FieldDefinition[];
  readonly urlPattern?: string;
  readonly singleton?: true;
  readonly version: number;
}

/**
 * A type as Delivery reads it. Only what Delivery needs: the admin-only details are never in it,
 * so nothing delivered can come to depend on them.
 */
export type DeliveredContentType = Omit<
  ContentType,
  'group' | 'description' | 'icon' | 'agentInstructions' | 'layout' | 'preview'
>;

/**
 * A type as Delivery serves it. A published row is the published definition, whatever else is
 * stored. A draft with a `published` definition is a live type with an unpublished revision, and
 * serves that, reporting `published`. A draft with none stays as it is: never published, or
 * revised before published definitions were kept, and Delivery can't tell which. The singleton
 * flag is always the one last published.
 */
export function deliveredContentType(
  current: DeliveredContentType,
  published: PublishedContentTypeDefinition | null,
  publishedSingleton: boolean,
): DeliveredContentType {
  const { apiId, status } = current;
  const flag = publishedSingleton ? { singleton: true as const } : {};
  if (status === 'published' || !published) {
    return {
      apiId,
      name: current.name,
      displayField: current.displayField,
      fields: current.fields,
      ...(current.urlPattern ? { urlPattern: current.urlPattern } : {}),
      ...flag,
      version: current.version,
      status,
    };
  }
  return {
    apiId,
    name: published.name,
    displayField: published.displayField,
    fields: published.fields,
    ...(published.urlPattern ? { urlPattern: published.urlPattern } : {}),
    ...flag,
    version: published.version,
    status: 'published',
  };
}

export interface ContentTypeDraft {
  apiId: string;
  name: string;
  displayField: string;
  fields: FieldDefinition[];
  /** `null` or `''` clears it on a revision. */
  urlPattern?: string | null;
  /** Holds at most one entry ({@link ContentType.singleton}). Left out on a revision, kept. */
  singleton?: boolean;
  /** Each of these: left out keeps it on a revision; `null` (or blank text) clears it. */
  group?: string | null;
  description?: string | null;
  icon?: string | null;
  agentInstructions?: string | null;
  layout?: ContentTypeLayout | null;
  /** Left out keeps it on a revision; `null` clears it. Checked against the revised fields. */
  preview?: ContentTypePreview | null;
}

/** The longest group, description, icon name and agent instructions. */
export const CONTENT_TYPE_LIMITS = {
  group: 100,
  description: 2000,
  icon: 40,
  agentInstructions: 4000,
} as const;

const ICON_NAME = /^[a-z][a-z0-9-]*$/;

/** What a revision may change; everything but the apiId. */
export type ContentTypeChanges = Partial<
  Pick<
    ContentTypeDraft,
    | 'name'
    | 'displayField'
    | 'fields'
    | 'urlPattern'
    | 'singleton'
    | 'group'
    | 'description'
    | 'icon'
    | 'agentInstructions'
    | 'layout'
    | 'preview'
  >
>;

/**
 * Validates a content type definition for internal consistency and returns a
 * normalized `ContentType` at version 1, status "draft". Throws on invalid
 * input so callers never persist a malformed schema.
 */
export function defineContentType(
  draft: ContentTypeDraft,
  options: ContentTypeOptions = {},
): ContentType {
  if (!isValidApiId(draft.apiId)) {
    throw new ValidationError([
      { field: 'apiId', message: `Invalid content type apiId "${draft.apiId}"` },
    ]);
  }
  const fields = compilePatternPresets(draft.fields);
  assertFieldsValid(fields, draft.displayField, undefined);
  const urlPattern = draft.urlPattern ? checkUrlPattern(draft.urlPattern, fields) : undefined;
  const preview = previewOf(draft.preview, fields, { allowLoopback: options.previewLoopback });
  return {
    apiId: draft.apiId,
    name: draft.name,
    displayField: draft.displayField,
    fields: [...fields].map(withoutBlankGuidance).sort((a, b) => a.position - b.position),
    ...(urlPattern ? { urlPattern } : {}),
    ...(draft.singleton ? { singleton: true as const } : {}),
    ...typeDetails(draft, undefined, fields),
    ...(preview ? { preview } : {}),
    version: 1,
    status: 'draft',
  };
}

/**
 * Produces the next version of a content type from an edited field set. The
 * current definition is the baseline for the checks that only refuse what is
 * new, so a type stored before a check existed can still be revised.
 */
export function reviseContentType(
  current: ContentType,
  changes: ContentTypeChanges,
  options: ContentTypeOptions = {},
): ContentType {
  const fields = compilePatternPresets(changes.fields ?? [...current.fields], current.fields);
  const displayField = changes.displayField ?? current.displayField;
  assertFieldsValid(fields, displayField, current.fields);
  // Checked against the revised fields too: removing the slug a kept pattern names is refused.
  const pattern = changes.urlPattern === undefined ? current.urlPattern : changes.urlPattern;
  const urlPattern = pattern ? checkUrlPattern(pattern, fields) : undefined;
  const singleton = changes.singleton ?? current.singleton === true;
  const preview = revisedPreview(current.preview, changes.preview, fields, options);
  const {
    urlPattern: _old,
    singleton: _was,
    group: _g,
    description: _d,
    icon: _i,
    agentInstructions: _a,
    layout: _l,
    preview: _p,
    ...rest
  } = current;
  return {
    ...rest,
    name: changes.name ?? current.name,
    displayField,
    fields: [...fields].map(withoutBlankGuidance).sort((a, b) => a.position - b.position),
    ...(urlPattern ? { urlPattern } : {}),
    ...(singleton ? { singleton: true as const } : {}),
    ...typeDetails(changes, current, fields),
    ...(preview ? { preview } : {}),
    version: current.version + 1,
    status: 'draft',
  };
}

/**
 * A revision's preview setting. A template sent is checked against the revised fields, strictly
 * when it is new; sent back as stored, its scheme passes as it stands (a loopback URL saved on a
 * local stack stays editable). Left out, the stored one is kept while it still checks, and dropped
 * when it doesn't: code that never heard of it may have removed the field it names, and a save
 * that doesn't mention it must not be refused for it.
 */
function revisedPreview(
  stored: ContentTypePreview | undefined,
  given: ContentTypePreview | null | undefined,
  fields: readonly FieldDefinition[],
  options: ContentTypeOptions,
): ContentTypePreview | undefined {
  if (given === undefined) {
    if (!stored) return undefined;
    try {
      return previewOf(stored, fields, { allowLoopback: true });
    } catch (err) {
      if (err instanceof ValidationError) return undefined;
      throw err;
    }
  }
  const asStored =
    typeof given?.urlTemplate === 'string' && given.urlTemplate.trim() === stored?.urlTemplate;
  return previewOf(given, fields, { allowLoopback: asStored || options.previewLoopback });
}

/** A type's preview setting as stored: null or a blank template clears it. */
function previewOf(
  given: ContentTypePreview | null | undefined,
  fields: readonly FieldDefinition[],
  check: { allowLoopback?: boolean | undefined },
): ContentTypePreview | undefined {
  if (!given) return undefined;
  const raw: unknown = (given as { urlTemplate?: unknown }).urlTemplate;
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new ValidationError([
      { field: 'preview.urlTemplate', message: 'urlTemplate must be text' },
    ]);
  }
  return {
    urlTemplate: checkPreviewTemplate(raw, fields, { allowLoopback: check.allowLoopback === true }),
  };
}

/**
 * A type's group, description, icon, agent instructions and layout as stored, from a draft or revision: left out
 * keeps the current value, `null` or blank text clears it. A value stored as it stands passes
 * unchecked, so a type saved before a check existed stays editable. The layout is checked against
 * the fields as revised: a field the revision removes leaves the layout quietly (there is nothing
 * left to draw), and a name the stored layout already held without a field is pruned the same way,
 * whether the layout is kept or sent back.
 */
function typeDetails(
  input: ContentTypeChanges,
  current: ContentType | undefined,
  fields: readonly FieldDefinition[],
): Pick<ContentType, 'group' | 'description' | 'icon' | 'agentInstructions' | 'layout'> {
  const fail = (field: string, message: string): never => {
    throw new ValidationError([{ field, message }]);
  };
  const out: {
    group?: string;
    description?: string;
    icon?: string;
    agentInstructions?: string;
    layout?: ContentTypeLayout;
  } = {};
  const text = (key: 'group' | 'description' | 'icon' | 'agentInstructions') => {
    const given: unknown = input[key];
    if (given === undefined) {
      const kept = current?.[key];
      if (kept !== undefined) out[key] = kept;
      return;
    }
    if (given === null || (typeof given === 'string' && given.trim() === '')) return;
    if (sameJson(given, current?.[key])) {
      out[key] = given as string;
      return;
    }
    if (typeof given !== 'string') return fail(key, `${key} must be text`);
    const value = key === 'description' || key === 'agentInstructions' ? given : given.trim();
    if (value.length > CONTENT_TYPE_LIMITS[key]) {
      fail(key, `${key} must be at most ${CONTENT_TYPE_LIMITS[key]} characters`);
    }
    if (key === 'icon' && !ICON_NAME.test(value)) {
      fail('icon', 'An icon is a kebab-case name, e.g. newspaper or shopping-bag');
    }
    out[key] = value;
  };
  text('group');
  text('description');
  text('icon');
  text('agentInstructions');

  const known = new Set(fields.map((f) => f.apiId));
  // Names the stored layout carries that no revised field answers: stale already, or removed now.
  const stale = new Set(
    (current?.layout?.tabs ?? []).flatMap((t) =>
      (t.groups ?? []).flatMap((g) => (g.fields ?? []).filter((f) => !known.has(f))),
    ),
  );
  if (input.layout === undefined) {
    // Carried over: whatever no longer names a field goes, so a kept layout never blocks a save.
    const layout = current?.layout ? checkLayout(current.layout, fields, stale) : undefined;
    if (layout) out.layout = layout;
  } else if (input.layout !== null) {
    // Sent: a field the revision removes, or a name the stored layout already held without a
    // field (a client sending back what it read), goes quietly. A new name for no field is refused.
    const removed = new Set([
      ...stale,
      ...(current?.fields ?? []).map((f) => f.apiId).filter((apiId) => !known.has(apiId)),
    ]);
    const layout = checkLayout(input.layout, fields, removed);
    if (layout) out.layout = layout;
  }
  return out;
}

/**
 * Writes each named pattern preset's `pattern` and `flags` into its rule, at every depth, so the
 * stored rule is a plain screened pattern every reader enforces. An unknown preset is left for
 * the checks to refuse by name. Only a rule that is new or changed against `before` (the stored
 * fields, on a revision) is compiled: a stored rule rides along as it is, so a revision that
 * touches something else never rewrites it, even after a preset's pattern has changed.
 */
function compilePatternPresets(
  fields: readonly FieldDefinition[],
  before?: readonly FieldDefinition[],
): FieldDefinition[] {
  const rules = (
    v: FieldValidations | undefined,
    was: FieldValidations | undefined,
  ): FieldValidations | undefined => {
    const preset = v?.regexp?.preset;
    if (!v || !isPatternPreset(preset)) return v;
    if (was?.regexp && sameJson(v.regexp, was.regexp)) return v;
    const compiled = presetRegexp(preset);
    return sameJson(v.regexp, compiled) ? v : { ...v, regexp: compiled };
  };
  // Each level is rebuilt only when something under it changed, as withoutBlankGuidance does.
  const list = (
    defs: readonly FieldDefinition[] | undefined,
    was: readonly FieldDefinition[] | undefined,
  ) => {
    const next = defs && compilePatternPresets(defs, was);
    return next?.some((g, i) => g !== defs?.[i]) ? next : defs;
  };
  return fields.map((f) => {
    const old = before?.find((b) => b.apiId === f.apiId);
    const validations = rules(f.validations, old?.validations);
    const nested = list(f.fields, old?.fields);
    const itemRules = rules(f.items?.validations, old?.items?.validations);
    const itemFields = list(f.items?.fields, old?.items?.fields);
    const variants = f.items?.variants?.map((v) => {
      const wasVariant = old?.items?.variants?.find((w) => w.apiId === v.apiId);
      const vf = list(v.fields, wasVariant?.fields) ?? v.fields;
      return vf === v.fields ? v : { ...v, fields: vf };
    });
    const variantsChanged = variants?.some((v, i) => v !== f.items?.variants?.[i]) ?? false;
    const itemsChanged =
      itemRules !== f.items?.validations || itemFields !== f.items?.fields || variantsChanged;
    if (validations === f.validations && nested === f.fields && !itemsChanged) return f;
    return {
      ...f,
      ...(validations ? { validations } : {}),
      ...(nested ? { fields: nested } : {}),
      ...(f.items && itemsChanged
        ? {
            items: {
              ...f.items,
              ...(itemRules ? { validations: itemRules } : {}),
              ...(itemFields ? { fields: itemFields } : {}),
              ...(variantsChanged ? { variants } : {}),
            },
          }
        : {}),
    } as FieldDefinition;
  });
}

function assertFieldsValid(
  fields: readonly FieldDefinition[],
  displayField: string,
  previous: readonly FieldDefinition[] | undefined,
): void {
  const seen = assertFieldSetValid(fields, '', 0, previous, false);
  if (fields.length > 0 && !seen.has(displayField)) {
    throw new ValidationError([
      { field: 'displayField', message: `displayField "${displayField}" is not a defined field` },
    ]);
  }
}

/**
 * Checks one level of field definitions, recursing into components.
 *
 * `path` prefixes every message so an author editing a deep group is told which
 * field is wrong, not merely that something is. `depth` counts components
 * entered so far; 0 is the content type's own field list. `previous` is the
 * same level of the definition being revised, if any. `inList` says this level is part of an
 * Array's element (directly or through a component), which a `disable` rule cannot reach.
 */
function assertFieldSetValid(
  fields: readonly FieldDefinition[],
  path: string,
  depth: number,
  previous: readonly FieldDefinition[] | undefined,
  inList: boolean,
): Set<string> {
  const seen = new Set<string>();
  const at = (f: FieldDefinition) => (path ? `${path}.${f.apiId}` : f.apiId);

  for (const f of fields) {
    const where = at(f);
    if (!isValidApiId(f.apiId)) {
      throw new ValidationError([{ field: where, message: `Invalid field apiId "${f.apiId}"` }]);
    }
    if (seen.has(f.apiId)) {
      throw new ConflictError(`Duplicate field apiId "${where}"`);
    }
    seen.add(f.apiId);
    const before = previous?.find((p) => p.apiId === f.apiId);
    assertGuidanceValid(f, where, before);
    assertRulesValid(f, fields, where, before, inList);
    assertSettingsValid(f, where, before);
    for (const rx of [f.validations?.regexp, f.items?.validations?.regexp]) {
      if (!rx) continue;
      if (typeof rx.pattern !== 'string') {
        throw new ValidationError([
          { field: where, message: 'validations.regexp needs a pattern or a preset' },
        ]);
      }
      const reason = unsafeRegexReason(rx.pattern, rx.flags);
      if (reason) throw new ValidationError([{ field: where, message: reason }]);
    }
    // Refuse `unique` where it cannot mean anything, rather than accepting the
    // declaration and quietly never enforcing it.
    if (f.unique && !UNIQUE_FIELD_TYPES.includes(f.type)) {
      throw new ValidationError([{ field: where, message: `A ${f.type} field cannot be unique` }]);
    }

    if (depth > 0) assertNestedFieldAllowed(f, where);
    if (f.type === 'Seo' && [...fields].filter((g) => g.type === 'Seo').length > 1) {
      // The sitemap and every client read a page's SEO from its one Seo field.
      throw new ValidationError([
        { field: where, message: 'A content type has at most one Seo field' },
      ]);
    }

    const isComponent = f.type === 'Component' || f.items?.type === 'Component';
    if (!isComponent) {
      // Declaring a shape on a field that is not a component means the author
      // expected nesting they will not get. Checked on every place it could be
      // written, so none is silently dropped.
      if (f.fields || f.items?.fields || f.items?.variants) {
        throw new ValidationError([
          { field: where, message: `A ${f.type} field cannot define nested fields` },
        ]);
      }
      continue;
    }

    const nested = f.type === 'Component' ? f.fields : f.items?.fields;
    if (f.items?.variants === undefined && (!nested || nested.length === 0)) {
      throw new ValidationError([
        { field: where, message: 'A component must define at least one field' },
      ]);
    }
    if (depth + 1 > MAX_COMPONENT_DEPTH) {
      throw new ValidationError([
        {
          field: where,
          message: `Components may nest ${MAX_COMPONENT_DEPTH} deep at most. Model anything deeper as its own content type and link to it.`,
        },
      ]);
    }
    if (f.items?.variants !== undefined) {
      assertVariantsValid(f, where, depth, before);
      continue;
    }
    const nestedBefore = before?.type === 'Component' ? before.fields : before?.items?.fields;
    assertFieldSetValid(nested ?? [], where, depth + 1, nestedBefore, inList || f.type === 'Array');
  }
  return seen;
}

/**
 * A blocks field's variants: at least one, each a legal apiId used once, each
 * a component in its own right. A variant's fields sit one level deeper, so
 * they obey the nested rules and count toward the depth cap like any
 * component's.
 *
 * A field declares `items.fields` or `items.variants`, never both: with both,
 * an element without a `_type` would have two plausible shapes, and which one
 * wins would be a guess the author never made.
 */
function assertVariantsValid(
  f: FieldDefinition,
  where: string,
  depth: number,
  before: FieldDefinition | undefined,
): void {
  const fail = (message: string, at = where): never => {
    throw new ValidationError([{ field: at, message }]);
  };
  if (f.type !== 'Array') {
    fail(
      'Only an Array of Component can declare variants. For a single block, use an Array with validations.size.max of 1.',
    );
  }
  if (f.items?.fields !== undefined) {
    fail('Declare items.fields or items.variants, not both');
  }
  const variants = f.items?.variants;
  if (!Array.isArray(variants) || variants.length === 0) {
    fail('A blocks field must define at least one variant');
  }
  const seen = new Set<string>();
  for (const v of variants as readonly ComponentVariant[]) {
    const apiId = (v as { apiId?: unknown } | null)?.apiId;
    if (typeof apiId !== 'string' || !isValidApiId(apiId)) {
      fail(`Invalid variant apiId "${String(apiId)}"`);
    }
    const at = `${where}[${apiId}]`;
    if (seen.has(apiId as string)) fail(`Duplicate variant apiId "${apiId}"`, at);
    seen.add(apiId as string);
    if (typeof v.name !== 'string' || v.name.trim() === '') fail('A variant needs a name', at);
    if (!Array.isArray(v.fields) || v.fields.length === 0) {
      fail('A variant must define at least one field', at);
    }
    const variantBefore = before?.items?.variants?.find((b) => b.apiId === apiId);
    assertFieldSetValid(v.fields, at, depth + 1, variantBefore?.fields, true);
  }
}

/**
 * The guidance a field carries for whoever fills it: `help`, `placeholder` and
 * `description` as capped plain text, usable `in` options, and a custom message
 * only for a rule the field declares. `before` is the field as currently
 * stored, when this is a revision.
 *
 * Options were not checked before guidance existed, so a stored list may hold
 * a duplicate or a stray `true`. Those are refused only when the revision adds
 * them: refusing what is already stored would leave the type impossible to
 * edit at all.
 */
function assertGuidanceValid(
  f: FieldDefinition,
  where: string,
  before: FieldDefinition | undefined,
): void {
  const fail = (message: string): never => {
    throw new ValidationError([{ field: where, message }]);
  };
  for (const key of ['help', 'placeholder', 'description'] as const) {
    const text: unknown = f[key];
    // Unchanged from what is stored passes, whatever it is (main once stored anything).
    if (text === undefined || text === null || sameJson(text, before?.[key])) continue;
    if (typeof text !== 'string') fail(`${key} must be a string`);
    else if (text.length > FIELD_GUIDANCE_LIMITS[key]) {
      fail(`${key} must be at most ${FIELD_GUIDANCE_LIMITS[key]} characters`);
    }
  }
  assertValidationsGuidanceValid(f.validations, before?.validations, where, fail);
  // Per-element `in` is accepted (and kept) but not yet enforced on an Array's
  // elements; a message would explain an error that never happens, so it is refused.
  const itemMessages: unknown = f.items?.validations?.messages;
  if (itemMessages !== undefined && !sameJson(itemMessages, before?.items?.validations?.messages)) {
    fail(`${where} items: validations.messages are not enforced on an Array's elements`);
  }
  assertOptionsValid(
    f.items?.validations?.in,
    before?.items?.validations?.in,
    `${where} items`,
    fail,
  );
}

/**
 * A field's `rules`: a list of at most {@link MAX_FIELD_RULES}, each usable (`ruleProblem`)
 * against the field's siblings as revised. Rules stored as they stand are let through, except
 * that a revision cannot remove the sibling a kept rule reads: the rule would then read nothing,
 * and `empty` would match for good.
 */
function assertRulesValid(
  f: FieldDefinition,
  siblings: readonly FieldDefinition[],
  where: string,
  before: FieldDefinition | undefined,
  inList: boolean,
): void {
  const rules: unknown = f.rules;
  if (rules === undefined) return;
  const fail = (message: string): never => {
    throw new ValidationError([{ field: where, message }]);
  };
  if (sameJson(rules, before?.rules)) {
    for (const rule of Array.isArray(rules) ? rules : []) {
      const path: unknown = (rule as { when?: { field?: unknown } } | null)?.when?.field;
      if (typeof path === 'string' && !ruleTarget(siblings, path)) {
        fail(`a rule reads "${path}", which this change removes; change the rule first`);
      }
    }
    return;
  }
  if (!Array.isArray(rules)) fail('rules must be a list');
  if ((rules as unknown[]).length > MAX_FIELD_RULES) {
    fail(`a field has at most ${MAX_FIELD_RULES} rules`);
  }
  for (const rule of rules as unknown[]) {
    const problem = ruleProblem(rule, f, siblings, inList);
    if (problem) fail(problem);
  }
}

/** Most MIME types an asset link lists. */
const MAX_ASSET_MIME_TYPES = 50;
/** `image/png`, `application/vnd.ms-excel`, or a family, `image/*`. */
const MIME_TYPE = /^[a-z]+\/(?:\*|[a-z0-9][a-z0-9.+-]*)$/;

/** Why a `validations.assetMimeTypes` list is unusable on `f`, or null. */
function assetMimeTypesProblem(f: FieldDefinition, list: unknown): string | null {
  const assetLink =
    (f.type === 'Link' && f.linkType === 'Asset') ||
    (f.type === 'Array' && f.items?.type === 'Link' && f.items.linkType === 'Asset');
  if (!assetLink) return 'validations.assetMimeTypes applies to an asset link';
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_ASSET_MIME_TYPES) {
    return `validations.assetMimeTypes lists 1 to ${MAX_ASSET_MIME_TYPES} MIME types`;
  }
  const bad = list.find((m) => typeof m !== 'string' || m.length > 100 || !MIME_TYPE.test(m));
  return bad === undefined
    ? null
    : `${JSON.stringify(bad)} is not a MIME type (image/png) or family (image/*)`;
}

/** Why a `validations.dateRange` is unusable for a Date of `format`, or null. */
function dateRangeProblem(range: unknown, format: DateFormat | undefined): string | null {
  if (typeof range !== 'object' || range === null || Array.isArray(range)) {
    return 'validations.dateRange is { min?, max? }';
  }
  const { min, max } = range as { min?: unknown; max?: unknown };
  if (min === undefined && max === undefined) return 'validations.dateRange needs a min or a max';
  const written = format ? `${format} (${DATE_FORMAT_EXAMPLES[format]})` : 'ISO-8601 date';
  const key = (v: unknown) => (typeof v === 'string' ? dateSortKey(v, format) : null);
  for (const [name, v] of [
    ['min', min],
    ['max', max],
  ] as const) {
    if (v !== undefined && key(v) === null) return `dateRange.${name} must be a ${written}`;
  }
  const lo = key(min);
  const hi = key(max);
  return lo !== null && hi !== null && lo > hi ? 'dateRange.min is later than dateRange.max' : null;
}

/**
 * The settings a field's type gives meaning to: a Date's `format` and `dateRange`, an Array's
 * element `type` and `format`, an asset link's `assetMimeTypes`, a named pattern `preset`. Each is
 * refused where it would mean nothing, and checked only when new against the stored field.
 */
function assertSettingsValid(
  f: FieldDefinition,
  where: string,
  before: FieldDefinition | undefined,
): void {
  const fail = (message: string): never => {
    throw new ValidationError([{ field: where, message }]);
  };
  const changed = (a: unknown, b: unknown) => !sameJson(a, b);
  const formats = DATE_FORMATS.join(', ');
  if (f.format !== undefined && changed(f.format, before?.format)) {
    if (f.type !== 'Date') fail(`A ${f.type} field has no format; only a Date does`);
    if (!(DATE_FORMATS as readonly unknown[]).includes(f.format))
      fail(`format is one of: ${formats}`);
  }
  const items = f.items;
  if (items && changed(items.type, before?.items?.type)) {
    if (!(ARRAY_ITEM_TYPES as readonly unknown[]).includes(items.type)) {
      fail(`items.type is one of: ${ARRAY_ITEM_TYPES.join(', ')}`);
    }
  }
  if (items?.format !== undefined && changed(items.format, before?.items?.format)) {
    if (items.type !== 'Date') fail('Only a list of Dates has items.format');
    if (!(DATE_FORMATS as readonly unknown[]).includes(items.format)) {
      fail(`items.format is one of: ${formats}`);
    }
  }
  const range: unknown = f.validations?.dateRange;
  if (
    range !== undefined &&
    (changed(range, before?.validations?.dateRange) || changed(f.format, before?.format))
  ) {
    if (f.type !== 'Date') fail('validations.dateRange applies to a Date field');
    const problem = dateRangeProblem(range, f.format);
    if (problem) fail(problem);
  }
  const mimes: unknown = f.validations?.assetMimeTypes;
  if (mimes !== undefined && changed(mimes, before?.validations?.assetMimeTypes)) {
    const problem = assetMimeTypesProblem(f, mimes);
    if (problem) fail(problem);
  }
  for (const [rx, was] of [
    [f.validations?.regexp, before?.validations?.regexp],
    [f.items?.validations?.regexp, before?.items?.validations?.regexp],
  ] as const) {
    const preset: unknown = rx?.preset;
    if (preset !== undefined && !isPatternPreset(preset) && changed(preset, was?.preset)) {
      fail(
        `Unknown pattern preset ${JSON.stringify(preset)} (one of: ${Object.keys(PATTERN_PRESETS).join(', ')})`,
      );
    }
  }
}

/** Equal as stored JSON: for the scalars and small objects a revision may carry over unchanged. */
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function assertValidationsGuidanceValid(
  v: FieldValidations | undefined,
  before: FieldValidations | undefined,
  label: string,
  fail: (message: string) => never,
): void {
  if (v === undefined) return;
  assertOptionsValid(v.in, before?.in, label, fail);
  const messages: unknown = v.messages;
  if (messages === undefined || sameJson(messages, before?.messages)) return;
  if (typeof messages !== 'object' || messages === null || Array.isArray(messages)) {
    fail(`${label}: validations.messages maps a rule to its message`);
  }
  const stored: unknown = before?.messages;
  for (const [rule, message] of Object.entries(messages as Record<string, unknown>)) {
    // A message stored as it stands is not new, even where it explains nothing.
    if (
      typeof stored === 'object' &&
      stored !== null &&
      sameJson(message, (stored as Record<string, unknown>)[rule])
    ) {
      continue;
    }
    if (!(MESSAGE_RULES as readonly string[]).includes(rule)) {
      fail(`${label}: no message for "${rule}" (one of: ${MESSAGE_RULES.join(', ')})`);
    }
    if (v[rule as MessageRule] === undefined) {
      fail(`${label}: a message for "${rule}" needs the ${rule} rule it explains`);
    }
    if (typeof message !== 'string' || message.trim() === '') {
      fail(`${label}: the "${rule}" message must be non-empty text`);
    } else if (message.length > FIELD_GUIDANCE_LIMITS.message) {
      fail(`${label}: a message is at most ${FIELD_GUIDANCE_LIMITS.message} characters`);
    }
  }
}

/**
 * Each option usable and listed once, by its text (`'1'` and `1` clash).
 * An option that breaks either rule is let through when the stored list
 * already holds it at least as many times: it is not new. Options are
 * compared by type, text and label, so an object's key order never matters.
 */
function assertOptionsValid(
  options: unknown,
  before: unknown,
  label: string,
  fail: (message: string) => never,
): void {
  if (options === undefined) return;
  if (!Array.isArray(options)) {
    if (!sameJson(options, before)) fail(`${label}: validations.in must be a list`);
    return;
  }
  const identity = (o: unknown): string => {
    const labelled = typeof o === 'object' && o !== null;
    const value = labelled ? (o as { value?: unknown }).value : o;
    const optionLabel = labelled ? (o as { label?: unknown }).label : undefined;
    return JSON.stringify([typeof value, String(value), optionLabel ?? null]);
  };
  const stored = Array.isArray(before) ? before : [];
  const count = (list: readonly unknown[], o: unknown) =>
    list.filter((x) => identity(x) === identity(o)).length;
  const seen = new Set<string>();
  for (const option of options as unknown[]) {
    const problem =
      optionProblem(option) ??
      (seen.has(optionKey(option as FieldOption))
        ? `option ${JSON.stringify(optionValue(option as FieldOption))} is listed twice`
        : null);
    if (problem === null) seen.add(optionKey(option as FieldOption));
    else if (count(options, option) > count(stored, option)) fail(`${label}: ${problem}`);
  }
}

/**
 * Guidance that is blank (or a stored null) says nothing, so it is left out: a whitespace-only
 * `description` would otherwise win over a real `help` wherever one stands in
 * for the other. Nested definitions are cleaned the same way.
 */
function withoutBlankGuidance(f: FieldDefinition): FieldDefinition {
  const blank = (t: unknown) => t === null || (typeof t === 'string' && t.trim() === '');
  // Each level is rebuilt only when something under it changed: callers compare definitions by
  // reference (a block's variant fields, say), and the common case changes nothing.
  const list = (fields: readonly FieldDefinition[] | undefined) => {
    const next = fields?.map(withoutBlankGuidance);
    return next?.some((g, i) => g !== fields?.[i]) ? next : fields;
  };
  const fields = list(f.fields);
  const itemFields = list(f.items?.fields);
  const variants = f.items?.variants?.map((v) => {
    const vf = list(v.fields) ?? v.fields;
    return vf === v.fields ? v : { ...v, fields: vf };
  });
  const variantsChanged = variants?.some((v, i) => v !== f.items?.variants?.[i]) ?? false;
  const keys = (['help', 'placeholder', 'description'] as const).filter((k) => blank(f[k]));
  if (
    keys.length === 0 &&
    fields === f.fields &&
    itemFields === f.items?.fields &&
    !variantsChanged
  ) {
    return f;
  }
  const out: Record<string, unknown> = { ...f };
  for (const k of keys) delete out[k];
  if (fields !== f.fields) out.fields = fields;
  if (f.items && (itemFields !== f.items.fields || variantsChanged)) {
    out.items = {
      ...f.items,
      ...(itemFields ? { fields: itemFields } : {}),
      ...(variantsChanged ? { variants } : {}),
    };
  }
  return out as unknown as FieldDefinition;
}

/**
 * Field definitions written before guidance was checked (an environment
 * snapshot, a clone), made acceptable to {@link defineContentType} without
 * failing on what the source was allowed to store, at every depth:
 *
 * - each `in` list keeps its usable options, once each (see `normalizeOptions`),
 *   and goes when none is left, since an empty list would refuse every value;
 * - guidance that is not text, or over its cap, goes;
 * - a message goes unless it is text within its cap for a rule the field
 *   declares; an Array element's messages go, as nothing enforces them;
 * - each unusable rule goes (one reading a sibling that is not there, say), and
 *   `rules` with it when none is left;
 * - a Date `format`, `dateRange` or asset `assetMimeTypes` the field cannot use
 *   goes, and an unknown pattern preset leaves its pattern behind.
 */
export function normalizeLegacyFields(
  fields: readonly FieldDefinition[],
  inList = false,
): FieldDefinition[] {
  const rules = (
    v: FieldValidations | undefined,
    type: FieldDefinition['type'],
    element: boolean,
  ): FieldValidations | undefined => {
    if (v === undefined || v === null || typeof v !== 'object') return undefined;
    const { in: options, messages, ...rest } = v;
    const kept: FieldValidations = { ...rest };
    if (options !== undefined) {
      const usable = normalizeOptions(options, type);
      if (usable.length > 0) kept.in = usable;
    }
    if (!element && typeof messages === 'object' && messages !== null) {
      const usable = Object.fromEntries(
        MESSAGE_RULES.filter((rule) => kept[rule] !== undefined).flatMap((rule) => {
          const text: unknown = (messages as Record<string, unknown>)[rule];
          return typeof text === 'string' &&
            text.trim() !== '' &&
            text.length <= FIELD_GUIDANCE_LIMITS.message
            ? [[rule, text]]
            : [];
        }),
      );
      if (Object.keys(usable).length > 0) kept.messages = usable;
    }
    return Object.keys(kept).length > 0 ? kept : undefined;
  };
  const guidance = (f: FieldDefinition) => {
    const out: { help?: string; placeholder?: string; description?: string } = {};
    for (const key of ['help', 'placeholder', 'description'] as const) {
      const text: unknown = f[key];
      if (typeof text === 'string' && text.length <= FIELD_GUIDANCE_LIMITS[key]) out[key] = text;
    }
    return out;
  };
  const usableRules = (f: FieldDefinition) =>
    Array.isArray(f.rules)
      ? f.rules
          .filter((rule) => ruleProblem(rule, f, fields, inList) === null)
          .slice(0, MAX_FIELD_RULES)
      : [];
  return fields.map((f) => {
    const { help: _h, placeholder: _p, description: _d, validations: _v, rules: _r, ...rest } = f;
    const kept = usableRules(f);
    const validations = usableSettings(f, rules(f.validations, f.type, false));
    const itemRules = presetKnown(rules(f.items?.validations, f.items?.type ?? 'Symbol', true));
    const { validations: _iv, format: itemFormat, ...itemRest } = f.items ?? {};
    const items = f.items && {
      ...(itemRest as NonNullable<FieldDefinition['items']>),
      ...(f.items.type === 'Date' && (DATE_FORMATS as readonly unknown[]).includes(itemFormat)
        ? { format: itemFormat }
        : {}),
      ...(itemRules ? { validations: itemRules } : {}),
      ...(f.items.fields ? { fields: normalizeLegacyFields(f.items.fields, true) } : {}),
      ...(f.items.variants
        ? {
            variants: f.items.variants.map((v) => ({
              ...v,
              fields: normalizeLegacyFields(v.fields, true),
            })),
          }
        : {}),
    };
    const { format, ...unformatted } = rest;
    return {
      ...unformatted,
      ...(f.type === 'Date' && (DATE_FORMATS as readonly unknown[]).includes(format)
        ? { format }
        : {}),
      ...guidance(f),
      ...(validations ? { validations } : {}),
      ...(kept.length > 0 ? { rules: kept } : {}),
      ...(f.fields ? { fields: normalizeLegacyFields(f.fields, inList) } : {}),
      ...(items ? { items } : {}),
    };
  });
}

/** A rule naming a preset this release does not know keeps its pattern and loses the name. */
function presetKnown(v: FieldValidations | undefined): FieldValidations | undefined {
  const rx = v?.regexp;
  if (!v || !rx || rx.preset === undefined || isPatternPreset(rx.preset)) return v;
  const { preset: _p, ...plain } = rx;
  const { regexp: _r, ...rest } = v;
  return typeof plain.pattern === 'string' ? { ...v, regexp: plain } : rest;
}

/**
 * A field's validations without the settings its type cannot use (see `assertSettingsValid`): a
 * date range that does not read in the field's format, MIME types on anything but an asset link,
 * an unknown preset.
 */
function usableSettings(
  f: FieldDefinition,
  v: FieldValidations | undefined,
): FieldValidations | undefined {
  const known = presetKnown(v);
  if (!known) return known;
  const format = (DATE_FORMATS as readonly unknown[]).includes(f.format) ? f.format : undefined;
  const { dateRange, assetMimeTypes, ...rest } = known;
  const out: FieldValidations = {
    ...rest,
    ...(dateRange !== undefined && f.type === 'Date' && dateRangeProblem(dateRange, format) === null
      ? { dateRange }
      : {}),
    ...(assetMimeTypes !== undefined && assetMimeTypesProblem(f, assetMimeTypes) === null
      ? { assetMimeTypes }
      : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The attributes a nested field may not carry. See COMPONENT_NESTED_RULES. */
function assertNestedFieldAllowed(f: FieldDefinition, where: string): void {
  if (f.localized) {
    throw new ValidationError([
      {
        field: where,
        message:
          'A field inside a component cannot be localized on its own; ' +
          'localize the component field that holds it.',
      },
    ]);
  }
  if (f.unique) {
    throw new ValidationError([
      { field: where, message: 'A field inside a component cannot be unique' },
    ]);
  }
  if (f.type === 'Slug') {
    throw new ValidationError([
      {
        field: where,
        message:
          'A Slug cannot live inside a component: slugs are normalized from the ' +
          "entry's top-level fields, so a nested one would never be normalized.",
      },
    ]);
  }
  if (f.type === 'Seo') {
    throw new ValidationError([
      {
        field: where,
        message:
          'A Seo field cannot live inside a component: it describes the whole page, and the ' +
          "sitemap reads it from the entry's top-level fields.",
      },
    ]);
  }
}

// --- URL pattern ------------------------------------------------------------

/** Longest URL pattern. */
export const MAX_URL_PATTERN_LENGTH = 512;

const URL_PLACEHOLDER = /\{([^{}]*)\}/g;

/**
 * Checks a content type's URL pattern against its fields, or throws `ValidationError`. A pattern
 * is a site path starting with `/` (no query or fragment) whose `{…}` placeholders are `{id}` (the
 * entry id), `{locale}`, or the apiId of one of the type's own Slug fields: slugs are the only
 * values normalized to be safe in a URL.
 */
export function checkUrlPattern(input: string, fields: readonly FieldDefinition[]): string {
  const refuse = (message: string): never => {
    throw new ValidationError([{ field: 'urlPattern', message }]);
  };
  const pattern = input.trim();
  if (!pattern.startsWith('/') || pattern.startsWith('//')) {
    refuse('A URL pattern is a path starting with /, e.g. /blog/{slug}');
  }
  if (pattern.length > MAX_URL_PATTERN_LENGTH) {
    refuse(`A URL pattern is at most ${MAX_URL_PATTERN_LENGTH} characters`);
  }
  if (/[\s?#[\]\\]/.test(pattern)) {
    refuse('A URL pattern cannot hold spaces, ?, #, [, ] or \\');
  }
  const slugs = new Set(fields.filter((f) => f.type === 'Slug').map((f) => f.apiId));
  if (
    pattern.replace(URL_PLACEHOLDER, '').includes('{') ||
    pattern.replace(URL_PLACEHOLDER, '').includes('}')
  ) {
    refuse('A placeholder is written {name}');
  }
  for (const m of pattern.matchAll(URL_PLACEHOLDER)) {
    const name = m[1] ?? '';
    if (name === 'id' || name === 'locale' || slugs.has(name)) continue;
    refuse(`{${name}} is not {id}, {locale} or one of this type's Slug fields`);
  }
  return pattern;
}

/** The Slug fields a URL pattern names. */
export const urlPatternSlugFields = (pattern: string): string[] =>
  [...pattern.matchAll(URL_PLACEHOLDER)]
    .map((m) => m[1] ?? '')
    .filter((name) => name !== 'id' && name !== 'locale');

/**
 * An entry's path on the site in one locale, from its type's URL pattern, or null when a slug the
 * pattern names has no value in that locale. `fields` are the entry's (locale → value per field).
 */
export function urlPath(
  pattern: string,
  entry: {
    readonly id: string;
    readonly fields: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  },
  locale: string,
): string | null {
  let missing = false;
  const path = pattern.replace(URL_PLACEHOLDER, (_whole, name: string) => {
    if (name === 'id') return encodeURIComponent(entry.id);
    if (name === 'locale') return encodeURIComponent(locale);
    const value = entry.fields[name]?.[locale];
    if (typeof value !== 'string' || value === '') {
      missing = true;
      return '';
    }
    return encodeURIComponent(value);
  });
  return missing ? null : path;
}

/** A field of another content type that may link to a given one (`validations.linkContentTypes`). */
export interface LinkingField {
  readonly contentType: string;
  /** The field's path, through components and blocks: `body.cta.target`. */
  readonly field: string;
}

/**
 * The fields of `types` other than `apiId` itself whose links are restricted to it, at any depth:
 * a Link or list of links (`validations` or `items.validations`), inside a component, a repeater
 * or a blocks variant (named in the path). A type's links to itself don't count: they go with it.
 */
export function fieldsLinkingTo(
  types: readonly Pick<ContentType, 'apiId' | 'fields'>[],
  apiId: string,
): LinkingField[] {
  const found: LinkingField[] = [];
  const walk = (contentType: string, fields: readonly FieldDefinition[], path: string) => {
    for (const f of fields) {
      const at = path ? `${path}.${f.apiId}` : f.apiId;
      const targets = [
        ...(f.validations?.linkContentTypes ?? []),
        ...(f.items?.validations?.linkContentTypes ?? []),
      ];
      if (targets.includes(apiId)) found.push({ contentType, field: at });
      if (f.fields) walk(contentType, f.fields, at);
      if (f.items?.fields) walk(contentType, f.items.fields, at);
      for (const v of f.items?.variants ?? []) walk(contentType, v.fields, `${at}.${v.apiId}`);
    }
  };
  for (const t of types) if (t.apiId !== apiId) walk(t.apiId, t.fields, '');
  return found;
}
