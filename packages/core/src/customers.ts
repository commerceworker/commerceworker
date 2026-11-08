/**
 * Customer rules every store applies the same way.
 */

/** A name as matching compares it: lower case, punctuation and runs of spacing folded to one space. */
export function customerNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The one candidate whose name is exactly `name`, ignoring case, spacing and punctuation. The name
 * often comes from a model reading a document anyone can write, so a near match, or one of several
 * matches, attaches nobody: the order then waits for a person to choose the customer.
 */
export function matchCustomerByName<T extends { name: string }>(
  candidates: readonly T[],
  name: string,
): T | undefined {
  const needle = customerNameKey(name);
  if (!needle) return undefined;
  const matches = candidates.filter((c) => customerNameKey(c.name) === needle);
  return matches.length === 1 ? matches[0] : undefined;
}
