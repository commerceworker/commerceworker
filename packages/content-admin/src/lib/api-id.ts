/** Derive a legal apiId (`^[a-zA-Z][a-zA-Z0-9_]*$`) from a human name, camelCased. */
export function toApiId(name: string): string {
  const words = name
    .trim()
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return '';
  const camel = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
  const cleaned = camel.replace(/[^a-zA-Z0-9_]/g, '');
  return (/^[a-zA-Z]/.test(cleaned) ? cleaned : `f${cleaned}`).slice(0, 64);
}
