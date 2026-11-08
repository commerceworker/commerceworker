import { describe, expect, it } from 'vitest';
import {
  defineContentType,
  type FieldDefinition,
  unsafeRegexReason,
  ValidationError,
  validateEntryFields,
} from '../src/index';

const vctx = { defaultLocale: 'en-US', locales: ['en-US'] };

function typeWith(field: Omit<FieldDefinition, 'position'>) {
  return defineContentType({
    apiId: 'thing',
    name: 'Thing',
    displayField: field.apiId,
    fields: [{ ...field, position: 0 }],
  });
}

const ok = (ct: ReturnType<typeof typeWith>, value: unknown) =>
  validateEntryFields(ct, { [ct.displayField]: { 'en-US': value } }, vctx);

describe('field type validation across all types', () => {
  it('Integer rejects non-integers; Number accepts decimals', () => {
    const int = typeWith({
      apiId: 'n',
      name: 'N',
      type: 'Integer',
      localized: false,
      required: true,
    });
    expect(ok(int, 3)).toHaveLength(0);
    expect(ok(int, 3.5).length).toBeGreaterThan(0);
    const num = typeWith({
      apiId: 'n',
      name: 'N',
      type: 'Number',
      localized: false,
      required: true,
    });
    expect(ok(num, 3.5)).toHaveLength(0);
  });

  it('Boolean / Date / Location / JSON', () => {
    expect(
      ok(
        typeWith({ apiId: 'b', name: 'B', type: 'Boolean', localized: false, required: true }),
        true,
      ),
    ).toHaveLength(0);
    expect(
      ok(
        typeWith({ apiId: 'd', name: 'D', type: 'Date', localized: false, required: true }),
        '2026-06-24',
      ),
    ).toHaveLength(0);
    expect(
      ok(
        typeWith({ apiId: 'd', name: 'D', type: 'Date', localized: false, required: true }),
        'not-a-date',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      ok(typeWith({ apiId: 'l', name: 'L', type: 'Location', localized: false, required: true }), {
        lat: 1,
        lon: 2,
      }),
    ).toHaveLength(0);
    expect(
      ok(typeWith({ apiId: 'j', name: 'J', type: 'JSON', localized: false, required: true }), {
        a: 1,
      }),
    ).toHaveLength(0);
    // Oversized JSON is rejected (per-field serialized-size cap).
    const huge = { blob: 'x'.repeat(300 * 1024) };
    expect(
      ok(typeWith({ apiId: 'j', name: 'J', type: 'JSON', localized: false, required: true }), huge),
    ).not.toHaveLength(0);
  });

  it('RichText expects a document object', () => {
    const rt = typeWith({
      apiId: 'r',
      name: 'R',
      type: 'RichText',
      localized: false,
      required: true,
    });
    expect(ok(rt, { nodeType: 'document', content: [] })).toHaveLength(0);
    expect(ok(rt, 'plain string').length).toBeGreaterThan(0);
  });

  it('Link expects { id, linkType }', () => {
    const link = typeWith({
      apiId: 'ref',
      name: 'Ref',
      type: 'Link',
      localized: false,
      required: true,
      linkType: 'Entry',
    });
    expect(ok(link, { id: 'e1', linkType: 'Entry' })).toHaveLength(0);
    expect(ok(link, { id: 'e1' }).length).toBeGreaterThan(0);
  });

  it('Array of Links enforces item shape and size', () => {
    const arr = typeWith({
      apiId: 'tags',
      name: 'Tags',
      type: 'Array',
      localized: false,
      required: true,
      validations: { size: { max: 2 } },
      items: { type: 'Link', linkType: 'Entry' },
    });
    expect(ok(arr, [{ id: 'a', linkType: 'Entry' }])).toHaveLength(0);
    expect(
      ok(arr, [
        { id: 'a', linkType: 'Entry' },
        { id: 'b', linkType: 'Entry' },
        { id: 'c', linkType: 'Entry' },
      ]).length,
    ).toBeGreaterThan(0);
    expect(ok(arr, ['not-a-link']).length).toBeGreaterThan(0);
  });

  it('Symbol enforces regexp and enum validations', () => {
    const sym = typeWith({
      apiId: 'slug',
      name: 'Slug',
      type: 'Symbol',
      localized: false,
      required: true,
      validations: { regexp: { pattern: '^[a-z-]+$' } },
    });
    expect(ok(sym, 'hello-world')).toHaveLength(0);
    expect(ok(sym, 'Hello World').length).toBeGreaterThan(0);
  });

  it('rejects a content type whose regexp risks catastrophic backtracking (ReDoS)', () => {
    let thrown: unknown;
    try {
      typeWith({
        apiId: 'slug',
        name: 'Slug',
        type: 'Symbol',
        localized: false,
        required: true,
        validations: { regexp: { pattern: '(a+)+$' } },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).issues[0]?.message).toMatch(/backtracking/i);
  });
});

describe('unsafeRegexReason', () => {
  it('accepts a safe pattern', () => {
    expect(unsafeRegexReason('^[a-z0-9-]+$')).toBeNull();
  });
  it('flags nested quantifiers', () => {
    expect(unsafeRegexReason('(a+)+')).toMatch(/backtracking/);
    expect(unsafeRegexReason('([a-z]*)+')).toMatch(/backtracking/);
  });
  it('rejects unsupported flags and invalid patterns', () => {
    expect(unsafeRegexReason('abc', 'z')).toMatch(/flag/);
    expect(unsafeRegexReason('(')).toMatch(/invalid/);
  });
  it('rejects an over-long pattern', () => {
    expect(unsafeRegexReason('a'.repeat(1001))).toMatch(/at most/);
  });
});
