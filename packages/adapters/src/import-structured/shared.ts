/** What every source in this package shares: the size cap and how a record is named. */

/** Largest payload any source will parse. */
export const MAX_PAYLOAD_BYTES = 20 * 1024 * 1024;

export interface StructuredSourceOptions {
  /**
   * Field holding each record's identity in the source system.
   *
   * Defaults to the first of `id`, `ID`, `uuid`, `slug` that is present.
   * Without one, records are numbered by position — which works for a first
   * import and makes a second one duplicate everything, so the pipeline says
   * so rather than letting it happen quietly.
   */
  readonly identityField?: string;
}

export function tooLarge(payload: string): boolean {
  return payload.length > MAX_PAYLOAD_BYTES;
}

export const IDENTITY_CANDIDATES = ['id', 'ID', 'uuid', 'slug'];

/**
 * Picks each record's identity.
 *
 * Position is the last resort and deliberately visible in the value
 * (`row-12`), so an operator reading a report can tell a real identity from a
 * fallback at a glance.
 */
export function identify(
  values: Record<string, unknown>,
  index: number,
  configured: string | undefined,
): string {
  const field = configured ?? IDENTITY_CANDIDATES.find((c) => values[c] !== undefined);
  const raw = field ? values[field] : undefined;
  if (raw === undefined || raw === null || raw === '') return `row-${index + 1}`;
  return String(raw);
}
