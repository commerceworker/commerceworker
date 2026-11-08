/**
 * A small, strict XML reader — enough for the exports this package reads, and
 * nothing a hostile file can turn against the reader.
 *
 * Hand-rolled rather than taking a dependency, like the CSV reader: the subset
 * an export uses (elements, attributes, CDATA, the five predefined entities and
 * character references) is small, and it has to run on Node and in a Worker,
 * neither of which has a DOM.
 *
 * Deliberately **not** supported: a DOCTYPE's internal subset. Custom entity
 * declarations are how an XML file expands into gigabytes or reads a local
 * file, and no export needs them, so a document type is skipped and its
 * entities are never defined.
 *
 * An entity it does not know (`&nbsp;` in a site title saved outside CDATA) is
 * left as written rather than failing the file: one stray character should
 * not block a migration, and it stays visible for an editor to fix.
 */

export interface XmlElement {
  /** The qualified name as written, prefix included (`wp:post_id`). */
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /** All character data directly inside this element, CDATA included. */
  readonly text: string;
}

interface MutableElement {
  name: string;
  attributes: Record<string, string>;
  children: MutableElement[];
  text: string;
}

/**
 * Every construct left open at end of input is a cut-off file far more often
 * than a hand-written mistake, so the message points there.
 */
const TRUNCATED = ' — the file may be truncated';

const PREDEFINED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Parses a document and returns its root element. Throws on malformed input. */
export function parseXml(source: string): XmlElement {
  const stack: MutableElement[] = [];
  let root: MutableElement | undefined;
  let i = 0;

  // Errors name a line, because "malformed XML" in a 15 MB export is not
  // something an operator can act on.
  const fail = (message: string, at = i): never => {
    const line = source.slice(0, at).split('\n').length;
    throw new Error(`${message} (line ${line})`);
  };

  const appendText = (text: string) => {
    const current = stack[stack.length - 1];
    if (current) {
      current.text += text;
    } else if (text.trim()) {
      fail('Text outside the root element');
    }
  };

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      appendText(decodeEntities(source.slice(i)));
      break;
    }
    if (lt > i) appendText(decodeEntities(source.slice(i, lt)));
    i = lt;

    if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i + 9);
      if (end === -1) fail(`Unterminated CDATA section${TRUNCATED}`);
      appendText(source.slice(i + 9, end));
      i = end + 3;
    } else if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      if (end === -1) fail(`Unterminated comment${TRUNCATED}`);
      i = end + 3;
    } else if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i + 2);
      if (end === -1) fail(`Unterminated processing instruction${TRUNCATED}`);
      i = end + 2;
    } else if (source.startsWith('<!', i)) {
      i = skipDeclaration(source, i, fail);
    } else if (source[i + 1] === '/') {
      const end = source.indexOf('>', i);
      if (end === -1) fail(`Unterminated closing tag${TRUNCATED}`);
      const name = source.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open) fail(`Closing tag </${name}> with nothing open`);
      if (open?.name !== name) fail(`Expected </${open?.name}> but found </${name}>`);
      i = end + 1;
    } else {
      const { element, selfClosing, next } = readStartTag(source, i, fail);
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.children.push(element);
      } else if (root) {
        fail('More than one root element');
      } else {
        root = element;
      }
      if (!selfClosing) stack.push(element);
      i = next;
    }
  }

  const unclosed = stack[stack.length - 1];
  // The usual cause is a truncated download, so say that rather than naming a tag.
  if (unclosed) fail(`Document ends inside <${unclosed.name}>${TRUNCATED}`);
  if (!root) fail('No root element');
  return root as XmlElement;
}

/** Skips `<!DOCTYPE …>` including a bracketed internal subset, without reading it. */
function skipDeclaration(source: string, start: number, fail: (m: string) => never): number {
  let depth = 0;
  for (let j = start + 2; j < source.length; j += 1) {
    const char = source[j];
    // A quoted literal can hold `]` or `>`; it is stepped over, not counted.
    if (char === '"' || char === "'") {
      const close = source.indexOf(char, j + 1);
      if (close === -1) break;
      j = close;
    } else if (char === '[') depth += 1;
    else if (char === ']') depth -= 1;
    else if (char === '>' && depth <= 0) return j + 1;
  }
  return fail(`Unterminated declaration${TRUNCATED}`);
}

function readStartTag(
  source: string,
  start: number,
  fail: (m: string, at?: number) => never,
): { element: MutableElement; selfClosing: boolean; next: number } {
  let j = start + 1;
  const nameStart = j;
  while (j < source.length && !/[\s/>]/.test(source[j] ?? '')) j += 1;
  const name = source.slice(nameStart, j);
  if (!name) fail('Tag with no name', start);

  const attributes: Record<string, string> = {};
  for (;;) {
    while (j < source.length && /\s/.test(source[j] ?? '')) j += 1;
    const char = source[j];
    if (char === undefined) return fail(`Unterminated tag <${name}>${TRUNCATED}`, start);
    if (char === '>') return { element: blank(name, attributes), selfClosing: false, next: j + 1 };
    if (char === '/' && source[j + 1] === '>') {
      return { element: blank(name, attributes), selfClosing: true, next: j + 2 };
    }

    const attrStart = j;
    while (j < source.length && !/[\s=/>]/.test(source[j] ?? '')) j += 1;
    const attr = source.slice(attrStart, j);
    if (!attr) fail(`Attribute with no name on <${name}>`, j);
    while (/\s/.test(source[j] ?? '')) j += 1;
    if (source[j] !== '=') fail(`Attribute "${attr}" on <${name}> has no value`, j);
    j += 1;
    while (/\s/.test(source[j] ?? '')) j += 1;
    const quote = source[j];
    if (quote !== '"' && quote !== "'") fail(`Attribute "${attr}" on <${name}> is not quoted`, j);
    const close = source.indexOf(quote as string, j + 1);
    if (close === -1) fail(`Unterminated attribute "${attr}" on <${name}>${TRUNCATED}`, j);
    attributes[attr] = decodeEntities(source.slice(j + 1, close));
    j = close + 1;
  }
}

function blank(name: string, attributes: Record<string, string>): MutableElement {
  return { name, attributes, children: [], text: '' };
}

/**
 * Decodes the predefined entities and character references. Anything else is
 * left as written (see the module comment).
 */
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return PREDEFINED[body] ?? match;
  });
}

/** The first child with this qualified name. */
export function child(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((c) => c.name === name);
}

/** The text of the first child with this qualified name, or `''`. */
export function childText(element: XmlElement, name: string): string {
  return child(element, name)?.text ?? '';
}
