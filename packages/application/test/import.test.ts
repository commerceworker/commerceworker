import {
  ForbiddenError,
  NotFoundError,
  type Principal,
  rolePresetDefinition,
  SCOPES,
  ValidationError,
} from '@commerceworker/domain';
import type { ImportSource, SourceReadResult } from '@commerceworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  analyzeImport,
  createContentType,
  createEntry,
  executeImport,
  IMPORT_MAX_RECORDS,
  type ImportInput,
  listPreviewEntries,
  planImport,
  publishContentType,
  SYSTEM_CALLER,
  trashEntry,
} from '../src/index';

const SPACE = 's1';
const scope = { spaceId: SPACE, environmentId: 'main' };
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
let ctx: AppContext;

/** A person whose role holds `content:write` and these grants. */
const asRole = (contentGrants: Principal['contentGrants']): Principal => ({
  spaceId: SPACE,
  kind: 'user',
  scopes: [SCOPES.contentWrite],
  ...(contentGrants ? { contentGrants } : {}),
});

/** A source that hands back exactly what a test wrote, so the pipeline is what is under test. */
function fakeSource(result: Partial<SourceReadResult>): ImportSource {
  return {
    id: 'fake',
    name: 'Fake',
    async read() {
      return { records: [], fields: [], warnings: [], ...result };
    },
  };
}

const rows = (values: Record<string, unknown>[]): ImportSource =>
  fakeSource({
    records: values.map((v, i) => ({ externalId: `x${i + 1}`, values: v })),
    fields: [...new Set(values.flatMap((v) => Object.keys(v)))],
  });

/**
 * The actionable text of a refusal. `ValidationError.message` is the generic
 * "one or more fields are invalid"; the reason lives in `issues`, which is what
 * the API serializes.
 */
const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (err) {
    return err instanceof ValidationError ? (err.issues[0]?.message ?? '') : String(err);
  }
  return '';
};

const input = (over: Partial<ImportInput> = {}): ImportInput => ({
  payload: '',
  mapping: {
    contentTypeApiId: 'article',
    fields: { title: 'name' },
    ...over.mapping,
  },
  ...over,
});

beforeEach(async () => {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: SPACE, defaultLocale: 'en-US', locales: ['en-US', 'de-DE'] });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
      {
        apiId: 'views',
        name: 'Views',
        type: 'Integer',
        localized: false,
        required: false,
        position: 1,
      },
      {
        apiId: 'featured',
        name: 'Featured',
        type: 'Boolean',
        localized: false,
        required: false,
        position: 2,
      },
      { apiId: 'sku', name: 'SKU', type: 'Symbol', localized: false, required: false, position: 3 },
      {
        apiId: 'body',
        name: 'Body',
        type: 'RichText',
        localized: false,
        required: false,
        position: 4,
      },
    ],
  } as Parameters<typeof createContentType>[3]);
  await publishContentType(ctx, scope, 'article');
});

describe('analyze writes nothing', () => {
  it('reports what would be created without creating it', async () => {
    const source = rows([{ name: 'One' }, { name: 'Two' }]);
    const analysis = await analyzeImport(ctx, admin, scope, source, input());

    expect(analysis).toMatchObject({ records: 2, willCreate: 2, willUpdate: 0, invalid: 0 });
    expect(await listPreviewEntries(ctx, scope, {})).toHaveLength(0);
  });

  it('names the source fields nothing maps to', async () => {
    const source = rows([{ name: 'One', excerpt: 'lost', author: 'also lost' }]);
    const analysis = await analyzeImport(ctx, admin, scope, source, input());
    // "I lost the excerpt column" is only findable before the run.
    expect(analysis.unmappedSourceFields).toEqual(['excerpt', 'author']);
  });

  it('carries the source’s own warnings through', async () => {
    const source = fakeSource({ records: [], fields: [], warnings: ['Row 4 was unreadable'] });
    expect((await analyzeImport(ctx, admin, scope, source, input())).warnings).toEqual([
      'Row 4 was unreadable',
    ]);
  });
});

describe('a mapping that cannot work', () => {
  it('blocks when a required field has no source', async () => {
    const source = rows([{ name: 'One' }]);
    const analysis = await analyzeImport(
      ctx,
      admin,
      scope,
      source,
      input({ mapping: { contentTypeApiId: 'article', fields: { views: 'name' } } }),
    );
    expect(analysis.missingRequiredFields).toEqual(['title']);
    expect(analysis.executable).toBe(false);
  });

  it('blocks when a target field does not exist', async () => {
    const analysis = await analyzeImport(
      ctx,
      admin,
      scope,
      rows([{ name: 'One' }]),
      input({ mapping: { contentTypeApiId: 'article', fields: { title: 'name', nope: 'name' } } }),
    );
    expect(analysis.unknownTargetFields).toEqual(['nope']);
    expect(analysis.executable).toBe(false);
  });

  it('refuses to execute a blocked mapping rather than importing half of it', async () => {
    await expect(
      executeImport(
        ctx,
        admin,
        scope,
        rows([{ name: 'One' }]),
        input({ mapping: { contentTypeApiId: 'article', fields: { views: 'name' } } }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('404s on a content type that is not there', async () => {
    await expect(
      analyzeImport(
        ctx,
        admin,
        scope,
        rows([]),
        input({ mapping: { contentTypeApiId: 'ghost', fields: {} } }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a locale the space does not have', async () => {
    expect(
      await refusal(
        analyzeImport(
          ctx,
          admin,
          scope,
          rows([]),
          input({ mapping: { contentTypeApiId: 'article', fields: {}, locale: 'fr-FR' } }),
        ),
      ),
    ).toMatch(/fr-FR/);
  });
});

describe('a record that cannot be written', () => {
  it('is reported, not thrown', async () => {
    const source = rows([{ name: 'Fine' }, { other: 'no title' }]);
    const analysis = await analyzeImport(ctx, admin, scope, source, input());
    expect(analysis.invalid).toBe(1);
    expect(analysis.issues[0]?.messages[0]).toMatch(/title.*required/i);
    // One bad row does not block the good ones.
    expect(analysis.executable).toBe(true);
    expect(analysis.willCreate).toBe(1);
  });

  it('is skipped by execute, leaving the rest imported', async () => {
    const result = await executeImport(ctx, admin, scope, rows([{ name: 'Fine' }, {}]), input());
    expect(result).toMatchObject({ created: 1, skipped: 1 });
    expect(await listPreviewEntries(ctx, scope, {})).toHaveLength(1);
  });

  it('catches a repeated identity in the payload itself', async () => {
    const source = fakeSource({
      records: [
        { externalId: 'same', values: { name: 'One' } },
        { externalId: 'same', values: { name: 'Two' } },
      ],
      fields: ['name'],
    });
    // Otherwise the same thing imports twice and the run looks like it worked.
    const analysis = await analyzeImport(ctx, admin, scope, source, input());
    expect(analysis.issues[0]?.messages[0]).toMatch(/duplicate identity/i);
  });
});

describe('coercing what a spreadsheet gives you', () => {
  const mapping = {
    contentTypeApiId: 'article',
    fields: { title: 'name', views: 'hits', featured: 'star' },
  };

  it('turns a numeric string into a number', async () => {
    const result = await executeImport(
      ctx,
      admin,
      scope,
      rows([{ name: 'One', hits: '42' }]),
      input({ mapping }),
    );
    expect(result.created).toBe(1);
    const [entry] = await listPreviewEntries(ctx, scope, {});
    expect(entry?.fields.views?.['en-US']).toBe(42);
  });

  it('reads the ways a sheet spells true', async () => {
    await executeImport(
      ctx,
      admin,
      scope,
      rows([
        { name: 'One', star: 'yes' },
        { name: 'Two', star: 'FALSE' },
      ]),
      input({ mapping }),
    );
    const entries = await listPreviewEntries(ctx, scope, {});
    const byTitle = new Map(entries.map((e) => [e.fields.title?.['en-US'], e.fields.featured]));
    expect(byTitle.get('One')?.['en-US']).toBe(true);
    expect(byTitle.get('Two')?.['en-US']).toBe(false);
  });

  it('reads text for a rich-text field as HTML', async () => {
    // What a blog export holds; plain prose in a cell is the same thing with no tags.
    const result = await executeImport(
      ctx,
      admin,
      scope,
      rows([{ name: 'One', html: '<p>Hello <strong>there</strong></p>' }]),
      input({ mapping: { contentTypeApiId: 'article', fields: { title: 'name', body: 'html' } } }),
    );
    expect(result).toMatchObject({ created: 1, failed: [] });
    const [entry] = await listPreviewEntries(ctx, scope, {});
    expect(entry?.fields.body?.['en-US']).toEqual({
      nodeType: 'document',
      data: {},
      content: [
        {
          nodeType: 'paragraph',
          data: {},
          content: [
            { nodeType: 'text', value: 'Hello ', marks: [], data: {} },
            { nodeType: 'text', value: 'there', marks: [{ type: 'bold' }], data: {} },
          ],
        },
      ],
    });
  });

  it('treats markup with no text in it as no value', async () => {
    // An empty editor block is not content; storing it would satisfy a
    // required rich-text field with a blank document.
    const result = await executeImport(
      ctx,
      admin,
      scope,
      rows([{ name: 'One', html: '<!-- wp:paragraph --><p></p><!-- /wp:paragraph -->' }]),
      input({ mapping: { contentTypeApiId: 'article', fields: { title: 'name', body: 'html' } } }),
    );
    expect(result.created).toBe(1);
    const [entry] = await listPreviewEntries(ctx, scope, {});
    expect(entry?.fields.body).toBeUndefined();
  });

  it('reports a rich-text value that is neither text nor a document', async () => {
    const analysis = await analyzeImport(
      ctx,
      admin,
      scope,
      rows([{ name: 'One', body: 42 }]),
      input({ mapping: { contentTypeApiId: 'article', fields: { title: 'name', body: 'body' } } }),
    );
    expect(analysis.invalid).toBe(1);
    expect(analysis.issues[0]?.messages[0]).toMatch(/body/);
  });

  it('leaves a value that is already a rich-text document alone', async () => {
    const doc = { nodeType: 'document', data: {}, content: [] };
    await executeImport(
      ctx,
      admin,
      scope,
      rows([{ name: 'One', body: doc }]),
      input({ mapping: { contentTypeApiId: 'article', fields: { title: 'name', body: 'body' } } }),
    );
    const [entry] = await listPreviewEntries(ctx, scope, {});
    expect(entry?.fields.body?.['en-US']).toEqual(doc);
  });

  it('reports a value it cannot convert instead of quietly emptying the field', async () => {
    const analysis = await analyzeImport(
      ctx,
      admin,
      scope,
      rows([{ name: 'One', hits: 'lots' }]),
      input({ mapping }),
    );
    expect(analysis.invalid).toBe(1);
    expect(analysis.issues[0]?.messages[0]).toMatch(/views/);
  });

  it('leaves an empty cell as no value rather than an empty string', async () => {
    await executeImport(ctx, admin, scope, rows([{ name: 'One', hits: '' }]), input({ mapping }));
    const [entry] = await listPreviewEntries(ctx, scope, {});
    expect(entry?.fields.views).toBeUndefined();
  });
});

describe('running the same import twice', () => {
  const mapping = {
    contentTypeApiId: 'article',
    fields: { title: 'name', sku: 'code' },
    identityField: 'sku',
  };
  const payload = rows([{ name: 'One', code: 'A-1' }]);

  it('duplicates everything when nothing identifies a record', async () => {
    // Stated by the analysis rather than left to be discovered on run two.
    await executeImport(ctx, admin, scope, rows([{ name: 'One' }]), input());
    await executeImport(ctx, admin, scope, rows([{ name: 'One' }]), input());
    expect(await listPreviewEntries(ctx, scope, {})).toHaveLength(2);
  });

  it('recognises what it already imported and leaves it alone by default', async () => {
    await executeImport(ctx, admin, scope, payload, input({ mapping }));
    const second = await executeImport(ctx, admin, scope, payload, input({ mapping }));

    expect(second).toMatchObject({ created: 0, skipped: 1 });
    expect(await listPreviewEntries(ctx, scope, {})).toHaveLength(1);
  });

  it('updates the matched entry when asked to', async () => {
    await executeImport(ctx, admin, scope, payload, input({ mapping }));
    const changed = rows([{ name: 'Renamed', code: 'A-1' }]);
    const second = await executeImport(ctx, admin, scope, changed, input({ mapping }), {
      conflicts: 'update',
    });

    expect(second).toMatchObject({ created: 0, updated: 1 });
    const [entry] = await listPreviewEntries(ctx, scope, {});
    expect(entry?.fields.title?.['en-US']).toBe('Renamed');
  });

  it('refuses the conflicting record when told to fail', async () => {
    await executeImport(ctx, admin, scope, payload, input({ mapping }));
    const second = await executeImport(ctx, admin, scope, payload, input({ mapping }), {
      conflicts: 'fail',
    });
    expect(second.analysis.issues[0]?.messages[0]).toMatch(/already exists/i);
    expect(second.skipped).toBe(1);
  });

  it('does not match against something that was trashed', async () => {
    await executeImport(ctx, admin, scope, payload, input({ mapping }));
    const [entry] = await listPreviewEntries(ctx, scope, {});
    await trashEntry(ctx, scope, entry?.id ?? '');

    const second = await executeImport(ctx, admin, scope, payload, input({ mapping }));
    // Matching trash would silently revive what someone deleted.
    expect(second.created).toBe(1);
  });
});

describe('the analysis and the run cannot disagree', () => {
  it('reports the same counts it then produces', async () => {
    const source = rows([{ name: 'One' }, { name: 'Two' }, {}]);
    const analysis = await analyzeImport(ctx, admin, scope, source, input());
    const result = await executeImport(ctx, admin, scope, source, input());

    expect(result.created).toBe(analysis.willCreate);
    expect(result.skipped).toBe(analysis.willSkip);
  });

  it('re-analyzes rather than acting on what it was told earlier', async () => {
    const mapping = {
      contentTypeApiId: 'article',
      fields: { title: 'name', sku: 'code' },
      identityField: 'sku',
    };
    const source = rows([{ name: 'One', code: 'A-1' }]);
    // Analysis says "create"...
    expect((await analyzeImport(ctx, admin, scope, source, input({ mapping }))).willCreate).toBe(1);
    // ...then the entry appears from somewhere else.
    await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Arrived' }, sku: { 'en-US': 'A-1' } },
    });
    const result = await executeImport(ctx, admin, scope, source, input({ mapping }));
    // Acting on the stale plan would have created a duplicate.
    expect(result.created).toBe(0);
  });
});

describe('bounds', () => {
  it('refuses to write more than the synchronous path can hold', async () => {
    const many = Array.from({ length: IMPORT_MAX_RECORDS + 1 }, (_, i) => ({ name: `n${i}` }));
    expect(await refusal(executeImport(ctx, admin, scope, rows(many), input()))).toMatch(
      /split the file/i,
    );
  });

  it('still describes a file too big to write in one request', async () => {
    // Analysis writes nothing, so its bound is memory, not time. Refusing to
    // describe a file the durable path would import would leave an operator
    // unable to find out how big their problem is.
    const many = Array.from({ length: IMPORT_MAX_RECORDS + 1 }, (_, i) => ({ name: `n${i}` }));
    const analysis = await analyzeImport(ctx, admin, scope, rows(many), input());
    expect(analysis.records).toBe(IMPORT_MAX_RECORDS + 1);
  });

  it('lists only a bounded sample of per-record problems', async () => {
    const broken = Array.from({ length: 150 }, () => ({ other: 'no title' }));
    const analysis = await analyzeImport(ctx, admin, scope, rows(broken), input());
    expect(analysis.invalid).toBe(150);
    expect(analysis.issues.length).toBeLessThanOrEqual(100);
  });
});

describe('defaults', () => {
  beforeEach(async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
        {
          apiId: 'state',
          name: 'State',
          type: 'Symbol',
          localized: false,
          required: false,
          defaultValue: 'fresh',
          position: 1,
        },
      ],
    } as Parameters<typeof createContentType>[3]);
    await publishContentType(ctx, scope, 'note');
  });

  const mapped = input({
    mapping: { contentTypeApiId: 'note', fields: { title: 'name' }, identityField: 'title' },
  });

  it('fills a new entry, and leaves an update alone', async () => {
    const created = await executeImport(ctx, admin, scope, rows([{ name: 'One' }]), mapped);
    expect(created).toMatchObject({ created: 1 });
    const [first] = await listPreviewEntries(ctx, scope, { contentTypeApiId: 'note' });
    expect(first?.fields.state).toEqual({ 'en-US': 'fresh' });

    const updated = await executeImport(ctx, admin, scope, rows([{ name: 'One' }]), mapped, {
      conflicts: 'update',
    });
    expect(updated).toMatchObject({ updated: 1 });
    const [second] = await listPreviewEntries(ctx, scope, { contentTypeApiId: 'note' });
    expect(second?.fields.state).toBeUndefined();
  });

  it('plans an update without them, and a skip as the create it would have been', async () => {
    await executeImport(ctx, admin, scope, rows([{ name: 'One' }]), mapped);
    const source = rows([{ name: 'One' }]);
    const planned = await planImport(ctx, admin, scope, source, mapped, { conflicts: 'update' });
    expect(planned.planned[0]?.fields).not.toHaveProperty('state');
    const skipped = await planImport(ctx, admin, scope, source, mapped);
    expect(skipped.planned[0]).toMatchObject({ action: 'skip', issues: [] });
  });
});

describe('importing as a role', () => {
  const writes = (over: Record<string, unknown> = {}) => [
    { contentTypeApiId: 'article', actions: ['read', 'write'] as const, ...over },
  ];
  const onlyPost = asRole([{ contentTypeApiId: 'post', actions: ['read', 'write'] }]);

  it('refuses a type the role cannot write, up front, at both phases', async () => {
    const source = rows([{ name: 'One' }]);
    await expect(analyzeImport(ctx, onlyPost, scope, source, input())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(executeImport(ctx, onlyPost, scope, source, input())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await listPreviewEntries(ctx, scope, {})).toHaveLength(0);
  });

  it('refuses a read-only grant on the target type', async () => {
    const reader = asRole([{ contentTypeApiId: 'article', actions: ['read'] }]);
    await expect(
      executeImport(ctx, reader, scope, rows([{ name: 'One' }]), input()),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses a principal without content:write, whatever its grants', async () => {
    const noScope = { ...asRole(undefined), scopes: [SCOPES.previewRead] };
    await expect(
      analyzeImport(ctx, noScope, scope, rows([{ name: 'One' }]), input()),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each([
    ['denies', { deniedFields: ['sku'] }],
    ['makes read-only', { readOnlyFields: ['sku'] }],
  ])('reports and skips a record setting a field the role %s', async (_, rule) => {
    const role = asRole(writes(rule));
    const source = rows([{ name: 'Clean' }, { name: 'Sets it', code: 'secret' }]);
    const mapped = input({
      mapping: { contentTypeApiId: 'article', fields: { title: 'name', sku: 'code' } },
    });

    const analysis = await analyzeImport(ctx, role, scope, source, mapped);
    expect(analysis).toMatchObject({ willCreate: 1, invalid: 1, executable: true });
    expect(analysis.issues).toEqual([
      { externalId: 'x2', messages: ['sku: your role may not write this field'] },
    ]);

    const result = await executeImport(ctx, role, scope, source, mapped);
    expect(result).toMatchObject({ created: 1, skipped: 1 });
    const written = await listPreviewEntries(ctx, scope, {});
    expect(written).toHaveLength(1);
    expect(JSON.stringify(written)).not.toContain('secret');
  });

  it('holds an update of an existing entry to the same rule', async () => {
    const created = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Kept' }, views: { 'en-US': 1 } },
    });
    const role = asRole(writes({ readOnlyFields: ['views'] }));
    const result = await executeImport(
      ctx,
      role,
      scope,
      rows([{ name: 'Kept', hits: 999 }]),
      input({
        mapping: {
          contentTypeApiId: 'article',
          fields: { title: 'name', views: 'hits' },
          identityField: 'title',
        },
      }),
      { conflicts: 'update' },
    );
    expect(result).toMatchObject({ updated: 0, skipped: 1 });
    const [entry] = await listPreviewEntries(ctx, scope, {});
    expect(entry?.id).toBe(created.entry.id);
    expect(entry?.fields.views).toEqual({ 'en-US': 1 });
  });

  it('keeps a blocked field through an update, and the report says nothing of it', async () => {
    // An update's fields are the whole new version: a mapping that omits the field would wipe it.
    // Nor may the outcome differ with what the field holds, or it answers whether it holds any.
    const role = asRole(writes({ deniedFields: ['views'] }));
    const run = (name: string) =>
      executeImport(
        ctx,
        role,
        scope,
        rows([{ name, code: 'new' }]),
        input({
          mapping: {
            contentTypeApiId: 'article',
            fields: { title: 'name', sku: 'code' },
            identityField: 'title',
          },
        }),
        { conflicts: 'update' },
      );
    const held = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Same' }, views: { 'en-US': 1 } },
    });
    const withValue = await run('Same');
    const version = await ctx.store.entries.get(scope, held.entry.id);
    expect(version?.fields.views).toEqual({ 'en-US': 1 });
    expect(version?.fields.sku).toEqual({ 'en-US': 'new' });

    await trashEntry(ctx, scope, held.entry.id);
    const bare = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Same' } },
    });
    const withoutValue = await run('Same');
    expect(withoutValue).toEqual(withValue);
    expect(withValue).toMatchObject({ updated: 1, skipped: 0 });
    const after = await ctx.store.entries.get(scope, bare.entry.id);
    expect(after?.fields.views).toBeUndefined();
  });

  it('needs `read` on the type to match on an identity field', async () => {
    // Otherwise a write-only grant could test which values exist through the skip count.
    const writeOnly = asRole([{ contentTypeApiId: 'article', actions: ['write'] }]);
    const source = rows([{ name: 'Probe' }]);
    await expect(
      analyzeImport(
        ctx,
        writeOnly,
        scope,
        source,
        input({
          mapping: {
            contentTypeApiId: 'article',
            fields: { title: 'name' },
            identityField: 'title',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await analyzeImport(ctx, writeOnly, scope, source, input())).toMatchObject({
      willCreate: 1,
    });
  });

  it('refuses matching on an identity field the role cannot read', async () => {
    // The skip and conflict counts would otherwise answer which values the field holds.
    await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Existing' }, sku: { 'en-US': 'A-1' } },
    });
    const role = asRole(writes({ deniedFields: ['sku'] }));
    await expect(
      analyzeImport(
        ctx,
        role,
        scope,
        rows([{ name: 'Probe', code: 'A-1' }]),
        input({
          mapping: {
            contentTypeApiId: 'article',
            fields: { title: 'name', sku: 'code' },
            identityField: 'sku',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('imports for a role whose grant covers the type', async () => {
    const result = await executeImport(
      ctx,
      asRole(writes({ deniedFields: ['sku'] })),
      scope,
      rows([{ name: 'One' }]),
      input(),
    );
    expect(result).toMatchObject({ created: 1, skipped: 0 });
  });

  it('leaves unrestricted principals and the Editor preset as they were', async () => {
    const source = rows([{ name: 'One', code: 'A' }]);
    const mapped = input({
      mapping: { contentTypeApiId: 'article', fields: { title: 'name', sku: 'code' } },
    });
    const noRole = await executeImport(ctx, asRole(undefined), scope, source, mapped);
    expect(noRole).toMatchObject({ created: 1, skipped: 0 });
    const editor = asRole(rolePresetDefinition('editor').contentGrants);
    expect(await executeImport(ctx, editor, scope, source, mapped)).toMatchObject({
      created: 1,
      skipped: 0,
    });
  });
});
