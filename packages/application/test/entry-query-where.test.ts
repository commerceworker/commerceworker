import { type FieldDefinition, ValidationError } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  listPreviewEntries,
  listPublishedEntries,
  MAX_WHERE_LENGTH,
  mergeWhereJson,
  parseEntryQuery,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
} from '../src/index';

// Richer queries from the query string: startsWith, between, component paths and `where` groups.

const scope = { spaceId: 'space-1', environmentId: 'main' };

const field = (apiId: string, type: FieldDefinition['type'], position: number) =>
  ({ apiId, name: apiId, type, localized: false, required: false, position }) as FieldDefinition;

async function seed(ctx: AppContext) {
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    fields: [
      field('title', 'Symbol', 0),
      field('views', 'Integer', 1),
      {
        ...field('seo', 'Component', 2),
        fields: [field('title', 'Symbol', 0), field('rank', 'Integer', 1)],
      },
    ],
  });
  await publishContentType(ctx, scope, 'page');
  for (const [title, views, seoTitle] of [
    ['Apple', 10, 'Buy apples'],
    ['Apricot', 30, 'Apricots'],
    ['Banana', 50, 'Bananas'],
    ['Cherry', 70, 'Cherries'],
  ] as const) {
    const e = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: {
        title: { 'en-US': title },
        views: { 'en-US': views },
        seo: { 'en-US': { title: seoTitle, rank: views / 10 } },
      },
    });
    await publishEntry(ctx, scope, e.entry.id);
  }
}

const titles = (rows: { fields: Record<string, unknown> }[]) =>
  rows.map((e) => (e.fields.title as Record<string, string>)['en-US']).sort();

const q = (qs: string) => parseEntryQuery(new URLSearchParams(`content_type=page&${qs}`));

describe('richer queries from the query string', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    const store = new InMemoryContentStore();
    store.seedSpace({ spaceId: scope.spaceId, defaultLocale: 'en-US', locales: ['en-US'] });
    ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
    await seed(ctx);
  });

  it('startsWith, between and a component path, on Delivery and Preview alike', async () => {
    for (const [qs, want] of [
      ['fields.title[startsWith]=ap', ['Apple', 'Apricot']],
      ['fields.views[between]=30,50', ['Apricot', 'Banana']],
      ['fields.seo.title[match]=apri', ['Apricot']],
      ['fields.seo.rank[gte]=5', ['Banana', 'Cherry']],
    ] as const) {
      expect(titles(await listPublishedEntries(ctx, scope, q(qs))), qs).toEqual(want);
      expect(titles(await listPreviewEntries(ctx, scope, q(qs))), qs).toEqual(want);
    }
  });

  it('a where parameter ORs groups, ANDed with the other filters', async () => {
    const where = JSON.stringify({
      or: [
        { field: 'fields.title', op: 'startsWith', value: 'Ch' },
        { field: 'fields.seo.title', op: 'eq', value: 'Buy apples' },
      ],
    });
    expect(titles(await listPublishedEntries(ctx, scope, q(`where=${where}`)))).toEqual([
      'Apple',
      'Cherry',
    ]);
    expect(
      titles(
        await listPublishedEntries(
          ctx,
          scope,
          q(`where=${encodeURIComponent(where)}&fields.views[lt]=50`),
        ),
      ),
    ).toEqual(['Apple']);
  });

  it('refuses where that is not JSON, too long, or malformed, naming the parameter', () => {
    for (const raw of [
      '{or:',
      JSON.stringify({ or: [{ field: 'title', op: 'nope', value: 1 }] }),
      JSON.stringify({ field: 'title', value: 'x'.repeat(MAX_WHERE_LENGTH) }),
    ]) {
      try {
        q(`where=${encodeURIComponent(raw)}`);
        expect.unreachable(raw);
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        expect((e as ValidationError).issues[0]?.field).toMatch(/^where/);
      }
    }
  });

  it('repeated where parameters AND together, within one budget', async () => {
    const a = encodeURIComponent(
      JSON.stringify({ field: 'fields.title', op: 'startsWith', value: 'A' }),
    );
    const b = encodeURIComponent(JSON.stringify({ field: 'fields.views', op: 'gte', value: 20 }));
    expect(titles(await listPublishedEntries(ctx, scope, q(`where=${a}&where=${b}`)))).toEqual([
      'Apricot',
    ]);
    // Twelve predicates each: under the cap alone, over it together.
    const twelve = encodeURIComponent(
      JSON.stringify({ or: Array(12).fill({ field: 'title', value: 'x' }) }),
    );
    expect(() => q(`where=${twelve}`)).not.toThrow();
    expect(() => q(`where=${twelve}&where=${twelve}`)).toThrow(ValidationError);
  });

  it('an empty where is absent, as it was before where existed', () => {
    expect(q('where=').where).toBeUndefined();
    expect(q('where=%20&fields.title=Apple').filters).toHaveLength(1);
  });

  it('merges trees without adding a level: an AND joins the root', () => {
    const leaf = { field: 'title', value: 'x' };
    expect(mergeWhereJson([{ or: [leaf] }])).toEqual({ or: [leaf] });
    expect(mergeWhereJson([{ and: [leaf, leaf] }, { or: [leaf] }])).toEqual({
      and: [leaf, leaf, { or: [leaf] }],
    });
  });

  it('keeps what the API accepted before: an empty match, a long in list', async () => {
    // `fields.x[match]=` is what the admin's filter bar and the SDK send for "has a value".
    expect(titles(await listPublishedEntries(ctx, scope, q('fields.title[match]=')))).toEqual([
      'Apple',
      'Apricot',
      'Banana',
      'Cherry',
    ]);
    expect(titles(await listPreviewEntries(ctx, scope, q('fields.title[match]=')))).toHaveLength(4);
    const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`).join(',');
    expect(q(`sys.id[in]=${ids}`).filters?.[0]?.value).toHaveLength(150);
  });

  it('answers any number of top-level component paths, and caps them only inside where', async () => {
    const five = [
      'fields.seo.title[match]=a',
      'fields.seo.title[ne]=x',
      'fields.seo.rank[gte]=2',
      'fields.seo.rank[lte]=5',
      'fields.seo.title[exists]=true',
    ].join('&');
    expect(titles(await listPublishedEntries(ctx, scope, q(five)))).toEqual(['Apricot', 'Banana']);
    expect(titles(await listPreviewEntries(ctx, scope, q(five)))).toEqual(['Apricot', 'Banana']);
    const where = encodeURIComponent(
      JSON.stringify({ and: Array(5).fill({ field: 'seo.title', op: 'exists' }) }),
    );
    expect(() => q(`where=${where}`)).toThrow(ValidationError);
  });

  it('refuses a between without two bounds', () => {
    expect(() => q('fields.views[between]=1')).toThrow(ValidationError);
  });
});
