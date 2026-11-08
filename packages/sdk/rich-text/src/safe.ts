/** HTML-escapes text for element content and attribute values. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

/**
 * A link URI that is safe to put in an href: http(s), mailto, tel, or a relative URL. Read the way
 * browsers read it (whitespace and control characters inside a scheme are ignored, so
 * `java\tscript:` is still javascript:), and a `&` before the path makes it unusable (an entity can
 * hide a scheme's colon). The same rule CommerceWorker applies when content is saved.
 */
export function safeLinkUri(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const uri = raw.trim();
  if (!uri) return undefined;
  const scheme = /^([^/?#]*?):/.exec(
    [...uri].filter((c) => c.charCodeAt(0) > 0x20 && c.charCodeAt(0) !== 0x7f).join(''),
  )?.[1];
  if (/^[^/?#]*&/.test(uri)) return undefined;
  if (scheme === undefined) return uri;
  return SAFE_SCHEMES.has(scheme.toLowerCase()) ? uri : undefined;
}
