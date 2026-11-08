import { describe, expect, it } from 'vitest';
import {
  defineContentType,
  FIELD_GUIDANCE_LIMITS,
  type FieldDefinition,
  type FieldOption,
  fieldGuidance,
  normalizeLegacyFields,
  optionLabel,
  optionValue,
  reviseContentType,
  ValidationError,
  validateEntryFields,
} from '../src/index';

const vctx = { defaultLocale: 'en-US', locales: ['en-US'] };

const field = (extra: Partial<FieldDefinition> = {}): FieldDefinition => ({
  apiId: 'status',
  name: 'Status',
  type: 'Symbol',
  localized: false,
  required: false,
  position: 0,
  ...extra,
});

const typeWith = (...fields: FieldDefinition[]) =>
  defineContentType({
    apiId: 'thing',
    name: 'Thing',
    displayField: fields[0]?.apiId ?? 'status',
    fields,
  });

const issues = (ct: ReturnType<typeof typeWith>, apiId: string, value: unknown) =>
  validateEntryFields(ct, { [apiId]: { 'en-US': value } }, vctx).map((i) => i.message);

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ValidationError) return err.issues.map((i) => i.message).join('; ');
    throw err;
  }
  throw new Error('expected a ValidationError');
};

describe('field guidance: help, placeholder and description', () => {
  it('are kept on the definition, nested fields included', () => {
    const ct = typeWith(
      field({
        apiId: 'title',
        help: 'The headline readers see first.',
        placeholder: 'How we cut build times in half',
        description: 'Shown in listings and as the page title.',
      }),
      field({
        apiId: 'hero',
        type: 'Component',
        position: 1,
        fields: [field({ apiId: 'heading', help: 'One line.' })],
      }),
    );
    expect(ct.fields[0]).toMatchObject({
      help: 'The headline readers see first.',
      placeholder: 'How we cut build times in half',
      description: 'Shown in listings and as the page title.',
    });
    expect(ct.fields[1]?.fields?.[0]?.help).toBe('One line.');
  });

  it('are capped, and refused when not text, at any depth', () => {
    const tooLong = 'x'.repeat(FIELD_GUIDANCE_LIMITS.help + 1);
    expect(refusal(() => typeWith(field({ help: tooLong })))).toMatch(/help must be at most 500/);
    expect(
      refusal(() =>
        typeWith(field({ placeholder: 'x'.repeat(FIELD_GUIDANCE_LIMITS.placeholder + 1) })),
      ),
    ).toMatch(/placeholder/);
    expect(refusal(() => typeWith(field({ description: 42 as unknown as string })))).toMatch(
      /description must be a string/,
    );
    expect(
      refusal(() =>
        typeWith(
          field({
            apiId: 'hero',
            type: 'Component',
            fields: [field({ apiId: 'heading', help: tooLong })],
          }),
        ),
      ),
    ).toMatch(/help/);
  });

  it('are checked on a revision too', () => {
    const ct = typeWith(field());
    expect(
      refusal(() =>
        reviseContentType(ct, {
          fields: [field({ help: 'x'.repeat(FIELD_GUIDANCE_LIMITS.help + 1) })],
        }),
      ),
    ).toMatch(/help/);
  });

  it('read as one capped line for a model', () => {
    expect(fieldGuidance({})).toBeUndefined();
    expect(fieldGuidance({ description: 'The page title.\n\n', help: 'Under\t60.' })).toBe(
      'The page title. — Under 60.',
    );
    const long = fieldGuidance({ description: 'x'.repeat(FIELD_GUIDANCE_LIMITS.description) });
    expect(long).toHaveLength(FIELD_GUIDANCE_LIMITS.brief);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('leaves blank guidance out, at any depth', () => {
    const ct = typeWith(
      field({ help: '  ', placeholder: '', description: 'Kept', apiId: 'title' }),
      field({
        apiId: 'hero',
        type: 'Component',
        position: 1,
        fields: [field({ apiId: 'heading', description: '\n' })],
      }),
    );
    expect(ct.fields[0]).not.toHaveProperty('help');
    expect(ct.fields[0]).not.toHaveProperty('placeholder');
    expect(ct.fields[0]?.description).toBe('Kept');
    expect(ct.fields[1]?.fields?.[0]).not.toHaveProperty('description');
    const revised = reviseContentType(ct, { fields: [field({ apiId: 'title', help: ' ' })] });
    expect(revised.fields[0]).not.toHaveProperty('help');
  });
});

describe('field guidance: labelled `in` options', () => {
  const labelled = field({
    validations: {
      in: [
        { value: 'draft', label: 'Draft' },
        { value: 'live', label: 'Live on the site' },
        'archived',
      ],
    },
  });

  it('compares on the value, never the label', () => {
    const ct = typeWith(labelled);
    expect(issues(ct, 'status', 'live')).toEqual([]);
    expect(issues(ct, 'status', 'archived')).toEqual([]);
    expect(issues(ct, 'status', 'Live on the site')).toEqual([
      'Value must be one of: draft, live, archived',
    ]);
  });

  it('works for numbers', () => {
    const ct = typeWith(
      field({ type: 'Integer', validations: { in: [{ value: 1, label: 'One' }, 2] } }),
    );
    expect(issues(ct, 'status', 1)).toEqual([]);
    expect(issues(ct, 'status', 3)).toEqual(['Value must be one of: 1, 2']);
  });

  it('keeps bare values working as before', () => {
    const ct = typeWith(field({ validations: { in: ['a', 'b'] } }));
    expect(issues(ct, 'status', 'a')).toEqual([]);
    expect(issues(ct, 'status', 'c')).toEqual(['Value must be one of: a, b']);
  });

  it('reads a value and a label from either form', () => {
    expect(optionValue('a')).toBe('a');
    expect(optionValue({ value: 2, label: 'Two' })).toBe(2);
    expect(optionLabel(3)).toBe('3');
    expect(optionLabel({ value: 'x', label: 'Ex' })).toBe('Ex');
  });

  it('refuses a malformed, unlabelled or repeated option', () => {
    const withIn = (opts: unknown) =>
      refusal(() => typeWith(field({ validations: { in: opts as never } })));
    expect(withIn([{ value: 'a' }])).toMatch(/needs a label/);
    expect(withIn([{ value: 'a', label: '  ' }])).toMatch(/needs a label/);
    expect(withIn([{ label: 'A' }])).toMatch(/string, a number or \{ value, label \}/);
    expect(withIn([true])).toMatch(/string, a number/);
    expect(withIn(['a', { value: 'a', label: 'A' }])).toMatch(/listed twice/);
    expect(
      withIn([{ value: 'a', label: 'x'.repeat(FIELD_GUIDANCE_LIMITS.optionLabel + 1) }]),
    ).toMatch(/at most 200/);
    expect(withIn('a')).toMatch(/must be a list/);
    // The empty choice of a select is '', so no option may be.
    expect(withIn(['', 'a'])).toMatch(/cannot be empty/);
    // '1' and 1 would be one `<option value="1">`.
    expect(withIn(['1', 1])).toMatch(/listed twice/);
  });

  it('lets a revision keep what a legacy definition stored, but not add more of it', () => {
    // Stored before options were checked: a duplicate and a value of the wrong type.
    const legacy = {
      ...typeWith(field()),
      fields: [field({ validations: { in: ['a', 'a', true as never] } })],
    };
    const revised = reviseContentType(legacy, {
      fields: [field({ name: 'Renamed', validations: { in: ['a', 'a', true as never, 'b'] } })],
    });
    expect(revised.fields[0]?.name).toBe('Renamed');
    expect(
      refusal(() =>
        reviseContentType(legacy, {
          fields: [field({ validations: { in: ['a', 'a', 'a', true as never] } })],
        }),
      ),
    ).toMatch(/"a" is listed twice/);
    expect(
      refusal(() =>
        reviseContentType(legacy, {
          fields: [field({ validations: { in: ['a', 'a', true as never, false as never] } })],
        }),
      ),
    ).toMatch(/string, a number/);
  });

  it('matches a stored option whatever the order of its keys', () => {
    const stored = {
      ...typeWith(field()),
      fields: [field({ validations: { in: [{ value: 'a', label: 'A' }] } })],
    };
    const reordered = { label: 'A', value: 'a' } as unknown as FieldOption;
    expect(() =>
      reviseContentType(stored, { fields: [field({ validations: { in: [reordered] } })] }),
    ).not.toThrow();
  });

  it('normalises by the field’s type, and drops a list nothing is left of', () => {
    const [count, gone] = normalizeLegacyFields([
      field({ apiId: 'count', type: 'Integer', validations: { in: ['1', 1, '2'] } }),
      field({
        apiId: 'gone',
        validations: { in: ['', true as never], messages: { in: 'Pick one' }, size: { max: 3 } },
      }),
    ]);
    expect(count?.validations?.in).toEqual([1, '2']);
    // No list left, so no rule, and no message for it.
    expect(gone?.validations).toEqual({ size: { max: 3 } });
  });

  it('normalises legacy guidance and messages for an import', () => {
    const [f] = normalizeLegacyFields([
      field({
        help: 'Kept.',
        placeholder: 42 as never,
        description: 'x'.repeat(FIELD_GUIDANCE_LIMITS.description + 1),
        type: 'Array',
        items: { type: 'Symbol', validations: { in: ['a'], messages: { in: 'Pick a' } as never } },
        validations: {
          size: { max: 2 },
          messages: { size: 'Two at most', regexp: 'No rule', in: 7 as never } as never,
        },
      }),
    ]);
    expect(f).toMatchObject({ help: 'Kept.' });
    expect(f).not.toHaveProperty('placeholder');
    expect(f).not.toHaveProperty('description');
    expect(f?.validations).toEqual({ size: { max: 2 }, messages: { size: 'Two at most' } });
    expect(f?.items?.validations).toEqual({ in: ['a'] });
    expect(() => typeWith(f as FieldDefinition)).not.toThrow();
  });

  it('lets a revision keep stored guidance and messages unchanged, however they were stored', () => {
    const legacy = {
      ...typeWith(field()),
      fields: [
        field({
          description: null as never,
          help: 'x'.repeat(FIELD_GUIDANCE_LIMITS.help + 1),
          type: 'Array',
          items: { type: 'Symbol', validations: { messages: { in: 'Orphan' } as never } },
          validations: { messages: { regexp: 'No rule' } },
        }),
      ],
    };
    const revised = reviseContentType(legacy, { name: 'Renamed' });
    expect(revised.fields[0]).not.toHaveProperty('description');
    expect(revised.fields[0]?.help).toHaveLength(FIELD_GUIDANCE_LIMITS.help + 1);
    expect(
      refusal(() =>
        reviseContentType(legacy, {
          fields: [{ ...(legacy.fields[0] as FieldDefinition), help: 'y'.repeat(501) }],
        }),
      ),
    ).toMatch(/help must be at most/);
    expect(
      refusal(() =>
        reviseContentType(legacy, {
          fields: [
            {
              ...(legacy.fields[0] as FieldDefinition),
              validations: { messages: { regexp: 'No rule', size: 'Also none' } },
            },
          ],
        }),
      ),
    ).toMatch(/needs the size rule/);
  });

  it('normalises a legacy list for an import instead of refusing it', () => {
    const fields = normalizeLegacyFields([
      field({
        validations: { in: ['a', 'a', true as never, '', 1, '1', { value: 'b', label: 'B' }] },
      }),
      field({
        apiId: 'hero',
        type: 'Component',
        fields: [field({ apiId: 'tone', validations: { in: ['x', 'x'] } })],
      }),
    ]);
    // Of '1' and 1 the Symbol keeps the string, the one a value can match; labels are kept.
    expect(fields[0]?.validations?.in).toEqual(['a', '1', { value: 'b', label: 'B' }]);
    expect(fields[1]?.fields?.[0]?.validations?.in).toEqual(['x']);
    expect(() => typeWith(...fields.map((f, i) => ({ ...f, position: i })))).not.toThrow();
  });
});

describe('field guidance: custom validation messages', () => {
  it('replaces the default text of each rule', () => {
    const ct = typeWith(
      field({
        apiId: 'zip',
        validations: {
          regexp: { pattern: '^\\d{5}$' },
          size: { max: 5 },
          messages: { regexp: 'Enter a five-digit ZIP code', size: 'Five digits at most' },
        },
      }),
      field({
        apiId: 'rating',
        type: 'Integer',
        position: 1,
        validations: {
          range: { min: 1, max: 5 },
          in: [1, 2, 3, 4, 5],
          messages: { range: 'Rate from 1 to 5', in: 'Pick a whole star' },
        },
      }),
      field({
        apiId: 'tags',
        type: 'Array',
        position: 2,
        items: { type: 'Symbol' },
        validations: { size: { max: 1 }, messages: { size: 'One tag only' } },
      }),
    );
    expect(issues(ct, 'zip', 'abc')).toEqual(['Enter a five-digit ZIP code']);
    expect(issues(ct, 'zip', '123456')).toEqual([
      'Five digits at most',
      'Enter a five-digit ZIP code',
    ]);
    expect(issues(ct, 'rating', 9)).toEqual(['Rate from 1 to 5', 'Pick a whole star']);
    expect(issues(ct, 'tags', ['a', 'b'])).toEqual(['One tag only']);
  });

  it('falls back to the default text for rules without one', () => {
    const ct = typeWith(
      field({
        validations: { size: { max: 2 }, regexp: { pattern: '^a' }, messages: { size: 'Short' } },
      }),
    );
    expect(issues(ct, 'status', 'bcd')).toEqual(['Short', 'Does not match pattern /^a/']);
  });

  it('applies inside a component', () => {
    const ct = typeWith(
      field({
        apiId: 'cta',
        type: 'Component',
        fields: [
          field({
            apiId: 'label',
            validations: { size: { max: 3 }, messages: { size: 'Keep the button short' } },
          }),
        ],
      }),
    );
    expect(validateEntryFields(ct, { cta: { 'en-US': { label: 'Read more' } } }, vctx)).toEqual([
      { field: 'cta.label', locale: 'en-US', message: 'Keep the button short' },
    ]);
  });

  it('refuses a message for an unknown or undeclared rule, or one that is not text', () => {
    const withV = (validations: unknown) =>
      refusal(() => typeWith(field({ validations: validations as never })));
    expect(withV({ messages: { pattern: 'x' } })).toMatch(/no message for "pattern"/);
    expect(withV({ messages: { regexp: 'x' } })).toMatch(/needs the regexp rule/);
    expect(withV({ size: { max: 1 }, messages: { size: '' } })).toMatch(/non-empty text/);
    expect(
      withV({
        size: { max: 1 },
        messages: { size: 'x'.repeat(FIELD_GUIDANCE_LIMITS.message + 1) },
      }),
    ).toMatch(/at most 500/);
    expect(withV({ messages: ['x'] })).toMatch(/maps a rule/);
  });

  it('refuses a message on an Array’s elements, which nothing would enforce', () => {
    expect(
      refusal(() =>
        typeWith(
          field({
            type: 'Array',
            items: { type: 'Symbol', validations: { in: ['a'], messages: { in: 'Pick a' } } },
          }),
        ),
      ),
    ).toMatch(/not enforced on an Array's elements/);
  });

  it('checks an Array element definition the same way', () => {
    expect(
      refusal(() =>
        typeWith(
          field({
            type: 'Array',
            items: { type: 'Symbol', validations: { in: [{ value: 'a' } as never] } },
          }),
        ),
      ),
    ).toMatch(/status items: option "a" needs a label/);
  });
});
