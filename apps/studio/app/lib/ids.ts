/** A new id: `<prefix>_` then a time-ordered base36 stamp and random tail. */
export function newId(prefix: string): string {
  const rand = crypto.getRandomValues(new Uint8Array(6));
  const tail = Array.from(rand, (b) => (b % 36).toString(36)).join('');
  return `${prefix}_${Date.now().toString(36)}${tail}`;
}
