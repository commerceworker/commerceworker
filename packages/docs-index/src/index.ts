/**
 * Read-only access to the product documentation, for agents building against
 * commerceworker.
 *
 * An agent that can *connect* to the CMS is far more useful if it also knows
 * the conventions — which scope a route needs, what a `LocalizedValue` is, why
 * ids are UUIDv7. This exposes the same `docs/` a human reads, over the same
 * MCP and HTTP surfaces the agent is already authenticated to.
 */
import { DOC_SOURCES } from './generated';

export interface DocHeading {
  /** Markdown heading depth: 1 for `#`, 2 for `##`, and so on. */
  readonly depth: number;
  readonly title: string;
  /** Anchor slug, matching the one GitHub and most renderers generate. */
  readonly slug: string;
}

export interface DocPage {
  /** Slug, e.g. `api-reference` — the filename without `.md`. */
  readonly path: string;
  /** The first `#` heading, or the path when the page has none. */
  readonly title: string;
  readonly headings: readonly DocHeading[];
  /** Length in characters, so a caller can decide whether to read it whole. */
  readonly length: number;
}

export interface DocMatch {
  readonly path: string;
  readonly title: string;
  /** The nearest heading above the match — where in the page to look. */
  readonly section?: string;
  /** One line of context around the match. */
  readonly snippet: string;
  readonly line: number;
}

/** Anchor slug: lowercase, punctuation dropped, spaces to hyphens. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * Lines that are inside a fenced code block.
 *
 * Headings are parsed off raw lines, and `# comment` inside a shell block is not
 * a heading — without this the outline of any page with shell examples fills up
 * with fragments of commands.
 */
function codeFenceMask(lines: readonly string[]): boolean[] {
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return true;
    }
    return inFence;
  });
}

function parse(path: string, body: string): DocPage & { body: string } {
  const lines = body.split('\n');
  const inCode = codeFenceMask(lines);
  const headings: DocHeading[] = [];
  lines.forEach((line, i) => {
    if (inCode[i]) return;
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (!m?.[1] || !m[2]) return;
    headings.push({ depth: m[1].length, title: m[2], slug: slugify(m[2]) });
  });
  return {
    path,
    title: headings.find((h) => h.depth === 1)?.title ?? path,
    headings,
    length: body.length,
    body,
  };
}

const PAGES: readonly (DocPage & { body: string })[] = Object.entries(DOC_SOURCES)
  .map(([path, body]) => parse(path, body))
  .sort((a, b) => a.path.localeCompare(b.path));

/** Every page, with its outline — enough to decide what to read. */
export function listDocs(): DocPage[] {
  return PAGES.map(({ body: _body, ...page }) => page);
}

/**
 * One page, or one section of it.
 *
 * `section` takes a heading slug and returns that heading down to the next one
 * of the same or shallower depth, so an agent can pull "Publishing" out of a
 * 30KB page instead of reading all of it into its context.
 */
export function readDoc(path: string, opts: { section?: string } = {}): string | undefined {
  const page = PAGES.find((p) => p.path === path);
  if (!page) return undefined;
  if (!opts.section) return page.body;

  const lines = page.body.split('\n');
  const inCode = codeFenceMask(lines);
  const headingAt = (i: number) =>
    inCode[i] ? null : /^(#{1,6})\s+(.*?)\s*$/.exec(lines[i] as string);

  let start = -1;
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = headingAt(i);
    if (m?.[2] && slugify(m[2]) === opts.section) {
      start = i;
      depth = (m[1] as string).length;
      break;
    }
  }
  if (start === -1) return undefined;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = headingAt(i);
    if (m?.[1] && m[1].length <= depth) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trimEnd();
}

/** Largest number of matches a single search returns. */
export const DOC_SEARCH_MAX_RESULTS = 50;

/**
 * Full-text search across every page.
 *
 * Every term must appear on the line, mirroring the AND semantics of the
 * product's own lexical search — a docs search that ORs its terms returns the
 * whole manual for any two-word query.
 */
export function searchDocs(
  query: string,
  opts: { limit?: number; path?: string } = {},
): DocMatch[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), DOC_SEARCH_MAX_RESULTS);
  const matches: DocMatch[] = [];

  for (const page of PAGES) {
    if (opts.path && page.path !== opts.path) continue;
    const lines = page.body.split('\n');
    const inCode = codeFenceMask(lines);
    let section: string | undefined;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      const heading = inCode[i] ? null : /^#{1,6}\s+(.*?)\s*$/.exec(line);
      if (heading?.[1]) {
        section = heading[1];
        continue;
      }
      const haystack = line.toLowerCase();
      if (!terms.every((t) => haystack.includes(t))) continue;
      matches.push({
        path: page.path,
        title: page.title,
        section,
        snippet: line.trim(),
        line: i + 1,
      });
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}
