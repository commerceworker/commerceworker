import { describe, expect, it } from 'vitest';
import {
  defineContentType,
  describeFieldRules,
  type FieldDefinition,
  type FieldRule,
  fieldState,
  normalizeLegacyFields,
  openProposals,
  reviseContentType,
  ValidationError,
  validateEntryFields,
  withoutClosedFields,
} from '../src/index';

const vctx = { defaultLocale: 'en', locales: ['en', 'de'] };

const field = (apiId: string, extra: Partial<FieldDefinition> = {}): FieldDefinition => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required: false,
  position: 0,
  ...extra,
});

const hideWhen = (when: FieldRule['when']): FieldRule => ({ action: 'hide', when });
const disableWhen = (when: FieldRule['when']): FieldRule => ({ action: 'disable', when });

const typeWith = (...fields: FieldDefinition[]) =>
  defineContentType({ apiId: 'listing', name: 'Listing', displayField: 'title', fields });

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ValidationError) return err.issues.map((i) => i.message).join('; ');
    throw err;
  }
  throw new Error('expected a ValidationError');
};

const messages = (issues: ReturnType<typeof validateEntryFields>) =>
  issues.map((i) => `${i.field}${i.locale ? `@${i.locale}` : ''}: ${i.message}`);

describe('conditional field rules: operators', () => {
  const at = (rule: FieldRule, values: Record<string, unknown>) =>
    fieldState({ rules: [rule] }, values).hidden;

  it('eq, ne and in compare strictly', () => {
    const eq = hideWhen({ field: 'status', operator: 'eq', value: 'sold' });
    expect(at(eq, { status: 'sold' })).toBe(true);
    expect(at(eq, { status: 'open' })).toBe(false);
    expect(at(eq, {})).toBe(false);
    const ne = hideWhen({ field: 'status', operator: 'ne', value: 'sold' });
    expect(at(ne, { status: 'open' })).toBe(true);
    expect(at(ne, {})).toBe(true);
    const inList = hideWhen({ field: 'n', operator: 'in', value: [1, 2] });
    expect(at(inList, { n: 2 })).toBe(true);
    expect(at(inList, { n: '2' })).toBe(false);
  });

  it('empty and notEmpty treat blank text and empty lists as empty', () => {
    const empty = hideWhen({ field: 'tags', operator: 'empty' });
    for (const v of [undefined, null, '', '  ', [], {}]) expect(at(empty, { tags: v })).toBe(true);
    expect(at(empty, { tags: ['a'] })).toBe(false);
    expect(at(hideWhen({ field: 'tags', operator: 'notEmpty' }), { tags: false })).toBe(true);
  });

  it('gt and lt compare numbers only', () => {
    const gt = hideWhen({ field: 'price', operator: 'gt', value: 100 });
    expect(at(gt, { price: 101 })).toBe(true);
    expect(at(gt, { price: 100 })).toBe(false);
    expect(at(gt, { price: '200' })).toBe(false);
    expect(at(hideWhen({ field: 'price', operator: 'lt', value: 0 }), { price: -1 })).toBe(true);
  });

  it('reads a component sibling by dot path', () => {
    const rule = hideWhen({ field: 'hero.style', operator: 'eq', value: 'plain' });
    expect(at(rule, { hero: { style: 'plain' } })).toBe(true);
    expect(at(rule, { hero: 'plain' })).toBe(false);
  });

  it('a malformed stored rule matches nothing', () => {
    expect(fieldState({ rules: [{} as FieldRule] }, {})).toEqual({
      hidden: false,
      disabled: false,
    });
    expect(fieldState({ rules: 'nope' as unknown as FieldRule[] }, {}).hidden).toBe(false);
  });
});

describe('conditional field rules: definitions', () => {
  it('are kept, and refused when they read nothing, themselves, or the wrong type', () => {
    const ct = typeWith(
      field('title'),
      field('status', { position: 1 }),
      field('price', { type: 'Number', position: 2 }),
      field('soldTo', {
        position: 3,
        rules: [hideWhen({ field: 'status', operator: 'ne', value: 'sold' })],
      }),
    );
    expect(ct.fields.find((f) => f.apiId === 'soldTo')?.rules).toHaveLength(1);

    const withRule = (rule: unknown) =>
      refusal(() =>
        typeWith(
          field('title'),
          field('status', { position: 1 }),
          field('x', { position: 2, rules: [rule as FieldRule] }),
        ),
      );
    expect(withRule(hideWhen({ field: 'missing', operator: 'empty' }))).toMatch(/not a sibling/);
    expect(withRule(hideWhen({ field: 'x', operator: 'empty' }))).toMatch(/its own field/);
    expect(withRule(hideWhen({ field: 'status', operator: 'gt', value: 1 }))).toMatch(
      /compares numbers/,
    );
    expect(withRule(hideWhen({ field: 'status', operator: 'eq' }))).toMatch(/compares with/);
    expect(withRule(hideWhen({ field: 'status', operator: 'in', value: [] }))).toMatch(/lists 1/);
    expect(withRule(hideWhen({ field: 'status', operator: 'empty', value: 1 }))).toMatch(
      /takes no value/,
    );
    expect(withRule({ action: 'collapse', when: { field: 'status', operator: 'empty' } })).toMatch(
      /action is one of/,
    );
    expect(withRule(hideWhen({ field: 'status', operator: 'like', value: 'a' } as never))).toMatch(
      /operator is one of/,
    );
  });

  it('reach into a component sibling but not name the component itself', () => {
    const hero = field('hero', {
      type: 'Component',
      position: 1,
      fields: [field('style')],
    });
    expect(() =>
      typeWith(
        field('title'),
        hero,
        field('x', { position: 2, rules: [hideWhen({ field: 'hero.style', operator: 'empty' })] }),
      ),
    ).not.toThrow();
    expect(
      refusal(() =>
        typeWith(
          field('title'),
          hero,
          field('x', { position: 2, rules: [hideWhen({ field: 'hero', operator: 'empty' })] }),
        ),
      ),
    ).toMatch(/is a component/);
  });

  it('cannot disable a field inside an Array element, but can hide one', () => {
    const cards = (rule: FieldRule) =>
      typeWith(
        field('title'),
        field('cards', {
          type: 'Array',
          position: 1,
          items: {
            type: 'Component',
            fields: [field('kind'), field('url', { position: 1, rules: [rule] })],
          },
        }),
      );
    expect(() => cards(hideWhen({ field: 'kind', operator: 'ne', value: 'link' }))).not.toThrow();
    expect(refusal(() => cards(disableWhen({ field: 'kind', operator: 'empty' })))).toMatch(
      /inside an Array element cannot be disabled/,
    );
  });

  it('a revision cannot remove the sibling a kept rule reads', () => {
    const ct = typeWith(
      field('title'),
      field('status', { position: 1 }),
      field('x', { position: 2, rules: [hideWhen({ field: 'status', operator: 'empty' })] }),
    );
    const without = ct.fields.filter((f) => f.apiId !== 'status');
    expect(refusal(() => reviseContentType(ct, { fields: without }))).toMatch(
      /reads "status", which this change removes/,
    );
  });

  it('caps the rules on one field', () => {
    const many = Array.from({ length: 11 }, () => hideWhen({ field: 'title', operator: 'empty' }));
    expect(
      refusal(() => typeWith(field('title'), field('x', { position: 1, rules: many }))),
    ).toMatch(/at most 10 rules/);
  });

  it('normalizeLegacyFields drops unusable rules and keeps the rest', () => {
    const [, x] = normalizeLegacyFields([
      field('title'),
      field('x', {
        rules: [
          hideWhen({ field: 'gone', operator: 'empty' }),
          hideWhen({ field: 'title', operator: 'empty' }),
        ],
      }),
    ]);
    expect(x?.rules).toEqual([hideWhen({ field: 'title', operator: 'empty' })]);
    const [, y] = normalizeLegacyFields([
      field('title'),
      field('y', { rules: [hideWhen({ field: 'gone', operator: 'empty' })] }),
    ]);
    expect(y && 'rules' in y).toBe(false);
  });
});

describe('conditional field rules: validation', () => {
  const ct = typeWith(
    field('title', { localized: true }),
    field('status', { position: 1 }),
    field('soldTo', {
      position: 2,
      required: true,
      rules: [hideWhen({ field: 'status', operator: 'ne', value: 'sold' })],
    }),
    field('price', {
      type: 'Number',
      position: 3,
      rules: [disableWhen({ field: 'status', operator: 'eq', value: 'sold' })],
    }),
    field('subtitle', {
      position: 4,
      localized: true,
      required: true,
      rules: [hideWhen({ field: 'title', operator: 'empty' })],
    }),
  );

  it('a hidden field skips required, and is required again once shown', () => {
    expect(messages(validateEntryFields(ct, { status: { en: 'open' } }, vctx))).toEqual([]);
    expect(messages(validateEntryFields(ct, { status: { en: 'sold' } }, vctx))).toEqual([
      'soldTo@en: Field is required',
    ]);
  });

  it('reads a localized sibling in the same locale', () => {
    const fields = { status: { en: 'open' }, title: { en: 'Hello' }, subtitle: { de: 'x' } };
    expect(messages(validateEntryFields(ct, fields, vctx))).toEqual([
      'subtitle@en: Field is required',
    ]);
  });

  it('a hidden field keeps a value it holds, still validated', () => {
    const issues = validateEntryFields(ct, { status: { en: 'open' }, soldTo: { en: 5 } }, vctx);
    expect(messages(issues)).toEqual(['soldTo@en: Expected a string']);
  });

  it('a disabled field keeps its stored value and refuses a change', () => {
    const previous = { status: { en: 'sold' }, price: { en: 10 }, soldTo: { en: 'Ada' } };
    const edit = (price: unknown) =>
      messages(
        validateEntryFields(
          ct,
          { ...previous, price: price === undefined ? {} : { en: price } },
          { ...vctx, previous },
        ),
      );
    expect(edit(10)).toEqual([]);
    expect(edit(12)).toEqual([
      'price@en: Field is read-only while its rules disable it; it keeps its stored value',
    ]);
    expect(edit(undefined)).toHaveLength(1);
  });

  it('is open again once its condition stops matching, in the same write', () => {
    const previous = { status: { en: 'sold' }, price: { en: 10 }, soldTo: { en: 'Ada' } };
    const next = { status: { en: 'open' }, price: { en: 12 } };
    expect(messages(validateEntryFields(ct, next, { ...vctx, previous }))).toEqual([]);
  });

  it('without previous values (a copy, an import) a disabled field is not checked', () => {
    expect(
      messages(
        validateEntryFields(
          ct,
          { status: { en: 'sold' }, soldTo: { en: 'A' }, price: { en: 1 } },
          vctx,
        ),
      ),
    ).toEqual([]);
  });

  it('applies inside a component, and per element of a repeater', () => {
    const nested = typeWith(
      field('title'),
      field('cta', {
        type: 'Component',
        position: 1,
        fields: [
          field('kind'),
          field('url', {
            position: 1,
            required: true,
            rules: [hideWhen({ field: 'kind', operator: 'ne', value: 'link' })],
          }),
          field('label', {
            position: 2,
            rules: [disableWhen({ field: 'kind', operator: 'eq', value: 'fixed' })],
          }),
        ],
      }),
      field('cards', {
        type: 'Array',
        position: 2,
        items: {
          type: 'Component',
          fields: [
            field('kind'),
            field('url', {
              position: 1,
              required: true,
              rules: [hideWhen({ field: 'kind', operator: 'ne', value: 'link' })],
            }),
          ],
        },
      }),
    );
    const fields = {
      cta: { en: { kind: 'text' } },
      cards: { en: [{ kind: 'text' }, { kind: 'link' }] },
    };
    expect(messages(validateEntryFields(nested, fields, vctx))).toEqual([
      'cards[1].url@en: Field is required',
    ]);
    const previous = { cta: { en: { kind: 'fixed', label: 'Buy' } } };
    expect(
      messages(
        validateEntryFields(
          nested,
          { cta: { en: { kind: 'fixed', label: 'Sell' } } },
          { ...vctx, previous },
        ),
      ),
    ).toEqual([
      'cta.label@en: Field is read-only while its rules disable it; it keeps its stored value',
    ]);
  });
});

describe('conditional field rules: generation and models', () => {
  const fields = [
    field('title'),
    field('kind', { position: 1 }),
    field('url', {
      position: 2,
      rules: [hideWhen({ field: 'kind', operator: 'ne', value: 'link' })],
    }),
    field('note', {
      position: 3,
      rules: [hideWhen({ field: 'url', operator: 'notEmpty' })],
    }),
    field('locked', {
      position: 4,
      rules: [disableWhen({ field: 'kind', operator: 'notEmpty' })],
    }),
  ];

  it('withoutClosedFields drops values for hidden and disabled fields', () => {
    const out = withoutClosedFields(
      fields,
      {
        title: { en: 'T' },
        kind: { en: 'text' },
        url: { en: 'https://x' },
        note: { en: 'n' },
        locked: { en: 'l' },
      },
      'en',
    );
    expect(Object.keys(out).sort()).toEqual(['kind', 'note', 'title']);
  });

  it('withoutClosedFields leaves out every field any pass closed when the rules never settle', () => {
    // Each is hidden while the other holds a value: leaving both out opens both, which hides
    // both again, so no pass agrees with the one before it.
    const mutual = [
      field('title'),
      field('url', { position: 1, rules: [hideWhen({ field: 'link', operator: 'notEmpty' })] }),
      field('link', { position: 2, rules: [hideWhen({ field: 'url', operator: 'notEmpty' })] }),
    ];
    const values = { title: { en: 'T' }, url: { en: 'https://x' }, link: { en: 'l' } };
    expect(Object.keys(withoutClosedFields(mutual, values, 'en'))).toEqual(['title']);
    // One more field shifts how many passes run, not the answer.
    const more = [...mutual, field('note', { position: 3 })];
    expect(Object.keys(withoutClosedFields(more, values, 'en'))).toEqual(['title']);
  });

  it('openProposals keeps a proposed value only where the proposal as a whole leaves it open', () => {
    const defs = [
      field('title'),
      field('summary', { position: 1 }),
      field('teaser', {
        position: 2,
        rules: [hideWhen({ field: 'summary', operator: 'notEmpty' })],
      }),
      field('code', {
        position: 3,
        rules: [disableWhen({ field: 'title', operator: 'notEmpty' })],
      }),
    ];
    // Empty on its own, `teaser` is closed once the proposed `summary` lands; `code` is closed by
    // the stored title. Neither proposal is kept.
    const out = openProposals(
      defs,
      { title: { en: 'T' } },
      { summary: { en: 's' }, teaser: { en: 't' }, code: { en: 'c' } },
      'en',
    );
    expect(out).toEqual({ summary: { en: 's' } });
  });

  it('describeFieldRules says each rule in words', () => {
    expect(describeFieldRules(fields[2] as FieldDefinition)).toBe('hidden when kind is not "link"');
    expect(describeFieldRules(fields[4] as FieldDefinition)).toBe(
      'read-only when kind is not empty',
    );
    expect(describeFieldRules(field('plain'))).toBeUndefined();
  });
});
