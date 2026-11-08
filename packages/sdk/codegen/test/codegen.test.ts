import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ContentTypeInput } from '../src/index.js';
import { generateTypes, loadContentTypes, parseArgs } from '../src/index.js';

// TypeScript 7 ships no compiler JS API, so this runs its own `tsc` on the source in a temp dir and
// returns the diagnostics it prints ('' when it compiles clean).
const tscBin = join(
  dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
  'bin',
  'tsc',
);
async function tsc(source: string, compilerOptions: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cw-tsc-'));
  await writeFile(join(dir, 'generated.ts'), source);
  await writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { noEmit: true, ...compilerOptions },
      files: ['generated.ts'],
    }),
  );
  try {
    execFileSync(process.execPath, [tscBin, '-p', dir, '--pretty', 'false'], { encoding: 'utf8' });
    return '';
  } catch (error) {
    return String((error as { stdout?: string }).stdout || error);
  }
}
/** A model exercising every field type, validations, and naming edge cases. */
const MODEL: ContentTypeInput[] = [
  {
    apiId: 'article',
    name: 'Article',
    fields: [
      { apiId: 'title', name: 'Title', type: 'Symbol', required: true, localized: true },
      { apiId: 'body', type: 'RichText' },
      { apiId: 'summary', type: 'Text' },
      { apiId: 'views', type: 'Integer' },
      { apiId: 'rating', type: 'Number', validations: { in: [1, 2, 3] } },
      { apiId: 'featured', type: 'Boolean' },
      { apiId: 'publishedOn', type: 'Date' },
      { apiId: 'venue', type: 'Location' },
      { apiId: 'meta', type: 'JSON' },
      {
        apiId: 'hero',
        type: 'Link',
        linkType: 'Asset',
      },
      {
        apiId: 'author',
        type: 'Link',
        linkType: 'Entry',
        validations: { linkContentTypes: ['author'] },
      },
      { apiId: 'tags', type: 'Array', items: { type: 'Symbol' } },
      {
        apiId: 'status',
        type: 'Symbol',
        required: true,
        validations: { in: ['draft', 'live'] },
      },
      {
        apiId: 'related',
        type: 'Array',
        items: { type: 'Link', linkType: 'Entry' },
      },
      { apiId: 'og:image', type: 'Symbol' },
      { apiId: 'seo', type: 'Seo' },
    ],
  },
  { apiId: 'author', name: 'Author', fields: [{ apiId: 'name', type: 'Symbol', required: true }] },
  // Collides with 'author' after PascalCase normalization.
  { apiId: 'author_', fields: [] },
];

/** Syntactic edge cases: escaping, naming fallbacks, unknown types. */
const EDGE: ContentTypeInput[] = [
  {
    apiId: 'blog-post',
    fields: [
      { apiId: 'sizes', type: 'Array', items: { type: 'Symbol', validations: { in: ['s', 'm'] } } },
      { apiId: 'gallery', type: 'Array', items: { type: 'Link', linkType: 'Asset' } },
      { apiId: 'bare', type: 'Array' },
      { apiId: 'untyped-link', type: 'Link' },
      { apiId: 'future', type: 'FutureThing' },
      {
        apiId: 'callout',
        type: 'Component',
        fields: [
          { apiId: 'heading', type: 'Symbol', required: true },
          { apiId: 'icon', type: 'Link', linkType: 'Asset' },
        ],
      },
      {
        apiId: 'cards',
        type: 'Array',
        items: {
          type: 'Component',
          fields: [
            { apiId: 'label', type: 'Symbol', required: true },
            { apiId: 'variant', type: 'Symbol', validations: { in: ['a', 'b'] } },
          ],
        },
      },
      { apiId: 'shapeless', type: 'Component' },
      {
        apiId: 'blocks',
        type: 'Array',
        items: {
          type: 'Component',
          variants: [
            {
              apiId: 'hero',
              name: 'Hero',
              fields: [
                { apiId: 'heading', type: 'Symbol', required: true },
                { apiId: 'image', type: 'Link', linkType: 'Asset' },
              ],
            },
            {
              apiId: 'cta',
              name: 'Call to action',
              fields: [{ apiId: 'target', type: 'Link', linkType: 'Entry', required: true }],
            },
          ],
        },
      },
      { apiId: "author's-note", type: 'Symbol' },
      { apiId: 'tricky', name: 'Bad */ comment', type: 'Symbol', localized: true },
      { apiId: 'mood', type: 'Symbol', validations: { in: ["it's"] } },
    ],
  },
  { apiId: '123', fields: [] },
  { apiId: '!!!', fields: [] },
];

describe('@commerceworker/sdk-codegen generator', () => {
  const source = generateTypes(MODEL);
  const edge = generateTypes(EDGE);

  it('maps every field type to the right TypeScript type', () => {
    expect(source).toContain('title: string;');
    expect(source).toContain('body?: RichTextDocument;');
    expect(source).toContain('summary?: string;');
    expect(source).toContain('views?: number;');
    expect(source).toContain('rating?: 1 | 2 | 3;');
    expect(source).toContain('featured?: boolean;');
    expect(source).toContain('publishedOn?: string;');
    expect(source).toContain('venue?: Location;');
    expect(source).toContain('meta?: Record<string, unknown>;');
    expect(source).toContain('hero?: AssetLink | DeliveredAsset;');
    expect(source).toContain('author?: EntryLink;');
    expect(source).toContain('tags?: string[];');
    expect(source).toContain("status: 'draft' | 'live';");
    expect(source).toContain('related?: EntryLink[];');
    expect(source).toContain(
      'seo?: { title?: string; description?: string; canonicalUrl?: string; noindex?: boolean; ogImage?: AssetLink | DeliveredAsset };',
    );
  });

  it('types labelled options by their stored values and documents a field from its guidance', () => {
    const out = generateTypes([
      {
        apiId: 'post',
        fields: [
          {
            apiId: 'status',
            name: 'Status',
            type: 'Symbol',
            required: true,
            description: 'Where the post is in its life.\nNot the */ publish state.',
            validations: { in: [{ value: 'draft', label: 'Draft' }, 'live'] },
          },
          {
            apiId: 'stars',
            type: 'Integer',
            help: 'One to three.',
            validations: { in: [1, { value: 2, label: 'Two' }] },
          },
        ],
      },
    ]);
    expect(out).toContain("status: 'draft' | 'live';");
    expect(out).toContain('stars?: 1 | 2;');
    expect(out).toContain(
      '/** Status — Where the post is in its life. Not the *\\/ publish state. */',
    );
    expect(out).toContain('/** One to three. */');
    expect(out).not.toContain("'Draft'");
  });

  it('types a component as its nested shape, not as unknown', () => {
    expect(edge).toContain('callout?: { heading: string; icon?: AssetLink | DeliveredAsset };');
  });

  it('types a repeater as an array of that shape', () => {
    // The old fallback claimed `string[]` here, which was not vague — it was
    // wrong, and consumers would have written code against it.
    expect(edge).toContain("cards?: { label: string; variant?: 'a' | 'b' }[];");
    expect(edge).not.toContain('cards?: string[];');
  });

  it('keeps nested values bare in the draft shape', () => {
    // A component is localized as a whole, so the locale is resolved one level
    // up; `Localized<>` on a leaf would describe a shape that never arrives.
    expect(edge).toContain('callout?: Localized<{ heading: string; icon?: AssetLink }>;');
  });

  it('types a blocks field as an array of a union discriminated on _type', () => {
    // Golden: the exact text consumers compile against, delivered and draft.
    expect(edge).toContain(
      "blocks?: ({ _type: 'hero'; _key: string; heading: string; image?: AssetLink | DeliveredAsset } | { _type: 'cta'; _key: string; target: EntryLink })[];",
    );
    expect(edge).toContain(
      "blocks?: Localized<({ _type: 'hero'; _key: string; heading: string; image?: AssetLink } | { _type: 'cta'; _key: string; target: EntryLink })[]>;",
    );
  });

  it('falls back to a record for a component with no declared shape', () => {
    expect(edge).toContain('shapeless?: Record<string, unknown>;');
  });

  it('quotes non-identifier property keys', () => {
    expect(source).toContain("'og:image'?: string;");
  });

  it('emits delivery and locale-keyed draft type aliases per content type', () => {
    // Aliases (not interfaces): they satisfy `F extends Record<string, unknown>`.
    expect(source).toContain('export type ArticleFields = {');
    expect(source).toContain('export type ArticleDraftFields = {');
    expect(source).toContain('title: Localized<string>;');
    expect(source).toContain("status: Localized<'draft' | 'live'>;");
  });

  it('deduplicates colliding type names', () => {
    expect(source).toContain('export type AuthorFields = {');
    expect(source).toContain('export type Author2Fields = {');
  });

  it('emits the apiId union and lookup maps', () => {
    expect(source).toContain("export type ContentTypeApiId = 'article' | 'author' | 'author_';");
    expect(source).toContain('export interface FieldsByContentType {');
    expect(source).toContain('article: ArticleFields;');
    expect(source).toContain('export interface DraftFieldsByContentType {');
    expect(source).toContain('article: ArticleDraftFields;');
  });

  it('documents field names, localization, and link restrictions', () => {
    expect(source).toContain('/** Title — localized */');
    expect(source).toContain('/** links: author */');
  });

  it('never narrows where the domain does not enforce `in` (Date, array items)', () => {
    // validate.ts applies checkIn only to Symbol/Text/Integer/Number.
    expect(edge).toContain('sizes?: string[];');
    expect(source).toContain('publishedOn?: string;');
  });

  it('handles asset-link arrays, item-less arrays, and untyped links', () => {
    expect(edge).toContain('gallery?: (AssetLink | DeliveredAsset)[];');
    expect(edge).toContain('gallery?: Localized<AssetLink[]>;');
    expect(edge).toContain('bare?: string[];');
    expect(edge).toContain("'untyped-link'?: EntryLink;");
  });

  it('types a delivered asset link as the link or the embedded asset, a draft one as the link', () => {
    expect(source).toContain('export interface DeliveredAsset {');
    expect(source).toContain('srcset: { width: number; url: string }[];');
    expect(source).toContain('renditions: Record<string, string>;');
    expect(source).toContain('hero?: Localized<AssetLink>;');
  });

  it("types an embed node's data as structured metadata, not markup", () => {
    expect(source).toContain('export interface EmbedData {');
    expect(source).toContain("kind?: 'video' | 'post' | 'audio' | 'other';");
    expect(source).toContain('& Partial<EmbedData> &');
    expect(source).not.toMatch(/html\??:/);
  });

  it('maps unrecognized field types to unknown', () => {
    expect(edge).toContain('future?: unknown;');
  });

  it('escapes quotes and comment terminators in generated source', () => {
    expect(edge).toContain("'author\\'s-note'?: string;");
    expect(edge).toContain('/** Bad *\\/ comment — localized */');
    expect(edge).toContain("mood?: 'it\\'s';");
  });

  it('quotes non-identifier content-type apiIds in lookup maps and the union', () => {
    expect(edge).toContain("export type ContentTypeApiId = 'blog-post' | '123' | '!!!';");
    expect(edge).toContain("'blog-post': BlogPostFields;");
    expect(edge).toContain("'blog-post': BlogPostDraftFields;");
  });

  it('falls back to ContentType for apiIds that normalize to nothing', () => {
    expect(edge).toContain('export type ContentTypeFields = {');
    expect(edge).toContain('export type ContentType2Fields = {');
  });

  it('produces source that compiles clean and satisfies the SDK generics', async () => {
    // The appended usage block proves generated shapes plug into the SDKs'
    // `F extends Record<string, unknown>` constraint (interfaces would not).
    const source = `${generateTypes([...MODEL, ...EDGE])}
declare function acceptsFields<F extends Record<string, unknown>>(f: F): F;
declare const article: ArticleFields;
declare const draft: ArticleDraftFields;
acceptsFields(article);
acceptsFields(draft);
// A blocks element narrows on _type to its variant's fields.
declare const post: BlogPostFields;
for (const block of post.blocks ?? []) {
  if (block._type === 'hero') block.heading.toUpperCase();
  else block.target.id.toUpperCase();
}
// An embed node's data reads as EmbedData.
for (const node of article.body?.content ?? []) {
  if (node.nodeType === 'embed' && node.data?.url) node.data.url.toUpperCase();
}
`;
    // types: [] keeps ambient @types packages (e.g. node) out of the check —
    // the generated module must stand alone.
    expect(await tsc(source, { strict: true, target: 'es2022', types: [] })).toBe('');
  });

  it('handles an empty model without emitting the union block', () => {
    const empty = generateTypes([]);
    expect(empty).toContain('export interface EntryLink');
    expect(empty).not.toContain('ContentTypeApiId');
  });
});

describe('@commerceworker/sdk-codegen CLI', () => {
  it('makes a required field a rule can hide optional, and notes its rules', () => {
    const out = generateTypes([
      {
        apiId: 'card',
        fields: [
          { apiId: 'kind', type: 'Symbol', required: true },
          { apiId: 'url', type: 'Symbol', required: true, rules: [{ action: 'hide' }] },
          { apiId: 'ref', type: 'Symbol', required: true, rules: [{ action: 'disable' }] },
        ],
      },
    ]);
    expect(out).toContain('  kind: string;');
    expect(out).toContain('  url?: string;');
    expect(out).toContain('  ref: string;');
    expect(out).toContain('conditional: hide by rules');
  });

  it('types lists of scalars and notes a Date field’s format', () => {
    const out = generateTypes([
      {
        apiId: 'event',
        fields: [
          { apiId: 'day', type: 'Date', format: 'date' },
          { apiId: 'opens', type: 'Date', format: 'time' },
          { apiId: 'sizes', type: 'Array', items: { type: 'Integer' } },
          { apiId: 'weights', type: 'Array', items: { type: 'Number' } },
          { apiId: 'lines', type: 'Array', items: { type: 'Text' } },
          { apiId: 'days', type: 'Array', items: { type: 'Date', format: 'date' } },
        ],
      },
    ]);
    expect(out).toContain('/** date: YYYY-MM-DD */\n  day?: string;');
    expect(out).toContain('/** time: hh:mm */');
    expect(out).toContain('  sizes?: number[];');
    expect(out).toContain('  weights?: number[];');
    expect(out).toContain('  lines?: string[];');
    expect(out).toContain('/** date: YYYY-MM-DD */\n  days?: string[];');
  });

  it('parses flags and rejects unknown ones', () => {
    expect(parseArgs(['--url', 'https://x', '--space', 's1', '--token', 't'])).toEqual({
      url: 'https://x',
      space: 's1',
      token: 't',
    });
    expect(() => parseArgs(['--nope', 'x'])).toThrow('Unknown flag: --nope');
    expect(() => parseArgs(['--url'])).toThrow('Missing value for --url');
    expect(() => parseArgs(['--url', '--space', 's1'])).toThrow('Missing value for --url');
    expect(() => parseArgs(['stray'])).toThrow('Unexpected argument: stray');
    expect(parseArgs(['--help'])).toEqual({ help: true });
  });

  it('loads content types from the Management API with a bearer token', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ items: MODEL }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const items = await loadContentTypes(
      { url: 'https://cms.test/', space: 's 1', environment: 'main', token: 'tok' },
      fetchImpl,
    );
    expect(items).toHaveLength(3);
    expect(calls[0]?.url).toBe('https://cms.test/spaces/s%201/environments/main/content-types');
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('surfaces HTTP failures with the status', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    await expect(
      loadContentTypes(
        { url: 'https://cms.test', space: 's1', environment: 'main', token: 'bad' },
        fetchImpl,
      ),
    ).rejects.toThrow('Fetching content types failed: 401');
  });

  it('requires the full URL flag set when no --input is given', async () => {
    await expect(loadContentTypes({ url: 'https://cms.test' })).rejects.toThrow(
      '--url, --space, --environment, and --token are all required',
    );
  });

  it('loads content types from a JSON file ({ items } or bare array)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'commerceworker-codegen-'));
    const wrapped = join(dir, 'wrapped.json');
    const bare = join(dir, 'bare.json');
    await writeFile(wrapped, JSON.stringify({ items: MODEL }), 'utf8');
    await writeFile(bare, JSON.stringify(MODEL), 'utf8');

    expect(await loadContentTypes({ input: wrapped })).toHaveLength(3);
    expect(await loadContentTypes({ input: bare })).toHaveLength(3);
  });

  it('returns [] for bodies without items and prefers --input over URL flags', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'commerceworker-codegen-'));
    const empty = join(dir, 'empty.json');
    await writeFile(empty, JSON.stringify({}), 'utf8');

    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    ) as unknown as typeof fetch;

    expect(await loadContentTypes({ input: empty, url: 'https://cms.test' }, fetchImpl)).toEqual(
      [],
    );
    expect(fetchImpl).not.toHaveBeenCalled(); // --input wins; no HTTP call

    const viaHttp = await loadContentTypes(
      { url: 'https://cms.test', space: 's1', environment: 'main', token: 't' },
      fetchImpl,
    );
    expect(viaHttp).toEqual([]);
  });

  it('end-to-end: live API in, module to stdout', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: MODEL }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    let printed = '';
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed += String(line);
    });
    try {
      const { main } = await import('../src/cli.js');
      await main([
        '--url',
        'https://cms.test',
        '--space',
        's1',
        '--environment',
        'main',
        '--token',
        't',
      ]);
    } finally {
      vi.unstubAllGlobals();
      log.mockRestore();
    }
    expect(printed).toContain('Generated by @commerceworker/sdk-codegen from s1/main.');
    expect(printed).toContain('export type ArticleFields = {');
  });

  it('end-to-end: file in, generated module out via main()', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'commerceworker-codegen-'));
    const input = join(dir, 'model.json');
    const out = join(dir, 'types.ts');
    await writeFile(input, JSON.stringify({ items: MODEL }), 'utf8');

    const { main } = await import('../src/cli.js');
    await main(['--input', input, '--out', out]);

    const written = await readFile(out, 'utf8');
    expect(written).toContain('Generated by @commerceworker/sdk-codegen from');
    expect(written).toContain('export type ArticleFields = {');
  });
});
