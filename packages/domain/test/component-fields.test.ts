import { describe, expect, it } from 'vitest';
import {
  applyDefaults,
  ConflictError,
  type ContentType,
  defineContentType,
  extractReferences,
  type FieldDefinition,
  MAX_COMPONENT_DEPTH,
  ValidationError,
  validateEntryFields,
} from '../src/index';

const vctx = { defaultLocale: 'en-US', locales: ['en-US', 'de-DE'] };

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

/** A card: the shape this whole feature exists for. */
const CARD_FIELDS: FieldDefinition[] = [
  field({ apiId: 'title', type: 'Symbol', required: true }),
  field({ apiId: 'body', type: 'Text', position: 1 }),
  field({ apiId: 'image', type: 'Link', linkType: 'Asset', position: 2 }),
];

const typeWith = (fields: FieldDefinition[]): ContentType =>
  defineContentType({
    apiId: 'page',
    name: 'Page',
    displayField: fields[0]?.apiId ?? '',
    fields,
  });

const componentField = (over: Partial<FieldDefinition> = {}) =>
  field({ apiId: 'hero', type: 'Component', fields: CARD_FIELDS, ...over });

const repeaterField = (over: Partial<FieldDefinition> = {}) =>
  field({
    apiId: 'cards',
    type: 'Array',
    items: { type: 'Component', fields: CARD_FIELDS },
    ...over,
  });

/**
 * The reason a definition was refused.
 *
 * `ValidationError.message` is the generic "one or more fields are invalid" —
 * the actionable text lives in `issues`, which is what the API serializes.
 */
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return err instanceof ValidationError ? (err.issues[0]?.message ?? '') : String(err);
  }
  return '';
};

const check = (ct: ContentType, apiId: string, value: unknown) =>
  validateEntryFields(ct, { [apiId]: { 'en-US': value } }, vctx);

describe('defining a component', () => {
  it('accepts a group of nested typed fields', () => {
    expect(() => typeWith([componentField()])).not.toThrow();
  });

  it('accepts an array of them — the repeater shape', () => {
    expect(() =>
      typeWith([field({ apiId: 'title', type: 'Symbol' }), repeaterField()]),
    ).not.toThrow();
  });

  it('refuses a component with no fields', () => {
    // An empty component is a field that renders nothing and stores nothing.
    expect(() => typeWith([componentField({ fields: [] })])).toThrow(ValidationError);
  });

  it('refuses nested fields on a type that has none', () => {
    // Declaring a shape here means the author expected nesting they won't get.
    expect(
      refusal(() => typeWith([field({ apiId: 'title', type: 'Symbol', fields: CARD_FIELDS })])),
    ).toMatch(/cannot define nested fields/);
  });

  it('refuses duplicate apiIds within one component, naming the path', () => {
    const dupes = [
      field({ apiId: 'title', type: 'Symbol' }),
      field({ apiId: 'title', type: 'Text' }),
    ];
    expect(() => typeWith([componentField({ fields: dupes })])).toThrow(ConflictError);
    expect(() => typeWith([componentField({ fields: dupes })])).toThrow(/hero\.title/);
  });

  it('lets the same apiId appear in different components', () => {
    // Scoping is per component; `title` inside a card is not the entry's title.
    expect(() =>
      typeWith([field({ apiId: 'title', type: 'Symbol' }), componentField({ position: 1 })]),
    ).not.toThrow();
  });

  it('screens unsafe regexes inside components too', () => {
    const evil = field({
      apiId: 'title',
      type: 'Symbol',
      validations: { regexp: { pattern: '(a+)+$' } },
    });
    // Nesting must not be a way around the ReDoS screen on the write path.
    expect(() => typeWith([componentField({ fields: [evil] })])).toThrow(ValidationError);
  });
});

describe('what a nested field may not be', () => {
  it('refuses a nested field that localizes itself', () => {
    const inner = field({ apiId: 'title', type: 'Symbol', localized: true });
    // One card in a list being German while its sibling is not is a shape no
    // editor can express and no fallback chain can resolve.
    expect(refusal(() => typeWith([componentField({ fields: [inner] })]))).toMatch(
      /cannot be localized/,
    );
  });

  it('refuses a nested unique field', () => {
    const inner = field({ apiId: 'title', type: 'Symbol', unique: true });
    // There is no row to write for the third card's title, so the constraint
    // backing `unique` could never be enforced.
    expect(refusal(() => typeWith([componentField({ fields: [inner] })]))).toMatch(
      /cannot be unique/,
    );
  });

  it('refuses a nested Slug', () => {
    const inner = field({ apiId: 'path', type: 'Slug' });
    // Slugs are normalized by walking top-level fields; a nested one would be
    // stored exactly as typed and then fail its own validation.
    expect(refusal(() => typeWith([componentField({ fields: [inner] })]))).toMatch(
      /Slug cannot live/,
    );
  });

  it('still allows those attributes on the component field itself', () => {
    expect(() => typeWith([componentField({ localized: true })])).not.toThrow();
  });
});

describe('nesting depth', () => {
  const nest = (depth: number): FieldDefinition => {
    let inner: FieldDefinition = field({ apiId: 'leaf', type: 'Symbol' });
    for (let i = 0; i < depth; i += 1) {
      inner = field({ apiId: `level${i}`, type: 'Component', fields: [inner] });
    }
    return inner;
  };

  it(`allows ${MAX_COMPONENT_DEPTH} levels`, () => {
    expect(() => typeWith([nest(MAX_COMPONENT_DEPTH)])).not.toThrow();
  });

  it('refuses one more, and says what to do instead', () => {
    // Every consumer walks this tree; unbounded means each is a way to hang.
    expect(refusal(() => typeWith([nest(MAX_COMPONENT_DEPTH + 1)]))).toMatch(/link to it/);
  });
});

describe('validating a component value', () => {
  const ct = typeWith([componentField()]);

  it('accepts a well-formed object', () => {
    expect(check(ct, 'hero', { title: 'Hello', body: 'World' })).toHaveLength(0);
  });

  it('rejects a non-object', () => {
    expect(check(ct, 'hero', 'just a string').length).toBeGreaterThan(0);
    expect(check(ct, 'hero', ['a', 'b']).length).toBeGreaterThan(0);
  });

  it('validates each nested value against its own definition', () => {
    const issues = check(ct, 'hero', { title: 42 });
    expect(issues[0]?.message).toMatch(/string/i);
  });

  it('addresses an issue by path, not by the outer field', () => {
    // "Something in hero is wrong" is not actionable; "hero.title" is.
    expect(check(ct, 'hero', { title: 42 })[0]?.field).toBe('hero.title');
  });

  it('enforces required on nested fields', () => {
    expect(check(ct, 'hero', { body: 'no title' })[0]?.field).toBe('hero.title');
  });

  it('rejects a nested key the component does not define', () => {
    const issues = check(ct, 'hero', { title: 'ok', sneaky: 'value' });
    expect(issues.map((i) => i.field)).toContain('hero.sneaky');
  });

  it('reports the locale it was checked under', () => {
    const localized = typeWith([componentField({ localized: true })]);
    const issues = validateEntryFields(localized, { hero: { 'de-DE': { title: 9 } } }, vctx);
    expect(issues.find((i) => i.field === 'hero.title')?.locale).toBe('de-DE');
  });
});

describe('validating a repeater', () => {
  const ct = typeWith([field({ apiId: 'title', type: 'Symbol' }), repeaterField({ position: 1 })]);

  it('accepts a list of components', () => {
    expect(check(ct, 'cards', [{ title: 'One' }, { title: 'Two' }])).toHaveLength(0);
  });

  it('says which item is wrong', () => {
    // Eight cards on screen and one of them broken: the index is the message.
    const issues = check(ct, 'cards', [{ title: 'One' }, { title: 'Two' }, { body: 'oops' }]);
    expect(issues[0]?.field).toBe('cards[2].title');
  });

  it('enforces required inside every item, not just the first', () => {
    const issues = check(ct, 'cards', [{ title: 'One' }, {}]);
    expect(issues.map((i) => i.field)).toEqual(['cards[1].title']);
  });

  it('still enforces the array size validation', () => {
    const bounded = typeWith([
      field({ apiId: 'title', type: 'Symbol' }),
      repeaterField({ position: 1, validations: { size: { max: 2 } } }),
    ]);
    expect(check(bounded, 'cards', [{ title: '1' }, { title: '2' }, { title: '3' }]).length).toBe(
      1,
    );
  });
});

describe('links inside components', () => {
  const ct = typeWith([componentField(), repeaterField({ position: 1 })]);

  it('materializes an edge for a link nested in a component', () => {
    // Without this, referential integrity and cache invalidation would quietly
    // stop covering anything modeled as a component.
    const edges = extractReferences(
      'e1',
      { hero: { 'en-US': { title: 'x', image: { id: 'a1', linkType: 'Asset' } } } },
      ct,
    );
    expect(edges).toEqual([{ fromEntryId: 'e1', fromField: 'hero', toId: 'a1', toType: 'Asset' }]);
  });

  it('finds links in every item of a repeater', () => {
    const edges = extractReferences(
      'e1',
      {
        cards: {
          'en-US': [
            { title: 'a', image: { id: 'a1', linkType: 'Asset' } },
            { title: 'b', image: { id: 'a2', linkType: 'Asset' } },
          ],
        },
      },
      ct,
    );
    expect(edges.map((e) => e.toId).sort()).toEqual(['a1', 'a2']);
  });

  it('attributes edges to the top-level field, not the nested path', () => {
    // An edge answers "does anything link to this" and "whose caches does
    // publishing invalidate"; neither is improved by knowing it was card 3.
    const edges = extractReferences(
      'e1',
      { cards: { 'en-US': [{ image: { id: 'a1', linkType: 'Asset' } }] } },
      ct,
    );
    expect(edges[0]?.fromField).toBe('cards');
  });

  it('deduplicates the same target linked from several items', () => {
    const edges = extractReferences(
      'e1',
      {
        cards: {
          'en-US': [
            { image: { id: 'a1', linkType: 'Asset' } },
            { image: { id: 'a1', linkType: 'Asset' } },
          ],
        },
      },
      ct,
    );
    expect(edges).toHaveLength(1);
  });
});

describe('defaults inside components', () => {
  const withDefault = [
    field({ apiId: 'title', type: 'Symbol', required: true }),
    field({ apiId: 'variant', type: 'Symbol', position: 1, defaultValue: 'primary' }),
  ];

  it('fills a gap in a component the author supplied', () => {
    const ct = typeWith([componentField({ fields: withDefault })]);
    const out = applyDefaults(ct, { hero: { 'en-US': { title: 'Hi' } } }, ['en-US'], 'en-US');
    expect(out.hero?.['en-US']).toEqual({ title: 'Hi', variant: 'primary' });
  });

  it('fills every item of a repeater', () => {
    const ct = typeWith([
      field({ apiId: 'title', type: 'Symbol' }),
      repeaterField({ position: 1, items: { type: 'Component', fields: withDefault } }),
    ]);
    const out = applyDefaults(
      ct,
      { cards: { 'en-US': [{ title: 'a' }, { title: 'b', variant: 'ghost' }] } },
      ['en-US'],
      'en-US',
    );
    // The one that stated a variant keeps it; the other gets the default.
    expect(out.cards?.['en-US']).toEqual([
      { title: 'a', variant: 'primary' },
      { title: 'b', variant: 'ghost' },
    ]);
  });

  it('does not invent a component the author never supplied', () => {
    const ct = typeWith([componentField({ fields: withDefault })]);
    const out = applyDefaults(ct, {}, ['en-US'], 'en-US');
    // Materializing one from its nested defaults would create content nobody
    // asked for — and, with a required nested field, unsaveable content.
    expect(out.hero).toBeUndefined();
  });
});
