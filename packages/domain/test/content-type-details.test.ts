import { describe, expect, it } from 'vitest';
import {
  CONTENT_TYPE_LIMITS,
  type ContentTypeLayout,
  defineContentType,
  type FieldDefinition,
  layoutTabs,
  reviseContentType,
  ValidationError,
} from '../src/index';

const field = (apiId: string, position = 0): FieldDefinition => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required: false,
  position,
});

const FIELDS = [field('title'), field('summary', 1), field('body', 2), field('seoTitle', 3)];

const define = (extra: Record<string, unknown> = {}) =>
  defineContentType({
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: FIELDS,
    ...extra,
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

const LAYOUT: ContentTypeLayout = {
  tabs: [
    { apiId: 'content', name: 'Content', groups: [{ fields: ['title', 'body'] }] },
    {
      apiId: 'seo',
      name: 'SEO',
      groups: [{ name: 'Search', fields: ['seoTitle'], collapsed: true }],
    },
  ],
};

describe('content type group, description and icon', () => {
  it('are kept trimmed, and a revision keeps or clears them', () => {
    const ct = define({ group: ' Editorial ', description: 'Long reads.', icon: 'newspaper' });
    expect(ct).toMatchObject({ group: 'Editorial', description: 'Long reads.', icon: 'newspaper' });
    const kept = reviseContentType(ct, { name: 'Articles' });
    expect(kept).toMatchObject({ group: 'Editorial', icon: 'newspaper' });
    const cleared = reviseContentType(ct, { group: null, description: '', icon: null });
    expect(cleared).not.toHaveProperty('group');
    expect(cleared).not.toHaveProperty('description');
    expect(cleared).not.toHaveProperty('icon');
  });

  it('keeps agent instructions as written, and a revision keeps or clears them', () => {
    const agentInstructions = '  Keep titles short.\n\nNever invent quotes.';
    const ct = define({ agentInstructions });
    expect(ct.agentInstructions).toBe(agentInstructions);
    expect(reviseContentType(ct, { name: 'Articles' }).agentInstructions).toBe(agentInstructions);
    expect(reviseContentType(ct, { agentInstructions: null })).not.toHaveProperty(
      'agentInstructions',
    );
    expect(reviseContentType(ct, { agentInstructions: '  ' })).not.toHaveProperty(
      'agentInstructions',
    );
  });

  it('caps agent instructions', () => {
    const agentInstructions = 'a'.repeat(CONTENT_TYPE_LIMITS.agentInstructions + 1);
    expect(refusal(() => define({ agentInstructions }))).toMatch(
      /agentInstructions must be at most 4000/,
    );
  });

  it('are capped, and an icon is a kebab-case name', () => {
    expect(refusal(() => define({ group: 'g'.repeat(CONTENT_TYPE_LIMITS.group + 1) }))).toMatch(
      /group must be at most 100/,
    );
    expect(refusal(() => define({ icon: 'News Paper' }))).toMatch(/kebab-case/);
    expect(refusal(() => define({ description: 42 }))).toMatch(/description must be text/);
  });

  it('a value stored before the checks passes a revision unchanged', () => {
    const legacy = { ...define(), icon: 'Odd Icon' };
    expect(reviseContentType(legacy, { name: 'x', icon: 'Odd Icon' }).icon).toBe('Odd Icon');
  });
});

describe('content type layout', () => {
  it('is kept as written', () => {
    expect(define({ layout: LAYOUT }).layout).toEqual(LAYOUT);
  });

  it('refuses an unknown field, a field placed twice, and bad tabs', () => {
    const one = (groups: unknown) => ({ tabs: [{ apiId: 'a', name: 'A', groups }] });
    expect(refusal(() => define({ layout: one([{ fields: ['nope'] }]) }))).toMatch(
      /places "nope", which is not a field/,
    );
    expect(refusal(() => define({ layout: one([{ fields: ['title', 'title'] }]) }))).toMatch(
      /places "title" twice/,
    );
    expect(refusal(() => define({ layout: { tabs: [] } }))).toMatch(/at least one tab/);
    expect(
      refusal(() =>
        define({
          layout: {
            tabs: [
              { apiId: 'a', name: 'A', groups: [{ fields: ['title'] }] },
              { apiId: 'a', name: 'B', groups: [{ fields: ['body'] }] },
            ],
          },
        }),
      ),
    ).toMatch(/Duplicate tab apiId/);
    expect(
      refusal(() => define({ layout: { tabs: [{ apiId: 'a', name: ' ', groups: [] }] } })),
    ).toMatch(/needs a name/);
  });

  it('loses a field a revision removes, and a group or tab left empty', () => {
    const ct = define({ layout: LAYOUT });
    const revised = reviseContentType(ct, {
      fields: FIELDS.filter((f) => f.apiId !== 'seoTitle'),
      layout: LAYOUT,
    });
    expect(revised.layout?.tabs.map((t) => t.apiId)).toEqual(['content']);
    // Carried over without being sent: pruned the same way.
    const carried = reviseContentType(ct, { fields: FIELDS.filter((f) => f.apiId !== 'body') });
    expect(carried.layout?.tabs[0]?.groups[0]?.fields).toEqual(['title']);
    expect(reviseContentType(ct, { layout: null })).not.toHaveProperty('layout');
  });

  it('prunes a name the stored layout held without a field when it is sent back, and refuses a new one', () => {
    // As stored by hand, or before the checks: a layout naming a field the type no longer has.
    const ct = {
      ...define(),
      layout: { tabs: [{ apiId: 'main', name: 'Main', groups: [{ fields: ['title', 'gone'] }] }] },
    };
    const sentBack = reviseContentType(ct, { name: 'Renamed', layout: ct.layout });
    expect(sentBack.layout?.tabs[0]?.groups[0]?.fields).toEqual(['title']);
    expect(
      refusal(() =>
        reviseContentType(ct, {
          layout: { tabs: [{ apiId: 'main', name: 'Main', groups: [{ fields: ['typo'] }] }] },
        }),
      ),
    ).toMatch(/typo/);
  });

  it('layoutTabs puts every unplaced field at the end of the first tab', () => {
    const ct = define({ layout: LAYOUT });
    const tabs = layoutTabs(ct.fields, ct.layout);
    expect(tabs.map((t) => t.name)).toEqual(['Content', 'SEO']);
    expect(tabs[0]?.groups.map((g) => g.fields.map((f) => f.apiId))).toEqual([
      ['title', 'body'],
      ['summary'],
    ]);
    expect(tabs[1]?.groups[0]).toMatchObject({ name: 'Search', collapsed: true });
    // Without a layout: one tab of every field.
    const plain = layoutTabs(ct.fields, undefined);
    expect(plain).toHaveLength(1);
    expect(plain[0]?.groups[0]?.fields).toHaveLength(4);
  });

  it('layoutTabs skips a name a stale layout still holds', () => {
    const tabs = layoutTabs(FIELDS, {
      tabs: [{ apiId: 'a', name: 'A', groups: [{ fields: ['gone', 'title'] }] }],
    });
    expect(tabs[0]?.groups[0]?.fields.map((f) => f.apiId)).toEqual(['title']);
  });
});
