import {
  type ContentType,
  FIELD_GUIDANCE_LIMITS,
  type FieldDefinition,
  type FieldType,
  type FieldValidations,
  isValidApiId,
  type LinkType,
  MESSAGE_RULES,
  type MessageRule,
  normalizeOptions,
  UNIQUE_FIELD_TYPES,
  unsafeRegexReason,
} from '@commerceworker/domain';

/**
 * The content model half of a space export: content types and their fields, mapped onto this
 * platform's definitions. What has no equivalent is named in the findings, never dropped quietly.
 */

/** The export's loosely typed JSON, read defensively: it is anyone's file. */
export type Json = Record<string, unknown>;

export const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;
/** `thing.sys.id`, the way the export names everything. */
export const sysId = (v: unknown): string | undefined =>
  isObject(v) && isObject(v.sys) ? str(v.sys.id) : undefined;

/** The export's field types that have a direct counterpart here. */
const SCALAR_TYPES: Readonly<Record<string, FieldType>> = {
  Symbol: 'Symbol',
  Text: 'Text',
  RichText: 'RichText',
  Integer: 'Integer',
  Number: 'Number',
  Boolean: 'Boolean',
  Date: 'Date',
  Location: 'Location',
  // An arbitrary JSON object either way; only the name differs.
  Object: 'JSON',
};

/** One content type as mapped: the definition, and how to read its entries' values. */
export interface MappedContentType {
  readonly sourceId: string;
  readonly contentType: ContentType;
  /** Mapped field apiId → its id in the export (they differ only when the export's isn't legal here). */
  readonly sourceFieldIds: ReadonlyMap<string, string>;
}

export interface ModelFindings {
  readonly unmappedFields: string[];
  readonly unmappedValidations: string[];
  readonly warnings: string[];
}

/**
 * Maps every content type. Ids the export uses that are not legal apiIds here (one starting with
 * a digit, a hyphen in it) are rewritten, and the rewrite is reported: entries and link
 * validations are read through the same table, so nothing else has to know.
 */
export function mapContentTypes(
  raw: readonly unknown[],
  findings: ModelFindings,
): Map<string, MappedContentType> {
  const typeIds = legalIds(
    raw.map((t) => sysId(t) ?? ''),
    (from, to) => findings.warnings.push(`Content type "${from}" is imported as "${to}"`),
  );
  const out = new Map<string, MappedContentType>();
  raw.forEach((t, index) => {
    const sourceId = sysId(t);
    const apiId = typeIds[index];
    if (!isObject(t) || !sourceId || !apiId) {
      findings.warnings.push(`Content type ${index + 1} has no sys.id and was skipped`);
      return;
    }
    out.set(sourceId, mapContentType(t, sourceId, apiId, typeIds, raw, findings));
  });
  return out;
}

function mapContentType(
  t: Json,
  sourceId: string,
  apiId: string,
  typeIds: readonly (string | undefined)[],
  raw: readonly unknown[],
  findings: ModelFindings,
): MappedContentType {
  const typeIdOf = new Map(raw.map((r, i) => [sysId(r) ?? '', typeIds[i]]));
  const rawFields = (Array.isArray(t.fields) ? t.fields : []).filter(
    // A deleted field is gone in the source too; it only lingers in the export until purged.
    (f): f is Json => isObject(f) && f.deleted !== true,
  );
  const fieldIds = legalIds(
    rawFields.map((f) => str(f.id) ?? ''),
    (from, to) => findings.warnings.push(`Field ${sourceId}.${from} is imported as "${to}"`),
  );

  const fields: FieldDefinition[] = [];
  const sourceFieldIds = new Map<string, string>();
  rawFields.forEach((f, index) => {
    const fieldId = str(f.id);
    const mappedId = fieldIds[index];
    if (!fieldId || !mappedId) {
      findings.unmappedFields.push(`${sourceId}.? (${String(f.type)}): the field has no id`);
      return;
    }
    const where = `${sourceId}.${fieldId}`;
    const mapped = mapField(f, mappedId, fields.length, where, typeIdOf, findings);
    if (!mapped) return;
    fields.push(mapped);
    sourceFieldIds.set(mappedId, fieldId);
  });

  // The export may name no display field (or one that was not mapped): the first text field
  // stands in, as an editor would see it in a list.
  const declared = str(t.displayField);
  const mappedDisplay = declared
    ? [...sourceFieldIds].find(([, from]) => from === declared)?.[0]
    : undefined;
  const displayField =
    mappedDisplay ?? fields.find((f) => f.type === 'Symbol')?.apiId ?? fields[0]?.apiId ?? 'title';

  const sys = isObject(t.sys) ? t.sys : {};
  return {
    sourceId,
    sourceFieldIds,
    contentType: {
      apiId,
      name: str(t.name) ?? apiId,
      displayField,
      fields,
      version: 1,
      // A content type the export never published imports as a draft, as it was.
      status: sys.publishedVersion !== undefined ? 'published' : 'draft',
    },
  };
}

function mapField(
  f: Json,
  apiId: string,
  position: number,
  where: string,
  typeIdOf: ReadonlyMap<string, string | undefined>,
  findings: ModelFindings,
): FieldDefinition | undefined {
  const type = String(f.type);
  const unmapped = (why: string) => {
    findings.unmappedFields.push(`${where} (${type}): ${why}`);
    return undefined;
  };

  let mappedType: FieldType;
  let linkType: LinkType | undefined;
  let items: FieldDefinition['items'];
  if (SCALAR_TYPES[type]) {
    mappedType = SCALAR_TYPES[type] as FieldType;
  } else if (type === 'Link') {
    linkType = linkTypeOf(f.linkType);
    if (!linkType) return unmapped(`links ${String(f.linkType)}, which has no equivalent here`);
    mappedType = 'Link';
  } else if (type === 'Array') {
    const rawItems = isObject(f.items) ? f.items : {};
    const itemType = String(rawItems.type);
    const itemValidations = mapValidations(
      rawItems.validations,
      itemType === 'Link' ? 'Link' : 'Symbol',
      `${where}[]`,
      typeIdOf,
      findings,
      // An element's rules are not enforced per element yet, so a message would explain nothing.
      false,
    );
    if (itemType === 'Symbol') {
      items = {
        type: 'Symbol',
        ...(itemValidations.rules ? { validations: itemValidations.rules } : {}),
      };
    } else if (itemType === 'Link') {
      const itemLink = linkTypeOf(rawItems.linkType);
      if (!itemLink) {
        return unmapped(
          `a list of ${String(rawItems.linkType)} links, which has no equivalent here`,
        );
      }
      items = {
        type: 'Link',
        linkType: itemLink,
        ...(itemValidations.rules ? { validations: itemValidations.rules } : {}),
      };
    } else {
      return unmapped(`a list of ${itemType}, which has no equivalent here`);
    }
    mappedType = 'Array';
  } else {
    // ResourceLink (a link into another space) and anything newer than this reader.
    return unmapped('no equivalent field type here');
  }

  const validations = mapValidations(f.validations, mappedType, where, typeIdOf, findings);
  const defaultValue = isObject(f.defaultValue) ? f.defaultValue : undefined;
  return {
    apiId,
    name: str(f.name) ?? apiId,
    type: mappedType,
    localized: f.localized === true,
    required: f.required === true,
    position,
    ...(validations.unique ? { unique: true } : {}),
    ...(validations.rules ? { validations: validations.rules } : {}),
    ...(linkType ? { linkType } : {}),
    ...(items ? { items } : {}),
    // Per locale in the export, which is one of the shapes a default takes here.
    ...(defaultValue ? { defaultValue } : {}),
  };
}

function linkTypeOf(value: unknown): LinkType | undefined {
  return value === 'Entry' || value === 'Asset' ? value : undefined;
}

/**
 * The export lists validations as one-rule objects, each with an optional custom message. The
 * rules this platform enforces the same way are kept, with their message; the rest (asset size and
 * dimensions, mime groups, date ranges, rich-text node and mark restrictions, …) are reported, since
 * an editor here would not be held to them.
 */
function mapValidations(
  raw: unknown,
  type: FieldType,
  where: string,
  typeIdOf: ReadonlyMap<string, string | undefined>,
  findings: ModelFindings,
  keepMessages = true,
): { rules?: FieldValidations; unique?: boolean } {
  if (!Array.isArray(raw) || raw.length === 0) return {};
  const rules: FieldValidations = {};
  const messages: { [R in MessageRule]?: string } = {};
  let unique = false;
  const report = (rule: string) => findings.unmappedValidations.push(`${where}: ${rule}`);

  for (const v of raw) {
    if (!isObject(v)) continue;
    const message = str(v.message)?.trim();
    for (const [rule, value] of Object.entries(v)) {
      if (rule === 'message') continue;
      if (rule === 'in' && Array.isArray(value)) {
        // Only usable values, once each: the export may hold anything.
        rules.in = normalizeOptions(value.filter((x) => typeof x !== 'object'));
      } else if (rule === 'size' && isObject(value)) {
        rules.size = numericRange(value);
      } else if (rule === 'range' && isObject(value)) {
        rules.range = numericRange(value);
      } else if (rule === 'regexp' && isObject(value) && typeof value.pattern === 'string') {
        const flags = typeof value.flags === 'string' ? value.flags : undefined;
        // A pattern this platform would refuse to run on every write (backtracking risk, a flag it
        // doesn't take) is reported instead of failing the whole content type.
        const unsafe = unsafeRegexReason(value.pattern, flags);
        if (unsafe) report(`regexp (${unsafe})`);
        else rules.regexp = { pattern: value.pattern, ...(flags ? { flags } : {}) };
      } else if (rule === 'linkContentType' && Array.isArray(value)) {
        const ids = value
          .map((id) => (typeof id === 'string' ? typeIdOf.get(id) : undefined))
          .filter((id): id is string => id !== undefined);
        if (ids.length > 0) rules.linkContentTypes = ids;
        if (ids.length < value.length) report('linkContentType (names a type not in the export)');
      } else if (rule === 'unique' && value === true) {
        if (UNIQUE_FIELD_TYPES.includes(type)) unique = true;
        else report(`unique (not supported on a ${type} field)`);
      } else {
        report(rule);
        continue;
      }
      if (!message) continue;
      // Kept with a rule that was kept and can carry one (a message for a reported rule would
      // explain nothing here); otherwise the wording is reported lost.
      if (!keepMessages || !isMessageRule(rule) || rules[rule] === undefined) {
        report(`${rule} custom message`);
      } else if (message.length > FIELD_GUIDANCE_LIMITS.message) {
        report(`${rule} custom message (longer than ${FIELD_GUIDANCE_LIMITS.message} characters)`);
      } else messages[rule] = message;
    }
  }
  if (Object.keys(messages).length > 0) rules.messages = messages;
  return { ...(Object.keys(rules).length ? { rules } : {}), ...(unique ? { unique } : {}) };
}

const isMessageRule = (rule: string): rule is MessageRule =>
  (MESSAGE_RULES as readonly string[]).includes(rule);

function numericRange(value: Json): { min?: number; max?: number } {
  return {
    ...(typeof value.min === 'number' ? { min: value.min } : {}),
    ...(typeof value.max === 'number' ? { max: value.max } : {}),
  };
}

/**
 * Each id made a legal apiId (letters, digits and underscores, starting with a letter, at most 64),
 * unique among its siblings. Unchanged where it already is one, which is the usual case.
 */
export function legalIds(
  ids: readonly string[],
  renamed: (from: string, to: string) => void,
): (string | undefined)[] {
  const taken = new Set(ids.filter(isValidApiId));
  const used = new Set<string>();
  return ids.map((id) => {
    if (!id) return undefined;
    if (isValidApiId(id) && !used.has(id)) {
      used.add(id);
      return id;
    }
    const base = /^[a-zA-Z]/.test(id) ? id : `t${id}`;
    const stem = base.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60);
    let candidate = stem;
    for (let n = 2; taken.has(candidate) || used.has(candidate); n++) {
      candidate = `${stem.slice(0, 58)}_${n}`;
    }
    used.add(candidate);
    renamed(id, candidate);
    return candidate;
  });
}
