// Whether text holds an email address, as `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b` (case
// insensitive) finds one. That regex backtracks quadratically on a long run that never completes,
// and the text is a buyer's or a model's, so this walks it once.

const isAlnum = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isWord = (c: number) => isAlnum(c) || c === 95; // `\w`
const isLocal = (c: number) =>
  isAlnum(c) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45;
const isDomain = (c: number) => isAlnum(c) || c === 46 || c === 45;

/** A local part that starts on a word boundary, ending just before the '@' at `at`. */
function localBefore(text: string, at: number): boolean {
  let start = at;
  while (start > 0 && isLocal(text.charCodeAt(start - 1))) start--;
  for (let s = start; s < at; s++) {
    const here = isWord(text.charCodeAt(s));
    const before = s > 0 && isWord(text.charCodeAt(s - 1));
    if (here !== before) return true;
  }
  return false;
}

/** A domain after `from`: a dot after at least one domain character, two or more letters, a boundary. */
function domainAfter(text: string, from: number): boolean {
  let run = from;
  while (run < text.length && isDomain(text.charCodeAt(run))) run++;
  for (let i = from + 1; i < run; i++) {
    if (text.charCodeAt(i) !== 46) continue;
    let end = i + 1;
    while (end < run && isLetter(text.charCodeAt(end))) end++;
    // Fewer letters than all of them would stop before a letter, which is no boundary.
    if (end - i - 1 >= 2 && (end >= text.length || !isWord(text.charCodeAt(end)))) return true;
    i = end - 1;
  }
  return false;
}

export function containsEmail(text: string): boolean {
  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
    if (at > 0 && localBefore(text, at) && domainAfter(text, at + 1)) return true;
  }
  return false;
}
