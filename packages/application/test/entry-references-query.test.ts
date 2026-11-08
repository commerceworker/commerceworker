import { type FieldDefinition, ValidationError } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  listPreviewEntries,
  listPublishedEntries,
  parseEntryQuery,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  updateEntry,
} from '../src/index';

// Filter by referenced entry: `fields.<link>[ref]`, `[refIn]` and `links_to_entry`, parsed from
// the query string and answered on the published (Delivery) and draft (Preview) paths.

const scope = { spaceId: 'space-1', environmentId: 'main' };
const other = { spaceId: 'space-2', environmentId: 'main' };

const sym = (apiId: string, position: number): FieldDefinition => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required: false,
  position,
});

const link = (id: string) => ({ id, linkType: 'Entry' });
const doc = (id: string) => ({
  nodeType: 'document',
  data: {},
  content: [{ nodeType: 'embedded-entry-block', data: { target: link(id) }, content: [] }],
});

async function seed(ctx: AppContext, s = scope) {
  await createContentType(ctx, SYSTEM_CALLER, s, {
    apiId: 'person',
    name: 'Person',
    displayField: 'name',
    fields: [sym('name', 0)],
  });
  await createContentType(ctx, SYSTEM_CALLER, s, {
    apiId: 'post',
    name: 'Post',
    displayField: 'title',
    fields: [
      sym('title', 0),
      {
        apiId: 'author',
        name: 'Author',
        type: 'Link',
        linkType: 'Entry',
        localized: false,
        required: false,
        position: 1,
      },
      {
        apiId: 'related',
        name: 'Related',
        type: 'Array',
        items: { type: 'Link', linkType: 'Entry' },
        localized: false,
        required: false,
        position: 2,
      },
      {
        apiId: 'body',
        name: 'Body',
        type: 'RichText',
        localized: false,
        required: false,
        position: 3,
      },
      { ...sym('data', 4), type: 'JSON' },
    ],
  });
  await publishContentType(ctx, s, 'person');
  await publishContentType(ctx, s, 'post');
  const person = async (name: string) => {
    const e = await createEntry(ctx, s, {
      contentTypeApiId: 'person',
      fields: { name: { 'en-US': name } },
    });
    await publishEntry(ctx, s, e.entry.id);
    return e.entry.id;
  };
  const ann = await person('Ann');
  const bob = await person('Bob');
  const post = async (title: string, f: Record<string, unknown>) => {
    const e = await createEntry(ctx, s, {
      contentTypeApiId: 'post',
      fields: {
        title: { 'en-US': title },
        ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { 'en-US': v }])),
      } as never,
    });
    await publishEntry(ctx, s, e.entry.id);
    return e.entry.id;
  };
  await post('By Ann', { author: link(ann) });
  await post('By Bob', { author: link(bob), related: [link(ann)] });
  await post('Mentions Ann', { body: doc(ann) });
  await post('Nobody', {});
  // A link-shaped value in a JSON field is data, not a link: the reference edges skip it.
  await post('JSON lookalike', { data: { nested: link(ann) } });
  return { ann, bob };
}

/** The titles a Delivery list returns, sorted (publish order ties on the fixed clock). */
const published = async (ctx: AppContext, qs: string, s = scope) =>
  (await listPublishedEntries(ctx, s, parseEntryQuery(new URLSearchParams(qs))))
    .map((e) => (e.fields.title as Record<string, string>)['en-US'])
    .sort();

describe('filter by referenced entry', () => {
  let ctx: AppContext;
  let ids: { ann: string; bob: string };
  beforeEach(async () => {
    const store = new InMemoryContentStore();
    store.seedSpace({ spaceId: scope.spaceId, defaultLocale: 'en-US', locales: ['en-US'] });
    store.seedSpace({ spaceId: other.spaceId, defaultLocale: 'en-US', locales: ['en-US'] });
    ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
    ids = await seed(ctx);
  });

  it('parses fields.<link>[ref], [refIn] and links_to_entry', () => {
    expect(parseEntryQuery(new URLSearchParams('fields.author[ref]=a')).filters).toEqual([
      { field: 'author', op: 'ref', value: 'a' },
    ]);
    expect(parseEntryQuery(new URLSearchParams('fields.author[refIn]=a,b')).filters).toEqual([
      { field: 'author', op: 'refIn', value: ['a', 'b'] },
    ]);
    expect(parseEntryQuery(new URLSearchParams('links_to_entry=a,b')).filters).toEqual([
      { field: '*', op: 'refIn', value: ['a', 'b'] },
    ]);
  });

  it('refuses an empty id rather than matching nothing silently', () => {
    for (const qs of ['fields.author[ref]=', 'fields.title[refIn]=,', 'links_to_entry=a"b']) {
      expect(() => parseEntryQuery(new URLSearchParams(qs)), qs).toThrow(ValidationError);
    }
    // An empty links_to_entry is no filter at all, as a tool call without linksToEntry is.
    expect(parseEntryQuery(new URLSearchParams('links_to_entry=')).filters).toBeUndefined();
  });

  it('Delivery: a link field holding the entry, and any field for links_to_entry', async () => {
    expect(await published(ctx, `content_type=post&fields.author[ref]=${ids.ann}`)).toEqual([
      'By Ann',
    ]);
    expect(
      await published(ctx, `content_type=post&fields.author[refIn]=${ids.ann},${ids.bob}`),
    ).toEqual(['By Ann', 'By Bob']);
    expect(await published(ctx, `content_type=post&fields.related[ref]=${ids.ann}`)).toEqual([
      'By Bob',
    ]);
    expect(await published(ctx, `content_type=post&links_to_entry=${ids.ann}`)).toEqual([
      'By Ann',
      'By Bob',
      'Mentions Ann',
    ]);
  });

  it('Preview reads the draft: an unpublished relink counts there and not on Delivery', async () => {
    const [nobody] = await listPreviewEntries(ctx, scope, {
      contentTypeApiId: 'post',
      filters: [{ field: 'title', op: 'eq', value: 'Nobody' }],
    });
    await updateEntry(
      ctx,
      scope,
      nobody?.id as string,
      {
        title: { 'en-US': 'Nobody' },
        author: { 'en-US': link(ids.bob) },
      } as never,
    );
    const draft = await listPreviewEntries(ctx, scope, {
      contentTypeApiId: 'post',
      ...parseEntryQuery(new URLSearchParams(`fields.author[ref]=${ids.bob}`)),
    });
    expect(draft.map((e) => (e.fields.title as Record<string, string>)['en-US']).sort()).toEqual([
      'By Bob',
      'Nobody',
    ]);
    expect(await published(ctx, `content_type=post&fields.author[ref]=${ids.bob}`)).toEqual([
      'By Bob',
    ]);
  });

  it('sees nothing of another space linking to the same id', async () => {
    await seed(ctx, other);
    expect(await published(ctx, `content_type=post&links_to_entry=${ids.ann}`, other)).toEqual([]);
  });
});
