import { ValidationError } from '../errors';
import { parseAbsoluteUrl } from '../rich-text/embed';
import type { FieldDefinition, FieldType } from './field';

/**
 * Where a type's entries are previewed on the customer's own frontend: a URL template filled per
 * entry when a preview link is minted (and, with live preview, the page the admin frames).
 * Editor-only: Delivery never serves it.
 */
export interface ContentTypePreview {
  /**
   * An absolute URL, e.g. `https://site.example/__preview?entry={id}#token={token}`. Placeholders:
   * `{id}`, `{token}` (required), `{locale}`, `{space}`, `{environment}` and `{field:<apiId>}`,
   * each filled URL-encoded. Only in the path, query or fragment: the origin is fixed, so the
   * admin can allow exactly that origin to be framed. `#token={token}` keeps the token out of the
   * frontend's request line, its logs and the Referer it sends.
   */
  readonly urlTemplate: string;
}

/** Longest preview URL template. */
export const MAX_PREVIEW_TEMPLATE_LENGTH = 1024;

/** The field types a `{field:<apiId>}` placeholder may name: single values that read in a URL. */
export const PREVIEW_FIELD_TYPES: readonly FieldType[] = [
  'Symbol',
  'Slug',
  'Integer',
  'Number',
  'Date',
];

const PLACEHOLDER = /\{([^{}]*)\}/g;
const NAMED = new Set(['id', 'token', 'locale', 'space', 'environment']);
const FIELD = /^field:([A-Za-z][A-Za-z0-9_]*)$/;
// Plain-http frontends are allowed only on the developer's own machine, on a local stack.
const LOOPBACK = new Set(['localhost', '127.0.0.1']);
// A host the parser has normalized: DNS labels (an IPv4 address among them) or a bracketed IPv6
// address. Never `*`, `%` or other punctuation, which the parser lets through and a CSP source
// would read as a wildcard or worse.
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^(?:${LABEL}\\.)*${LABEL}$|^\\[[0-9a-f:.]+\\]$`);

/** How strict a template check is, by deployment. */
export interface PreviewTemplateOptions {
  /**
   * Plain http on localhost and 127.0.0.1: a local stack only (`AppContext.previewLoopback`), so a
   * deployed space can never send preview tokens over cleartext.
   */
  readonly allowLoopback?: boolean;
}

/**
 * Checks a preview URL template against the type's fields, or throws `ValidationError` on
 * `preview.urlTemplate`. https only (http for localhost and 127.0.0.1 with `allowLoopback`), a
 * plain host name, no credentials, no placeholder in the scheme or host, only known placeholders,
 * and `{token}` present: without it the frontend can't read the draft it is asked to show.
 */
export function checkPreviewTemplate(
  input: string,
  fields: readonly FieldDefinition[],
  options: PreviewTemplateOptions = {},
): string {
  const refuse = (message: string): never => {
    throw new ValidationError([{ field: 'preview.urlTemplate', message }]);
  };
  const template = input.trim();
  if (template.length > MAX_PREVIEW_TEMPLATE_LENGTH) {
    refuse(`A preview URL is at most ${MAX_PREVIEW_TEMPLATE_LENGTH} characters.`);
  }
  if (/\s/.test(template)) refuse('A preview URL cannot hold spaces.');
  const bare = template.replace(PLACEHOLDER, '');
  if (bare.includes('{') || bare.includes('}')) refuse('A placeholder is written {name}.');
  const origin = previewOrigin(template, options);
  if (!origin) {
    refuse(
      'A preview URL is an https URL with a fixed host, e.g. ' +
        'https://site.example/__preview?entry={id}#token={token}.',
    );
  }
  const byApiId = new Map(fields.map((f) => [f.apiId, f]));
  let token = false;
  for (const m of template.matchAll(PLACEHOLDER)) {
    const name = m[1] ?? '';
    if (name === 'token') token = true;
    if (NAMED.has(name)) continue;
    const field = FIELD.exec(name)?.[1];
    if (!field) {
      refuse(`{${name}} is not {id}, {token}, {locale}, {space}, {environment} or {field:apiId}.`);
    }
    const def = byApiId.get(field as string);
    if (!def) refuse(`{${name}} names no field of this type.`);
    if (!PREVIEW_FIELD_TYPES.includes((def as FieldDefinition).type)) {
      refuse(`{${name}} must name a ${PREVIEW_FIELD_TYPES.join(', ')} field.`);
    }
  }
  if (!token) refuse('A preview URL must carry {token}, so the frontend can read the draft.');
  return template;
}

/**
 * The origin a preview URL template points at (`https://site.example`), or null when it isn't an
 * allowed absolute URL: not https (or http on localhost / 127.0.0.1 with `allowLoopback`), a host
 * that isn't a plain name or address (`*`), credentials in it, or a placeholder in the scheme,
 * host or port. What the admin's `frame-src` allows.
 */
export function previewOrigin(
  template: string,
  options: PreviewTemplateOptions = {},
): string | null {
  // Everything up to the first path, query or fragment is the authority: no placeholder there.
  const authority = /^[^/?#]*\/\/[^/?#]*/.exec(template)?.[0];
  if (!authority || authority.includes('{') || authority.includes('}')) return null;
  const url = parseAbsoluteUrl(template.replace(PLACEHOLDER, 'x'));
  if (!url || url.username || url.password) return null;
  if (!HOSTNAME.test(url.hostname)) return null;
  if (url.protocol === 'http:' && !(options.allowLoopback && LOOPBACK.has(url.hostname))) {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // The parser has lowercased the host and dropped a default port.
  const origin = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
  // The URL parser lets these into a host; a CSP source can't carry them.
  if (/[^\x21-\x7e]|[;,']/.test(origin)) return null;
  return origin;
}

/** What fills a preview URL template for one entry. */
export interface PreviewTemplateValues {
  readonly id: string;
  readonly token: string;
  readonly locale: string;
  readonly space: string;
  readonly environment: string;
  /** The entry's field values in `locale`, by apiId. */
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * The template filled for one entry, each value URL-encoded, or null when a `{field:…}` it names
 * has no value (a draft whose slug isn't written yet): a URL with a hole in it would preview
 * some other page.
 */
export function fillPreviewTemplate(
  template: string,
  values: PreviewTemplateValues,
): string | null {
  let missing = false;
  const filled = template.replace(PLACEHOLDER, (whole, name: string) => {
    const field = FIELD.exec(name)?.[1];
    let value: unknown;
    if (field !== undefined) value = values.fields[field];
    else if (NAMED.has(name)) value = values[name as keyof Omit<PreviewTemplateValues, 'fields'>];
    else return whole;
    if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
    if (typeof value !== 'string' || value === '') {
      missing = true;
      return '';
    }
    return encodeURIComponent(value);
  });
  return missing ? null : filled;
}

/** The field apiIds a preview URL template names. */
export const previewTemplateFields = (template: string): string[] =>
  [...template.matchAll(PLACEHOLDER)].flatMap((m) => {
    const field = FIELD.exec(m[1] ?? '')?.[1];
    return field ? [field] : [];
  });
