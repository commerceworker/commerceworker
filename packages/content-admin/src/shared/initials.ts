/** A person's letters for a row's tile: first and last of their name, or the first of their email. */
export function initials(name: string | null | undefined, email: string): string {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  const letters = words.length ? [words[0], words.length > 1 ? words.at(-1) : undefined] : [email];
  return letters
    .map((word) => (word ? (Array.from(word)[0] ?? '') : ''))
    .join('')
    .toUpperCase();
}

/**
 * Letters for a type without an icon: the first of each of its first two words, or the first two
 * of a one-word name, so Article and Author still look apart (`Ar`, `Au`, `LP`).
 */
export function typeMark(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1
      ? words.slice(0, 2).map((w) => Array.from(w)[0] ?? '')
      : Array.from(words[0] ?? '').slice(0, 2);
  return letters
    .map((l, i) => (i === 0 || words.length > 1 ? l.toUpperCase() : l.toLowerCase()))
    .join('');
}
