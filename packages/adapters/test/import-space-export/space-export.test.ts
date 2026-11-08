import { validateRichText } from '@commerceworker/domain';
import type { ConvertedSpace } from '@commerceworker/ports';
import { spaceExportFixture } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createSpaceExportReader } from '../../src/import-space-export';

const reader = createSpaceExportReader();

async function read(
  doc: Record<string, unknown> = spaceExportFixture(),
  locales: readonly string[] = ['en-US'],
): Promise<ConvertedSpace> {
  let n = 0;
  return reader.read(JSON.stringify(doc), { newId: () => `new-${++n}`, locales });
}

/** The new id an export entry or asset took. */
function idOf(space: ConvertedSpace, sourceId: string): string {
  const found =
    space.entries.find((e) => e.sourceId === sourceId) ??
    space.assets.find((a) => a.sourceId === sourceId);
  if (!found) throw new Error(`${sourceId} was not imported`);
  return found.id;
}

const entry = (space: ConvertedSpace, sourceId: string) => {
  const found = space.entries.find((e) => e.sourceId === sourceId);
  if (!found) throw new Error(`${sourceId} was not imported`);
  return found;
};

describe('space export reader: content model', () => {
  it('maps each field type, keeps the validations it can, and reports the rest', async () => {
    const space = await read();
    const post = space.contentTypes.find((t) => t.apiId === 'blogPost');
    expect(post?.status).toBe('published');
    const field = (apiId: string) => post?.fields.find((f) => f.apiId === apiId);

    expect(field('title')).toMatchObject({
      type: 'Symbol',
      localized: true,
      required: true,
      validations: { size: { min: 3, max: 120 } },
    });
    expect(field('slug')).toMatchObject({ type: 'Symbol', unique: true });
    expect(field('body')?.type).toBe('RichText');
    expect(field('author')).toMatchObject({
      type: 'Link',
      linkType: 'Entry',
      validations: { linkContentTypes: ['author'] },
    });
    expect(field('categories')).toMatchObject({
      type: 'Array',
      items: { type: 'Link', linkType: 'Entry', validations: { linkContentTypes: ['category'] } },
      validations: { size: { max: 3 } },
    });
    expect(field('keywords')?.items).toEqual({
      type: 'Symbol',
      validations: { in: ['cms', 'migration', 'edge'] },
    });
    expect(field('readingMinutes')).toMatchObject({
      type: 'Integer',
      validations: { range: { min: 1, max: 90 } },
    });
    expect(field('featured')).toMatchObject({ type: 'Boolean', defaultValue: { 'en-US': false } });
    // Object has no other name for itself here.
    expect(field('seo')?.type).toBe('JSON');
    expect(field('heroImage')).toMatchObject({ type: 'Link', linkType: 'Asset' });
    // No equivalent, and a deleted field: neither is defined.
    expect(field('sponsor')).toBeUndefined();
    expect(field('legacyBody')).toBeUndefined();
    expect(space.findings.unmappedFields).toEqual([
      'blogPost.sponsor (ResourceLink): no equivalent field type here',
    ]);

    const category = space.contentTypes.find((t) => t.apiId === 'category');
    // The rule's custom message comes with it.
    expect(category?.fields.find((f) => f.apiId === 'slug')?.validations).toEqual({
      regexp: { pattern: '^[a-z0-9-]+$' },
      messages: { regexp: 'Lowercase letters, digits and hyphens' },
    });
    expect(space.findings.unmappedValidations).toEqual(
      expect.arrayContaining([
        'author.avatar: linkMimetypeGroup',
        'author.avatar: assetFileSize',
        'blogPost.body: enabledMarks',
        'blogPost.body: enabledNodeTypes',
        'blogPost.publishDate: dateRange',
      ]),
    );
  });

  it('renames an id that is not a legal apiId, and links to it follow', async () => {
    const space = await read();
    expect(space.contentTypes.map((t) => t.apiId)).toEqual([
      'author',
      'category',
      'blogPost',
      'landing_page',
    ]);
    expect(space.findings.warnings).toContain(
      'Content type "landing-page" is imported as "landing_page"',
    );
    expect(entry(space, 'landing-home').contentTypeApiId).toBe('landing_page');
  });

  it('reads the locales with their fallback chain', async () => {
    const space = await read();
    expect(space.defaultLocale).toBe('en-US');
    expect(space.locales.map((l) => [l.code, l.fallback, l.default])).toEqual([
      ['en-US', null, true],
      ['de-DE', 'en-US', false],
      ['fr-FR', 'de-DE', false],
    ]);
  });

  it('keeps usable options once each, and reports a message on list elements', async () => {
    const doc = spaceExportFixture();
    const category = (doc.contentTypes as { sys: { id: string }; fields: object[] }[]).find(
      (t) => t.sys.id === 'category',
    );
    category?.fields.push(
      {
        id: 'tone',
        name: 'Tone',
        type: 'Symbol',
        validations: [{ in: ['calm', 'calm', '', 1, '1', true], message: 'Pick a tone' }],
      },
      {
        id: 'moods',
        name: 'Moods',
        type: 'Array',
        items: { type: 'Symbol', validations: [{ in: ['a'], message: 'Pick a mood' }] },
      },
    );
    const space = await read(doc);
    const fields = space.contentTypes.find((t) => t.apiId === 'category')?.fields ?? [];
    expect(fields.find((f) => f.apiId === 'tone')?.validations).toEqual({
      in: ['calm', 1],
      messages: { in: 'Pick a tone' },
    });
    expect(fields.find((f) => f.apiId === 'moods')?.items?.validations).toEqual({ in: ['a'] });
    expect(space.findings.unmappedValidations).toContain('category.moods[]: in custom message');
  });

  it('imports editor help text as the field’s help, and counts what has no field to go on', async () => {
    const doc = spaceExportFixture();
    const controls = (doc.editorInterfaces as { controls: object[] }[])[0]?.controls ?? [];
    controls.push({ fieldId: 'sponsor', settings: { helpText: 'Not imported: no such field.' } });
    const space = await read(doc);
    const post = space.contentTypes.find((t) => t.apiId === 'blogPost');
    expect(post?.fields.find((f) => f.apiId === 'title')?.help).toBe(
      'Keep it under 60 characters.',
    );
    expect(post?.fields.find((f) => f.apiId === 'slug')?.help).toBe('Generated from the title.');
    expect(space.findings.warnings).toContain(
      '1 field help text(s) from editor interfaces are not imported',
    );
  });

  it('drops a fallback to a locale the export does not declare', async () => {
    const doc = spaceExportFixture();
    (doc.locales as { fallbackCode: string | null }[])[2] = {
      ...(doc.locales as object[])[2],
      fallbackCode: 'it-IT',
    } as never;
    const space = await read(doc);
    expect(space.locales.find((l) => l.code === 'fr-FR')?.fallback).toBeNull();
  });
});

describe('space export reader: entries and links', () => {
  it('remaps every link to the new ids, forward references and cycles included', async () => {
    const space = await read();
    const hello = entry(space, 'post-hello');
    const second = entry(space, 'post-second');
    // post-hello links post-second, which comes after it in the file; post-second links back.
    expect(hello.fields.related).toEqual({
      'en-US': [{ id: idOf(space, 'post-second'), linkType: 'Entry' }],
    });
    expect(second.fields.related).toEqual({
      'en-US': [{ id: idOf(space, 'post-hello'), linkType: 'Entry' }],
    });
    expect(hello.fields.author).toEqual({
      'en-US': { id: idOf(space, 'author-ada'), linkType: 'Entry' },
    });
    expect(hello.fields.heroImage).toEqual({
      'en-US': { id: idOf(space, 'asset-hero'), linkType: 'Asset' },
    });
    expect(hello.fields.categories?.['en-US']).toHaveLength(2);
    // Every id is new; none is the export's.
    const ids = [...space.entries, ...space.assets].map((x) => x.id);
    expect(ids.every((id) => id.startsWith('new-'))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('drops a link to something the export does not carry, and reports it', async () => {
    const space = await read();
    expect(entry(space, 'post-second').fields.author).toBeUndefined();
    expect(space.findings.missingLinks).toEqual(
      expect.arrayContaining([
        { entry: 'post-second', field: 'author', linkType: 'Entry', target: 'author-missing' },
        { entry: 'post-hello', field: 'body', linkType: 'Entry', target: 'post-gone' },
      ]),
    );
  });

  it('keeps published state where the export marks it, and says what it could not keep', async () => {
    const space = await read();
    expect(entry(space, 'post-hello').status).toBe('published');
    expect(entry(space, 'author-grace').status).toBe('draft');
    // A newer draft on a published version: only the draft is in the export.
    expect(entry(space, 'post-second').status).toBe('draft');
    expect(entry(space, 'cat-old').status).toBe('draft');
    expect(space.findings.warnings).toEqual(
      expect.arrayContaining([
        'published entries with newer unpublished changes are imported as drafts',
        'archived entries are imported as drafts',
      ]),
    );
  });

  it('leaves out an entry that would fail validation, and whatever requires a link to it', async () => {
    const space = await read();
    const invalid = new Map(space.findings.invalidEntries.map((i) => [i.entry, i.messages]));
    expect(invalid.get('post-untitled')).toEqual(['title (en-US): Field is required']);
    expect(invalid.get('post-copy')).toEqual(['slug (en-US): same value as entry post-hello']);
    // Valid on its own, but its required link pointed at post-untitled.
    expect(invalid.get('landing-broken')).toEqual([
      'featuredPost (en-US): Field is required',
      'featuredPost: links entry post-untitled, which is not imported',
    ]);
    expect(space.entries.map((e) => e.sourceId).sort()).toEqual([
      'author-ada',
      'author-grace',
      'cat-guides',
      'cat-news',
      'cat-old',
      'landing-home',
      'post-hello',
      'post-second',
    ]);
    expect(space.entriesRead).toBe(11);
  });

  it('keeps only the default locale for a field that is not localized, and every declared one for a localized field', async () => {
    const space = await read();
    expect(entry(space, 'post-hello').fields.title).toEqual({
      'en-US': 'Hello, edge',
      'de-DE': 'Hallo, Edge',
    });
    expect(entry(space, 'post-second').fields.title).toEqual({
      'en-US': 'The second post',
      'fr-FR': 'Le deuxième article',
    });
    expect(entry(space, 'author-ada').fields.location).toEqual({
      'en-US': { lat: 52.52, lon: 13.405 },
    });
  });

  it('carries entry tags by their export id', async () => {
    const space = await read();
    expect(space.tags).toEqual([
      { id: 'featured', name: 'Featured', slug: '', description: null, labels: {} },
      { id: 'engineering', name: 'Engineering', slug: '', description: null, labels: {} },
    ]);
    expect(entry(space, 'post-hello').tags).toEqual(['featured']);
    expect(entry(space, 'cat-news').tags).toEqual(['engineering']);
  });
});

describe('space export reader: rich text', () => {
  it('maps the node tree one to one, remapping embedded and linked targets', async () => {
    const space = await read();
    const body = entry(space, 'post-hello').fields.body?.['en-US'] as {
      content: { nodeType: string; data: Record<string, unknown>; content?: unknown[] }[];
    };
    expect(validateRichText(body)).toEqual([]);
    expect(body.content.map((n) => n.nodeType)).toEqual([
      'heading-2',
      'paragraph',
      'embedded-asset-block',
      'unordered-list',
      'table',
      'embedded-entry-block',
      'paragraph',
      'paragraph',
      'hr',
      'paragraph',
    ]);
    expect(body.content[2]?.data).toEqual({
      target: { id: idOf(space, 'asset-hero'), linkType: 'Asset' },
    });
    expect(body.content[5]?.data).toEqual({
      target: { id: idOf(space, 'author-ada'), linkType: 'Entry' },
    });
    const intro = body.content[1]?.content as {
      nodeType: string;
      data?: unknown;
      marks?: unknown;
    }[];
    expect(intro[3]).toMatchObject({
      nodeType: 'text',
      marks: [{ type: 'italic' }, { type: 'code' }],
    });
    expect(intro[5]).toMatchObject({
      nodeType: 'hyperlink',
      data: { uri: 'https://example.com/guide' },
    });
    expect(intro[7]).toMatchObject({
      nodeType: 'entry-hyperlink',
      data: { target: { id: idOf(space, 'post-second'), linkType: 'Entry' } },
    });
    // Nothing anywhere in it is HTML.
    expect(JSON.stringify(body)).not.toMatch(/<[a-z]/i);
  });

  it('turns a node with no equivalent into a paragraph, and drops an embed of a missing entry', async () => {
    const space = await read();
    const body = entry(space, 'post-hello').fields.body?.['en-US'] as {
      content: { nodeType: string; content?: { nodeType: string; value?: string }[] }[];
    };
    // "See " survives; the inline embed of post-gone does not.
    expect(body.content[6]?.content).toEqual([
      { nodeType: 'text', value: 'See ', marks: [], data: {} },
    ]);
    // The resource block became an (empty) paragraph.
    expect(body.content[7]).toMatchObject({ nodeType: 'paragraph' });
    expect(space.findings.warnings).toContain(
      'entry post-hello body (en-US): 1 "embedded-resource-block" node(s) have no equivalent; kept as plain text',
    );
  });

  it('keeps the words of a link whose target is not imported, and of an unsafe hyperlink', async () => {
    const doc = spaceExportFixture();
    const entries = doc.entries as { sys: { id: string }; fields: Record<string, unknown> }[];
    const hello = entries.find((e) => e.sys.id === 'post-hello');
    if (!hello) throw new Error('fixture changed');
    hello.fields.body = {
      'en-US': {
        nodeType: 'document',
        data: {},
        content: [
          {
            nodeType: 'paragraph',
            data: {},
            content: [
              {
                nodeType: 'entry-hyperlink',
                data: { target: { sys: { type: 'Link', linkType: 'Entry', id: 'nowhere' } } },
                content: [{ nodeType: 'text', value: 'gone', marks: [], data: {} }],
              },
              {
                nodeType: 'hyperlink',
                data: { uri: 'javascript:alert(1)' },
                content: [{ nodeType: 'text', value: ' click', marks: [], data: {} }],
              },
            ],
          },
        ],
      },
    };
    const space = await read(doc);
    const body = entry(space, 'post-hello').fields.body?.['en-US'] as {
      content: { content: { nodeType: string; value?: string }[] }[];
    };
    expect(body.content[0]?.content.map((n) => [n.nodeType, n.value])).toEqual([
      ['text', 'gone'],
      ['text', ' click'],
    ]);
    expect(validateRichText(body)).toEqual([]);
  });

  it('reports a document whose converted shape is still invalid, and leaves that entry out', async () => {
    const doc = spaceExportFixture();
    const entries = doc.entries as { sys: { id: string }; fields: Record<string, unknown> }[];
    const grace = entries.find((e) => e.sys.id === 'post-copy');
    if (!grace) throw new Error('fixture changed');
    grace.fields.slug = { 'en-US': 'unique-now' };
    grace.fields.body = {
      'en-US': {
        nodeType: 'document',
        data: {},
        content: [{ nodeType: 'table', data: {}, content: [] }],
      },
    };
    const space = await read(doc);
    expect(space.findings.invalidEntries.find((i) => i.entry === 'post-copy')?.messages).toEqual([
      'body (en-US): content[0]: table must have at least one table-row',
    ]);
  });
});

describe('space export reader: assets', () => {
  it('reads each asset with a file, absolute URL and details, and skips one never processed', async () => {
    const space = await read();
    expect(space.assetsRead).toBe(4);
    const hero = space.assets.find((a) => a.sourceId === 'asset-hero');
    expect(hero).toMatchObject({
      status: 'published',
      title: { 'en-US': 'Edge map', 'de-DE': 'Edge-Karte' },
      file: {
        url: 'https://assets.example.com/space-a/asset-hero/edge-map.png',
        fileName: 'edge-map.png',
        contentType: 'image/png',
        size: 2048,
        width: 1200,
        height: 630,
      },
    });
    expect(space.assets.find((a) => a.sourceId === 'asset-doc')?.status).toBe('draft');
    expect(space.assets.some((a) => a.sourceId === 'asset-unprocessed')).toBe(false);
    expect(space.findings.warnings).toEqual(
      expect.arrayContaining([
        'Asset asset-unprocessed has no file URL and was skipped',
        'Asset asset-hero has a file per locale; the en-US one is imported (an asset here has one file)',
      ]),
    );
  });
});

describe('space export reader: refusals', () => {
  it('refuses what is not JSON, not a space export, or has no default locale', async () => {
    const opts = { newId: () => 'x', locales: ['en-US'] };
    await expect(reader.read('{', opts)).rejects.toThrow(/Not valid JSON/);
    await expect(reader.read('[]', opts)).rejects.toThrow(/Not a space export/);
    await expect(
      reader.read(JSON.stringify({ contentTypes: [], locales: [] }), opts),
    ).rejects.toThrow(/no default locale/);
  });
});
