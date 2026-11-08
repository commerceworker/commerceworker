import { describe, expect, it } from 'vitest';
import {
  applyDefaults,
  assignBlockKeys,
  type ComponentVariant,
  type ContentType,
  defineContentType,
  extractReferences,
  type FieldDefinition,
  MAX_COMPONENT_DEPTH,
  nestedFieldsFor,
  removedFields,
  removedFieldUses,
  removedVariants,
  removedVariantUses,
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

const HERO: ComponentVariant = {
  apiId: 'hero',
  name: 'Hero',
  fields: [
    field({ apiId: 'heading', type: 'Symbol', required: true }),
    field({ apiId: 'image', type: 'Link', linkType: 'Asset', position: 1 }),
  ],
};
const CTA: ComponentVariant = {
  apiId: 'cta',
  name: 'Call to action',
  fields: [
    field({ apiId: 'label', type: 'Symbol', required: true, defaultValue: 'Learn more' }),
    field({ apiId: 'target', type: 'Link', linkType: 'Entry', position: 1 }),
  ],
};

const blocksField = (variants: readonly ComponentVariant[] = [HERO, CTA], over = {}) =>
  field({ apiId: 'body', type: 'Array', items: { type: 'Component', variants }, ...over });

const typeWith = (fields: FieldDefinition[]): ContentType =>
  defineContentType({
    apiId: 'landing',
    name: 'Landing',
    displayField: 'title',
    fields: fields.some((f) => f.apiId === 'title')
      ? fields
      : [field({ apiId: 'title', type: 'Symbol', position: -1 }), ...fields],
  });

const LANDING = typeWith([field({ apiId: 'title', type: 'Symbol' }), blocksField()]);

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return err instanceof ValidationError ? (err.issues[0]?.message ?? '') : String(err);
  }
  return '';
};

const body = (value: unknown) =>
  validateEntryFields(LANDING, { body: { 'en-US': value } }, vctx).map((i) => ({
    field: i.field,
    message: i.message,
  }));

describe('defining a blocks field', () => {
  it('accepts an Array of Component with named variants', () => {
    expect(() =>
      typeWith([field({ apiId: 'title', type: 'Symbol' }), blocksField()]),
    ).not.toThrow();
  });

  it('needs at least one variant', () => {
    expect(refusal(() => typeWith([blocksField([])]))).toMatch(/at least one variant/);
  });

  it('refuses a variant apiId that could not be a field apiId', () => {
    const bad = { ...HERO, apiId: '_hero' };
    expect(refusal(() => typeWith([blocksField([bad])]))).toMatch(/Invalid variant apiId "_hero"/);
  });

  it('refuses two variants with one apiId', () => {
    expect(refusal(() => typeWith([blocksField([HERO, { ...CTA, apiId: 'hero' }])]))).toMatch(
      /Duplicate variant apiId "hero"/,
    );
  });

  it('refuses a variant without fields', () => {
    expect(refusal(() => typeWith([blocksField([{ ...HERO, fields: [] }])]))).toMatch(
      /variant must define at least one field/,
    );
  });

  it('refuses items.fields and items.variants together', () => {
    const both = field({
      apiId: 'body',
      type: 'Array',
      items: { type: 'Component', fields: HERO.fields, variants: [HERO] },
    });
    expect(refusal(() => typeWith([both]))).toMatch(/not both/);
  });

  it('keeps variants off a single Component: a one-block slot is size.max 1', () => {
    const single = field({
      apiId: 'slot',
      type: 'Component',
      fields: HERO.fields,
      items: { type: 'Component', variants: [HERO] },
    });
    expect(refusal(() => typeWith([single]))).toMatch(/size.max of 1/);
  });

  it('refuses variants on an array of something else', () => {
    const links = field({
      apiId: 'links',
      type: 'Array',
      items: { type: 'Link', variants: [HERO] } as never,
    });
    expect(refusal(() => typeWith([links]))).toMatch(/cannot define nested fields/);
  });

  it("holds a variant's fields to the nested rules", () => {
    const localized = { ...HERO, fields: [field({ apiId: 'x', type: 'Symbol', localized: true })] };
    expect(refusal(() => typeWith([blocksField([localized])]))).toMatch(/cannot be localized/);
    const slug = { ...HERO, fields: [field({ apiId: 'x', type: 'Slug' })] };
    expect(refusal(() => typeWith([blocksField([slug])]))).toMatch(/Slug cannot live/);
    const unique = { ...HERO, fields: [field({ apiId: 'x', type: 'Symbol', unique: true })] };
    expect(refusal(() => typeWith([blocksField([unique])]))).toMatch(/cannot be unique/);
  });

  it('names the variant in the path of a nested refusal', () => {
    const slug = { ...HERO, fields: [field({ apiId: 'x', type: 'Slug' })] };
    try {
      typeWith([blocksField([slug])]);
    } catch (err) {
      expect((err as ValidationError).issues[0]?.field).toBe('body[hero].x');
    }
  });

  it("counts a variant's fields toward the depth cap", () => {
    // MAX_COMPONENT_DEPTH levels including the blocks field itself is fine;
    // one more is refused, exactly as for a plain component.
    let inner: FieldDefinition = field({ apiId: 'leaf', type: 'Symbol' });
    for (let d = 1; d < MAX_COMPONENT_DEPTH; d++) {
      inner = field({ apiId: `c${d}`, type: 'Component', fields: [inner] });
    }
    const ok = blocksField([{ apiId: 'deep', name: 'Deep', fields: [inner] }]);
    expect(() => typeWith([ok])).not.toThrow();
    const tooDeep = blocksField([
      {
        apiId: 'deep',
        name: 'Deep',
        fields: [field({ apiId: 'extra', type: 'Component', fields: [inner] })],
      },
    ]);
    expect(refusal(() => typeWith([tooDeep]))).toMatch(/nest 3 deep at most/);
  });
});

describe('validating blocks', () => {
  it('accepts blocks of any declared variant, in any order', () => {
    expect(
      body([
        { _type: 'cta', _key: 'a', label: 'Go' },
        { _type: 'hero', _key: 'b', heading: 'Hello' },
        { _type: 'cta', label: 'Again' },
      ]),
    ).toEqual([]);
  });

  it('reports a missing _type at the block', () => {
    expect(body([{ heading: 'x' }])).toEqual([
      { field: 'body[0]', message: 'Block is missing _type (one of: hero, cta)' },
    ]);
  });

  it('reports an unknown _type at the block', () => {
    expect(
      body([
        { _type: 'hero', heading: 'ok' },
        { _type: 'quote', text: 'x' },
      ]),
    ).toEqual([{ field: 'body[1]', message: 'Unknown block type "quote" (one of: hero, cta)' }]);
  });

  it("checks a block against its own variant's fields", () => {
    expect(body([{ _type: 'cta', heading: 'wrong shape' }])).toEqual([
      { field: 'body[0].heading', message: 'Unknown field "heading"' },
      { field: 'body[0].label', message: 'Field is required' },
    ]);
  });

  it('refuses a duplicate _key within one field value', () => {
    expect(
      body([
        { _type: 'hero', _key: 'k', heading: 'a' },
        { _type: 'hero', _key: 'k', heading: 'b' },
      ]),
    ).toEqual([{ field: 'body[1]', message: 'Duplicate _key "k"' }]);
  });

  it('refuses a _key that is not a non-empty string', () => {
    expect(body([{ _type: 'hero', _key: 7, heading: 'a' }])).toEqual([
      { field: 'body[0]', message: '_key must be a non-empty string' },
    ]);
  });

  it('applies size validations to the block count', () => {
    const slot = typeWith([
      field({ apiId: 'title', type: 'Symbol' }),
      blocksField([HERO, CTA], { validations: { size: { max: 1 } } }),
    ]);
    const issues = validateEntryFields(
      slot,
      {
        body: {
          'en-US': [
            { _type: 'hero', heading: 'a' },
            { _type: 'cta', label: 'b' },
          ],
        },
      },
      vctx,
    );
    expect(issues.map((i) => i.message)).toEqual(['item count must be <= 1']);
  });

  it('leaves a variant-less repeater as it was: no _type, no _key', () => {
    const plain = typeWith([
      field({ apiId: 'title', type: 'Symbol' }),
      field({ apiId: 'cards', type: 'Array', items: { type: 'Component', fields: HERO.fields } }),
    ]);
    expect(validateEntryFields(plain, { cards: { 'en-US': [{ heading: 'a' }] } }, vctx)).toEqual(
      [],
    );
  });
});

describe('links inside blocks', () => {
  it('are references of the top-level field, found per variant', () => {
    const edges = extractReferences(
      'e1',
      {
        body: {
          'en-US': [
            { _type: 'hero', heading: 'h', image: { id: 'a1', linkType: 'Asset' } },
            { _type: 'cta', label: 'l', target: { id: 'e2', linkType: 'Entry' } },
            // An unknown variant contributes nothing: there is no definition to read it by.
            { _type: 'gone', target: { id: 'e3', linkType: 'Entry' } },
          ],
        },
      },
      LANDING,
    );
    expect(edges.map((e) => `${e.fromField}->${e.toType}:${e.toId}`).sort()).toEqual([
      'body->Asset:a1',
      'body->Entry:e2',
    ]);
  });

  it('resolves the definition a block is read by', () => {
    const f = LANDING.fields.find((x) => x.apiId === 'body') as FieldDefinition;
    expect(nestedFieldsFor(f, { _type: 'cta' })).toBe(CTA.fields);
    expect(nestedFieldsFor(f, { _type: 'nope' })).toBeUndefined();
  });
});

describe('defaults and keys', () => {
  it("fills each block from its own variant's defaults", () => {
    const out = applyDefaults(
      LANDING,
      { body: { 'en-US': [{ _type: 'cta' }, { _type: 'hero', heading: 'h' }] } },
      vctx.locales,
      vctx.defaultLocale,
    );
    expect(out.body?.['en-US']).toEqual([
      { _type: 'cta', label: 'Learn more' },
      { _type: 'hero', heading: 'h' },
    ]);
  });

  it('assigns a _key to each block without one and keeps the ones present', () => {
    let n = 0;
    const out = assignBlockKeys(
      LANDING,
      { body: { 'en-US': [{ _type: 'hero', _key: 'keep', heading: 'a' }, { _type: 'cta' }] } },
      () => `new-${++n}`,
    );
    expect(out.body?.['en-US']).toEqual([
      { _type: 'hero', _key: 'keep', heading: 'a' },
      { _type: 'cta', _key: 'new-1' },
    ]);
  });

  it('keys blocks nested inside a component and inside another block', () => {
    const inner = blocksField([CTA], { apiId: 'ctas' });
    const section: ComponentVariant = { apiId: 'section', name: 'Section', fields: [inner] };
    const ct = typeWith([
      field({ apiId: 'title', type: 'Symbol' }),
      blocksField([section]),
      field({ apiId: 'meta', type: 'Component', fields: [inner] }),
    ]);
    let n = 0;
    const out = assignBlockKeys(
      ct,
      {
        body: { 'en-US': [{ _type: 'section', ctas: [{ _type: 'cta', label: 'x' }] }] },
        meta: { 'en-US': { ctas: [{ _type: 'cta', label: 'y' }] } },
      },
      () => `k${++n}`,
    );
    expect(out.body?.['en-US']).toEqual([
      { _type: 'section', _key: 'k2', ctas: [{ _type: 'cta', _key: 'k1', label: 'x' }] },
    ]);
    expect(out.meta?.['en-US']).toEqual({ ctas: [{ _type: 'cta', _key: 'k3', label: 'y' }] });
    expect(validateEntryFields(ct, out, vctx)).toEqual([]);
  });

  it('returns the fields untouched when the type has no blocks', () => {
    const plain = typeWith([field({ apiId: 'title', type: 'Symbol' })]);
    const fields = { title: { 'en-US': 'x' } };
    expect(assignBlockKeys(plain, fields, () => 'k')).toBe(fields);
  });
});

describe('removing a variant', () => {
  it('reports the variants a revision drops, by location', () => {
    const removed = removedVariants(LANDING.fields, [blocksField([HERO])]);
    expect([...removed].map(([at, set]) => [at, [...set]])).toEqual([['body', ['cta']]]);
  });

  it('reports nothing when variants or fields are only added', () => {
    const more = blocksField([
      { ...HERO, fields: [...HERO.fields, field({ apiId: 'kicker', type: 'Symbol' })] },
      CTA,
      { apiId: 'quote', name: 'Quote', fields: [field({ apiId: 'text', type: 'Text' })] },
    ]);
    expect(removedVariants(LANDING.fields, [more]).size).toBe(0);
  });

  it('finds the entries that still use a removed variant, nested ones too', () => {
    const inner = blocksField([HERO, CTA], { apiId: 'ctas' });
    const section: ComponentVariant = { apiId: 'section', name: 'Section', fields: [inner] };
    const before = [blocksField([section, CTA])];
    const after = [blocksField([{ ...section, fields: [blocksField([HERO], { apiId: 'ctas' })] }])];
    const removed = removedVariants(before, after);
    expect([...removed.keys()].sort()).toEqual(['body', 'body[section].ctas']);
    expect(
      removedVariantUses(
        before,
        { body: { 'en-US': [{ _type: 'section', ctas: [{ _type: 'cta', label: 'x' }] }] } },
        removed,
      ),
    ).toEqual(['body[section].ctas: cta']);
    expect(
      removedVariantUses(before, { body: { 'en-US': [{ _type: 'section', ctas: [] }] } }, removed),
    ).toEqual([]);
  });
});

describe('removing a field', () => {
  const seo = field({
    apiId: 'seo',
    type: 'Component',
    fields: [
      field({ apiId: 'description', type: 'Text' }),
      field({ apiId: 'noindex', type: 'Boolean' }),
    ],
  });

  it('reports the fields a revision drops at any depth, by location', () => {
    const before = [
      field({ apiId: 'title', type: 'Symbol' }),
      field({ apiId: 'teaser', type: 'Text' }),
      seo,
      blocksField(),
    ];
    const after = [
      field({ apiId: 'title', type: 'Symbol' }),
      { ...seo, fields: [field({ apiId: 'noindex', type: 'Boolean' })] },
      blocksField([{ ...HERO, fields: [HERO.fields[0] as FieldDefinition] }, CTA]),
    ];
    expect([...removedFields(before, after)].sort()).toEqual([
      'body[hero].image',
      'seo.description',
      'teaser',
    ]);
  });

  it('leaves a removed variant to removedVariants, and its fields unlisted', () => {
    expect([
      ...removedFields(LANDING.fields, [
        field({ apiId: 'title', type: 'Symbol' }),
        blocksField([HERO]),
      ]),
    ]).toEqual([]);
  });

  it('reports nothing when fields are only added', () => {
    const more = [...LANDING.fields, field({ apiId: 'kicker', type: 'Symbol' })];
    expect(removedFields(LANDING.fields, more).size).toBe(0);
  });

  it('finds the values an entry still holds for a removed field, nested ones too', () => {
    const before = [field({ apiId: 'teaser', type: 'Text' }), seo, blocksField()];
    const removed = new Set(['teaser', 'seo.description', 'body[hero].image']);
    expect(
      removedFieldUses(
        before,
        {
          teaser: { 'en-US': 'Short' },
          seo: { 'en-US': { description: 'About', noindex: false } },
          body: { 'en-US': [{ _type: 'hero', heading: 'Hi', image: { sys: { id: 'a1' } } }] },
        },
        removed,
      ).sort(),
    ).toEqual(['body[hero].image', 'seo.description', 'teaser']);
  });

  it('does not count an absent or null value as one held', () => {
    const before = [field({ apiId: 'teaser', type: 'Text' }), seo];
    const removed = new Set(['teaser', 'seo.description']);
    expect(
      removedFieldUses(
        before,
        { teaser: { 'en-US': null }, seo: { 'en-US': { noindex: true } } },
        removed,
      ),
    ).toEqual([]);
  });
});
