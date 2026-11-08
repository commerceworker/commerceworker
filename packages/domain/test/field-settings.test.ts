import { describe, expect, it } from 'vitest';
import {
  assetMimeChecks,
  type ContentType,
  dateSortKey,
  defineContentType,
  type FieldDefinition,
  MAX_REGEXP_INPUT,
  mimeTypeAllowed,
  normalizeLegacyFields,
  PATTERN_PRESETS,
  reviseContentType,
  unsafeRegexReason,
  ValidationError,
  validateEntryFields,
} from '../src/index';

const vctx = { defaultLocale: 'en', locales: ['en'] };

const field = (apiId: string, extra: Partial<FieldDefinition> = {}): FieldDefinition => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required: false,
  position: 0,
  ...extra,
});

const typeWith = (...fields: FieldDefinition[]) =>
  defineContentType({ apiId: 'thing', name: 'Thing', displayField: 'title', fields });

/** A type as stored, without the write checks `defineContentType` runs. */
const stored = (...fields: FieldDefinition[]): ContentType => ({
  apiId: 'thing',
  name: 'Thing',
  displayField: 'title',
  fields: [field('title'), ...fields],
  version: 1,
  status: 'published',
});

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ValidationError) return err.issues.map((i) => i.message).join('; ');
    throw err;
  }
  throw new Error('expected a ValidationError');
};

const issues = (ct: ContentType, values: Record<string, unknown>) =>
  validateEntryFields(
    ct,
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { en: v }])),
    vctx,
  ).map((i) => `${i.field}: ${i.message}`);

describe('Date formats', () => {
  it('holds each format to its written form', () => {
    const ct = typeWith(
      field('title'),
      field('day', { type: 'Date', format: 'date', position: 1 }),
      field('at', { type: 'Date', format: 'datetime', position: 2 }),
      field('legacy', { type: 'Date', position: 3 }),
    );
    expect(issues(ct, { day: '2026-11-03', at: '2026-11-03T14:30', legacy: 'Nov 3 2026' })).toEqual(
      [],
    );
    expect(issues(ct, { at: '2026-11-03T14:30:15.250+01:00' })).toEqual([]);
    expect(issues(ct, { day: '2026-11-03T10:00' })).toEqual(['day: Expected a date (YYYY-MM-DD)']);
    expect(issues(ct, { day: '2026-02-30' })).toEqual(['day: Expected a date (YYYY-MM-DD)']);
    expect(issues(ct, { at: '2026-11-03' })).toEqual([
      'at: Expected a date and time (YYYY-MM-DDThh:mm)',
    ]);
    expect(issues(ct, { legacy: 'soon' })).toEqual(['legacy: Expected an ISO-8601 date string']);
  });

  it('reads a time of day', () => {
    const ct = stored(field('opens', { type: 'Date', format: 'time' }));
    expect(issues(ct, { title: 'x', opens: '09:30' })).toEqual([]);
    expect(issues(ct, { title: 'x', opens: '23:59:59' })).toEqual([]);
    expect(issues(ct, { title: 'x', opens: '24:00' })).toEqual(['opens: Expected a time (hh:mm)']);
    expect(dateSortKey('01:02:03', 'time')).toBe(3723);
  });

  it('enforces dateRange in the field’s format, with its custom message', () => {
    const ct = typeWith(
      field('title'),
      field('day', {
        type: 'Date',
        format: 'date',
        position: 1,
        validations: {
          dateRange: { min: '2026-01-01', max: '2026-12-31' },
          messages: { dateRange: 'Pick a day in 2026' },
        },
      }),
      field('when', {
        type: 'Date',
        position: 2,
        validations: { dateRange: { min: '2026-01-01T00:00:00Z' } },
      }),
    );
    expect(issues(ct, { day: '2026-06-01' })).toEqual([]);
    expect(issues(ct, { day: '2027-01-01' })).toEqual(['day: Pick a day in 2026']);
    expect(issues(ct, { when: '2025-12-31T23:00:00Z' })).toEqual([
      'when: Must be 2026-01-01T00:00:00Z or later',
    ]);
  });

  it('refuses a format or range a field cannot use', () => {
    expect(refusal(() => typeWith(field('title', { format: 'date' })))).toMatch(/only a Date does/);
    expect(
      refusal(() =>
        typeWith(field('title'), field('d', { type: 'Date', format: 'week' as never })),
      ),
    ).toMatch(/format is one of/);
    expect(
      refusal(() =>
        typeWith(
          field('title'),
          field('d', {
            type: 'Date',
            format: 'date',
            validations: { dateRange: { min: '2026-01-01T10:00' } },
          }),
        ),
      ),
    ).toMatch(/dateRange.min must be a date \(YYYY-MM-DD\)/);
    expect(
      refusal(() =>
        typeWith(
          field('title'),
          field('d', {
            type: 'Date',
            format: 'date',
            validations: { dateRange: { min: '2026-02-01', max: '2026-01-01' } },
          }),
        ),
      ),
    ).toMatch(/later than/);
    expect(
      refusal(() =>
        typeWith(field('title', { validations: { dateRange: { min: '2026-01-01' } } })),
      ),
    ).toMatch(/applies to a Date/);
  });

  it('accepts a time-only Date, new or already stored, and a list of them', () => {
    const ct = typeWith(
      field('title'),
      field('opens', { type: 'Date', format: 'time', position: 1 }),
      field('slots', { type: 'Array', items: { type: 'Date', format: 'time' }, position: 2 }),
    );
    expect(ct.fields.find((f) => f.apiId === 'opens')?.format).toBe('time');
    expect(issues(ct, { title: 'x', opens: '09:30', slots: ['10:00', '25:00'] })).toEqual([
      'slots[1]: Expected a time (hh:mm)',
    ]);
    const current = stored(field('opens', { type: 'Date', format: 'time', position: 1 }));
    expect(() => reviseContentType(current, { name: 'Renamed' })).not.toThrow();
  });
});

describe('lists of scalars', () => {
  const ct = stored(
    field('tags', { type: 'Array', items: { type: 'Symbol' } }),
    field('lines', { type: 'Array', items: { type: 'Text' } }),
    field('sizes', { type: 'Array', items: { type: 'Integer' } }),
    field('weights', { type: 'Array', items: { type: 'Number' } }),
    field('days', { type: 'Array', items: { type: 'Date', format: 'date' } }),
  );

  it('checks each element against its type and format', () => {
    expect(
      issues(ct, {
        title: 'x',
        lines: ['a', 'b'],
        sizes: [1, 2],
        weights: [1.5],
        days: ['2026-11-03'],
      }),
    ).toEqual([]);
    expect(
      issues(ct, { title: 'x', lines: [1], sizes: [1.5], weights: ['2'], days: ['tomorrow'] }),
    ).toEqual([
      'lines[0]: Expected a string',
      'sizes[0]: Expected an integer',
      'weights[0]: Expected a number',
      'days[0]: Expected a date (YYYY-MM-DD)',
    ]);
    expect(issues(ct, { title: 'x', tags: [1] })).toEqual(['tags: Array item must be a string']);
  });

  it('accepts a new list of Text, Integer, Number or Date on write', () => {
    for (const type of ['Text', 'Integer', 'Number', 'Date'] as const) {
      const made = typeWith(field('title'), field('list', { type: 'Array', items: { type } }));
      expect(made.fields.find((f) => f.apiId === 'list')?.items?.type).toBe(type);
    }
    expect(() => reviseContentType(ct, { name: 'Still editable' })).not.toThrow();
  });

  it('refuses an unknown element type and a format on a non-Date list', () => {
    expect(
      refusal(() =>
        typeWith(
          field('title'),
          field('l', { type: 'Array', items: { type: 'Boolean' as never } }),
        ),
      ),
    ).toMatch(/items.type is one of/);
    expect(
      refusal(() =>
        typeWith(
          field('title'),
          field('l', { type: 'Array', items: { type: 'Symbol', format: 'date' } }),
        ),
      ),
    ).toMatch(/Only a list of Dates/);
  });
});

describe('asset MIME types', () => {
  const ct = typeWith(
    field('title'),
    field('doc', {
      type: 'Link',
      linkType: 'Asset',
      position: 1,
      validations: {
        assetMimeTypes: ['application/pdf'],
        messages: { assetMimeTypes: 'PDF only' },
      },
    }),
    field('gallery', {
      type: 'Array',
      position: 2,
      items: { type: 'Link', linkType: 'Asset' },
      validations: { assetMimeTypes: ['image/*'] },
    }),
  );

  it('names every asset link a rule applies to', () => {
    const checks = assetMimeChecks(ct, {
      doc: { en: { id: 'a1', linkType: 'Asset' } },
      gallery: {
        en: [
          { id: 'a2', linkType: 'Asset' },
          { id: 'e1', linkType: 'Entry' },
        ],
      },
    });
    expect(checks).toEqual([
      {
        field: 'doc',
        locale: 'en',
        assetId: 'a1',
        allowed: ['application/pdf'],
        message: 'PDF only',
      },
      { field: 'gallery[0]', locale: 'en', assetId: 'a2', allowed: ['image/*'] },
    ]);
  });

  it('matches exactly or by family', () => {
    expect(mimeTypeAllowed('image/png', ['image/*'])).toBe(true);
    expect(mimeTypeAllowed('IMAGE/PNG', ['image/png'])).toBe(true);
    expect(mimeTypeAllowed('text/html; charset=utf-8', ['text/html'])).toBe(true);
    expect(mimeTypeAllowed('imagery/png', ['image/*'])).toBe(false);
    expect(mimeTypeAllowed('application/pdf', ['image/*'])).toBe(false);
  });

  it('is refused on anything but an asset link, or when malformed', () => {
    expect(
      refusal(() => typeWith(field('title', { validations: { assetMimeTypes: ['image/*'] } }))),
    ).toMatch(/applies to an asset link/);
    expect(
      refusal(() =>
        typeWith(
          field('title'),
          field('d', {
            type: 'Link',
            linkType: 'Asset',
            validations: { assetMimeTypes: ['images'] },
          }),
        ),
      ),
    ).toMatch(/not a MIME type/);
  });
});

describe('pattern presets', () => {
  it('compile to a screened pattern stored beside the preset’s name', () => {
    const ct = typeWith(
      field('title'),
      field('email', {
        position: 1,
        validations: { regexp: { preset: 'email' } as never },
      }),
    );
    expect(ct.fields[1]?.validations?.regexp).toEqual({
      pattern: PATTERN_PRESETS.email.pattern,
      preset: 'email',
    });
    expect(issues(ct, { email: 'ada@example.com' })).toEqual([]);
    expect(issues(ct, { email: 'ada' })).toHaveLength(1);
  });

  it('every preset passes the regex screen and matches what it says', () => {
    for (const p of Object.values(PATTERN_PRESETS)) {
      expect(unsafeRegexReason(p.pattern, 'flags' in p ? p.flags : undefined)).toBeNull();
    }
    const test = (name: keyof typeof PATTERN_PRESETS, value: string) => {
      const p = PATTERN_PRESETS[name];
      return new RegExp(p.pattern, 'flags' in p ? p.flags : undefined).test(value);
    };
    expect(test('url', 'https://example.com/a?b#c')).toBe(true);
    expect(test('url', 'ftp://example.com')).toBe(false);
    expect(test('slug', 'hello-world-2')).toBe(true);
    expect(test('slug', 'hello--world')).toBe(false);
    expect(test('slug', '-hello')).toBe(false);
    expect(test('phone', '+14155550123')).toBe(true);
    expect(test('hexColor', '#ABCDEF')).toBe(true);
    expect(test('usZipCode', '12345-6789')).toBe(true);
  });

  it('every preset stays fast on a 100,000-character value built to make it backtrack', () => {
    const n = 100_000;
    const hostile = [
      `a@${'a.'.repeat(n / 2)}@`,
      `a@${'.'.repeat(n)} `,
      `${'a'.repeat(n)}!`,
      `http://${'a'.repeat(n)} `,
      `https://a/${'?'.repeat(n)} `,
      `${'a-'.repeat(n / 2)}-`,
      `${'-'.repeat(n)}a`,
      `+1${'1'.repeat(n)}`,
      `#${'a'.repeat(n)}`,
      `${'1'.repeat(n)}-`,
    ];
    for (const [name, p] of Object.entries(PATTERN_PRESETS)) {
      const re = new RegExp(p.pattern, 'flags' in p ? p.flags : undefined);
      const started = performance.now();
      for (const value of hostile) re.test(value);
      // Linear patterns take well under a millisecond each here; a quadratic one takes seconds.
      expect(performance.now() - started, name).toBeLessThan(250);
    }
  });

  it('refuses a value too long to run its pattern against, before matching it', () => {
    const ct = stored(field('code', { position: 1, validations: { regexp: { pattern: '^a+$' } } }));
    expect(issues(ct, { title: 'x', code: 'a'.repeat(MAX_REGEXP_INPUT) })).toEqual([]);
    expect(issues(ct, { title: 'x', code: 'a'.repeat(MAX_REGEXP_INPUT + 1) })).toEqual([
      `code: Too long to check against its pattern (at most ${MAX_REGEXP_INPUT} characters)`,
    ]);
  });

  it('the email preset takes ordinary addresses, and needs a dot after a named domain', () => {
    const re = new RegExp(PATTERN_PRESETS.email.pattern);
    expect(re.test('ada.lovelace+cw@mail.example.co.uk')).toBe(true);
    expect(re.test('ada@example')).toBe(false);
    expect(re.test('ada@.example.com')).toBe(false);
    expect(re.test('ada lovelace@example.com')).toBe(false);
  });

  it('a preset wins over a stale pattern, and an unknown one is refused by name', () => {
    const ct = typeWith(
      field('title'),
      field('site', {
        position: 1,
        validations: { regexp: { pattern: 'old', preset: 'url' } },
      }),
    );
    expect(ct.fields[1]?.validations?.regexp?.pattern).toBe(PATTERN_PRESETS.url.pattern);
    expect(
      refusal(() =>
        typeWith(field('title', { validations: { regexp: { preset: 'iban' } as never } })),
      ),
    ).toMatch(/Unknown pattern preset "iban"/);
  });
  it('a stored rule rides along a revision that leaves it alone, and compiles once changed', () => {
    // As an earlier release compiled it: the preset's name beside a pattern it has since changed.
    const earlier = { preset: 'email', pattern: '^old@pattern$' } as const;
    const ct = stored(field('email', { position: 1, validations: { regexp: earlier } }));
    const renamed = reviseContentType(ct, { name: 'Renamed', fields: [...ct.fields] });
    expect(renamed.fields[1]?.validations?.regexp).toEqual(earlier);
    const changed = reviseContentType(ct, {
      fields: [
        ct.fields[0] as FieldDefinition,
        field('email', { position: 1, validations: { regexp: { preset: 'email' } } }),
      ],
    });
    expect(changed.fields[1]?.validations?.regexp).toEqual({
      pattern: PATTERN_PRESETS.email.pattern,
      preset: 'email',
    });
  });
});

describe('normalizeLegacyFields and the new settings', () => {
  it('drops what a field cannot use and keeps the rest', () => {
    const [title, day, doc] = normalizeLegacyFields([
      field('title', {
        format: 'date',
        validations: { regexp: { pattern: 'x', preset: 'nope' as never } },
      }),
      field('day', {
        type: 'Date',
        format: 'date',
        validations: { dateRange: { min: 'later' } },
      }),
      field('doc', {
        type: 'Link',
        linkType: 'Asset',
        validations: { assetMimeTypes: ['application/pdf'] },
      }),
    ]);
    expect(title).not.toHaveProperty('format');
    expect(title?.validations?.regexp).toEqual({ pattern: 'x' });
    expect(day?.format).toBe('date');
    expect(day).not.toHaveProperty('validations');
    expect(doc?.validations?.assetMimeTypes).toEqual(['application/pdf']);
  });
});
