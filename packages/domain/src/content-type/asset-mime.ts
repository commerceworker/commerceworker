import type { EntryFields } from '../types';
import type { ContentType } from './content-type';
import { type FieldDefinition, nestedFieldsFor, ruleMessage } from './field';

/**
 * `validations.assetMimeTypes`: which asset files a link may point at. The rule lives on the
 * field, but the MIME type lives on the asset, so the domain says which links to look up and how
 * to judge each one, and the use-case that saves the entry reads the assets.
 */

/** One linked asset a field's MIME rule applies to. */
export interface AssetMimeCheck {
  /** Where the link sits, as validation reports it: `hero.image`, `gallery[2]`. */
  readonly field: string;
  readonly locale: string;
  readonly assetId: string;
  readonly allowed: readonly string[];
  /** The field's custom message for the rule, if any. */
  readonly message?: string;
}

/** Whether a MIME type is one of `allowed`, exact or by family (`image/*`). */
export function mimeTypeAllowed(mime: string, allowed: readonly string[]): boolean {
  const type = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  return allowed.some((a) =>
    a.endsWith('/*') ? type.startsWith(a.slice(0, -1)) : type === a.toLowerCase(),
  );
}

/** Every asset link in `fields` that falls under a MIME rule, at any depth and in every locale. */
export function assetMimeChecks(contentType: ContentType, fields: EntryFields): AssetMimeCheck[] {
  const out: AssetMimeCheck[] = [];
  const visit = (f: FieldDefinition, value: unknown, path: string, locale: string) => {
    const allowed = f.validations?.assetMimeTypes;
    const message = ruleMessage(f.validations, 'assetMimeTypes');
    const add = (link: unknown, at: string) => {
      const l = link as { id?: unknown; linkType?: unknown } | null;
      if (Array.isArray(allowed) && allowed.length > 0 && typeof l?.id === 'string') {
        if (l.linkType === 'Asset') {
          out.push({ field: at, locale, assetId: l.id, allowed, ...(message ? { message } : {}) });
        }
      }
    };
    if (f.type === 'Link') add(value, path);
    else if (f.type === 'Array' && Array.isArray(value)) {
      value.forEach((item, i) => {
        if (f.items?.type === 'Link') add(item, `${path}[${i}]`);
        else if (f.items?.type === 'Component') {
          visitComponent(nestedFieldsFor(f, item), item, `${path}[${i}]`, locale);
        }
      });
    } else if (f.type === 'Component') visitComponent(f.fields, value, path, locale);
  };
  const visitComponent = (
    nested: readonly FieldDefinition[] | undefined,
    value: unknown,
    path: string,
    locale: string,
  ) => {
    if (!nested || typeof value !== 'object' || value === null || Array.isArray(value)) return;
    for (const n of nested) {
      visit(n, (value as Record<string, unknown>)[n.apiId], `${path}.${n.apiId}`, locale);
    }
  };
  for (const f of contentType.fields) {
    for (const [locale, value] of Object.entries(fields[f.apiId] ?? {})) {
      visit(f, value, f.apiId, locale);
    }
  }
  return out;
}
