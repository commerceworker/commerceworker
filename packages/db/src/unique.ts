/** A unique index refused the write: Drizzle wraps D1's error, so its cause chain is read too. */
export function uniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if (String((e as Error).message ?? e).includes('UNIQUE')) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
