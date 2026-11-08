import type { ContentType } from '../content-type/content-type';
import { type FieldDefinition, type LinkType, nestedFieldsFor } from '../content-type/field';
import { extractRichTextTargets } from '../rich-text/rich-text';
import { SEO_FIELDS } from '../seo/seo';
import type { EntryFields } from '../types';

/**
 * A materialized reference edge: entry `fromEntryId` links to `toId` (an entry
 * or asset) via field `fromField`. These edges back referential integrity,
 * delivery link resolution, and reverse-lookup cache invalidation.
 */
export interface ReferenceEdge {
  readonly fromEntryId: string;
  readonly fromField: string;
  readonly toId: string;
  readonly toType: LinkType;
}

interface LinkValue {
  id: string;
  linkType: LinkType;
}

function asLink(value: unknown): LinkValue | null {
  const l = value as { id?: unknown; linkType?: unknown };
  if (typeof l?.id === 'string' && (l.linkType === 'Entry' || l.linkType === 'Asset')) {
    return { id: l.id, linkType: l.linkType };
  }
  return null;
}

/**
 * Walks an entry's field values and extracts every link edge it contains,
 * across all locales, deduplicated by (field, target). Pure — no I/O.
 */
export function extractReferences(
  fromEntryId: string,
  fields: EntryFields,
  contentType: ContentType,
): ReferenceEdge[] {
  const edges = new Map<string, ReferenceEdge>();
  const add = (fromField: string, link: LinkValue) => {
    const key = `${fromField}::${link.linkType}::${link.id}`;
    edges.set(key, { fromEntryId, fromField, toId: link.id, toType: link.linkType });
  };

  for (const field of contentType.fields) {
    const localized = fields[field.apiId];
    if (!localized) continue;
    for (const value of Object.values(localized)) {
      collect(field, value, (link) => add(field.apiId, link));
    }
  }
  return [...edges.values()];
}

/**
 * Walks one field value and reports every link inside it, however deep.
 *
 * Edges are attributed to the **top-level** field, not the nested path that
 * produced them. An edge answers "does anything still link to this?" and "whose
 * caches does publishing this invalidate?"; neither question gets a better
 * answer from knowing it was the third card's image, and pathing them would
 * multiply near-identical rows for no gain.
 */
function collect(field: FieldDefinition, value: unknown, add: (link: LinkValue) => void): void {
  switch (field.type) {
    case 'Link': {
      const link = asLink(value);
      if (link) add(link);
      break;
    }
    case 'RichText':
      // Embedded/linked entries and assets inside the document body count as
      // references too — so integrity and reverse-lookup cover rich text.
      for (const target of extractRichTextTargets(value)) add(target);
      break;
    case 'Component':
      collectFromComponent(field.fields, value, add);
      break;
    case 'Seo':
      // Its social image is an asset link like any other: integrity and purges cover it.
      collectFromComponent(SEO_FIELDS, value, add);
      break;
    case 'Array': {
      if (!Array.isArray(value)) break;
      for (const item of value) {
        if (field.items?.type === 'Link') {
          const link = asLink(item);
          if (link) add(link);
        } else if (field.items?.type === 'Component') {
          // A blocks element is read with the variant its `_type` names, so a
          // link inside the third block counts like any other.
          collectFromComponent(nestedFieldsFor(field, item), item, add);
        }
      }
      break;
    }
  }
}

function collectFromComponent(
  nested: readonly FieldDefinition[] | undefined,
  value: unknown,
  add: (link: LinkValue) => void,
): void {
  if (!nested || typeof value !== 'object' || value === null) return;
  const values = value as Record<string, unknown>;
  for (const f of nested) {
    const inner = values[f.apiId];
    if (inner !== undefined && inner !== null) collect(f, inner, add);
  }
}
