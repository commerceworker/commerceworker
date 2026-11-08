import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentType, ContentTypeDraft } from '@commerceworker/sdk-management';
import { describe, expect, it } from 'vitest';
import { loadModel, normalizeDraft, planModel, renderModel, toDrafts } from '../src/model.js';
import { EXIT } from '../src/output.js';
import { type Call, harness, status } from './harness.js';

const field = (apiId: string, type = 'Symbol', extra: Record<string, unknown> = {}) => ({
  apiId,
  name: apiId,
  type,
  localized: false,
  required: false,
  position: 0,
  ...extra,
});

const live = (draft: ContentTypeDraft, version = 3): ContentType =>
  ({
    ...normalizeDraft(draft),
    version,
    status: 'published',
  }) as ContentType;

const article: ContentTypeDraft = {
  apiId: 'article',
  name: 'Article',
  displayField: 'title',
  fields: [field('title'), { ...field('body', 'RichText'), position: 1 }],
};

const page: ContentTypeDraft = {
  apiId: 'page',
  name: 'Page',
  displayField: 'title',
  fields: [
    field('title'),
    {
      ...field('sections', 'Array'),
      position: 1,
      items: {
        type: 'Component',
        variants: [
          { apiId: 'hero', name: 'Hero', fields: [field('heading')] },
          { apiId: 'cta', name: 'Call to action', fields: [field('label')] },
        ],
      },
    },
  ],
};

describe('planModel', () => {
  it('finds nothing to do when the file matches, whatever its key order or omitted defaults', () => {
    const terse = {
      apiId: 'article',
      displayField: 'title',
      name: 'Article',
      fields: [
        { type: 'Symbol', name: 'title', apiId: 'title' },
        { apiId: 'body', name: 'body', type: 'RichText' },
      ],
    } as unknown as ContentTypeDraft;
    const plan = planModel([normalizeDraft(terse)], [live(article)]);
    expect(plan.changes).toBe(0);
    expect(plan.types[0]?.action).toBe('unchanged');
  });

  it('classifies additions and edits as safe, and removals and reshapes as destructive', () => {
    const next: ContentTypeDraft = {
      ...article,
      name: 'Story',
      fields: [
        { ...field('title'), required: true, validations: { size: { max: 120 } } },
        // body removed, summary added
        { ...field('summary', 'Text'), position: 1 },
      ],
    };
    const plan = planModel([normalizeDraft(next), normalizeDraft(page)], [live(article)]);
    const byPath = Object.fromEntries(plan.types.flatMap((t) => t.changes).map((c) => [c.path, c]));
    expect(byPath.article).toMatchObject({ kind: 'change-type', destructive: false });
    expect(byPath['article.title']).toMatchObject({ kind: 'change-field', destructive: false });
    expect(byPath['article.title']?.detail).toBe('required, validations changed');
    expect(byPath['article.body']).toMatchObject({ kind: 'remove-field', destructive: true });
    expect(byPath['article.summary']).toMatchObject({ kind: 'add-field', destructive: false });
    expect(byPath.page).toMatchObject({ kind: 'add-type', destructive: false });
    expect(plan.types.map((t) => t.action)).toEqual(['update', 'create']);
    expect(plan.destructive).toBe(1);
  });

  it('sees type, localization and item changes, block types and nested fields as destructive', () => {
    const next: ContentTypeDraft = {
      ...page,
      fields: [
        { ...field('title', 'Text'), localized: true },
        {
          ...field('sections', 'Array'),
          position: 1,
          items: {
            type: 'Component',
            variants: [
              // hero loses `heading`, gains `image`; cta is gone; quote is new
              {
                apiId: 'hero',
                name: 'Hero',
                fields: [field('image', 'Link', { linkType: 'Asset' })],
              },
              { apiId: 'quote', name: 'Quote', fields: [field('text', 'Text')] },
            ],
          },
        },
      ],
    };
    const plan = planModel([normalizeDraft(next)], [live(page)]);
    const changes = plan.types[0]?.changes ?? [];
    expect(changes.map((c) => [c.path, c.kind, c.destructive])).toEqual([
      ['page.title', 'change-field', true],
      ['page.sections[cta]', 'remove-variant', true],
      ['page.sections[hero].heading', 'remove-field', true],
      ['page.sections[hero].image', 'add-field', false],
      ['page.sections[quote]', 'add-variant', false],
    ]);
    expect(changes[0]?.detail).toBe('type Symbol → Text, localized false → true');
  });

  it('compares the group, description, icon and layout a file states, and keeps the ones it leaves out', () => {
    const detailed = {
      ...article,
      group: 'Editorial',
      icon: 'newspaper',
      layout: { tabs: [{ apiId: 'main', name: 'Main', groups: [{ fields: ['title'] }] }] },
    };
    expect(planModel([normalizeDraft(article)], [live(detailed)]).changes).toBe(0);
    const plan = planModel(
      [normalizeDraft({ ...detailed, group: 'Magazine', layout: null })],
      [live(detailed)],
    );
    expect(plan.types[0]?.changes.map((c) => c.detail)).toEqual([
      'group "Editorial" → "Magazine"',
      'layout removed',
    ]);
  });

  it('compares agent instructions, and exports them', () => {
    const detailed = { ...article, agentInstructions: 'Stay factual.' };
    expect(toDrafts([live(detailed)])[0]?.agentInstructions).toBe('Stay factual.');
    const plan = planModel(
      [normalizeDraft({ ...detailed, agentInstructions: 'Be brief.' })],
      [live(detailed)],
    );
    expect(plan.types[0]?.changes.map((c) => c.detail)).toEqual([
      'agentInstructions "Stay factual." → "Be brief."',
    ]);
  });

  it('leaves types missing from the file alone, and says so', () => {
    const plan = planModel([normalizeDraft(article)], [live(article), live(page)]);
    expect(plan.untouched).toEqual(['page']);
    expect(plan.changes).toBe(0);
  });
});

describe('model files', () => {
  it('round-trips through JSON and TypeScript', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cw-model-'));
    for (const [name, format] of [
      ['model.json', 'json'],
      ['model.ts', 'ts'],
    ] as const) {
      await writeFile(join(dir, name), renderModel([article, page], format));
      const loaded = await loadModel(name, dir);
      expect(loaded.map((t) => t.apiId)).toEqual(['article', 'page']);
      expect(planModel(loaded, [live(article), live(page)]).changes).toBe(0);
    }
    expect(await readFile(join(dir, 'model.ts'), 'utf8')).toContain('satisfies ContentTypeDraft[]');
    // A bare array and `{ items }` (codegen's input shape) load too.
    await writeFile(join(dir, 'bare.json'), JSON.stringify([article]));
    expect(await loadModel('bare.json', dir)).toHaveLength(1);
    await writeFile(join(dir, 'bad.json'), JSON.stringify({ types: [] }));
    await expect(loadModel('bad.json', dir)).rejects.toThrow(/expected an array/);
  });
});

describe('model apply', () => {
  async function setup(
    current: ContentType[],
    opts: { interactive?: boolean; answers?: string[] } = {},
  ) {
    const writes: Call[] = [];
    const h = await harness(
      {
        'GET /spaces/s1/environments/main/content-types': () => ({ items: current }),
        'POST /spaces/s1/environments/main/content-types': (call) => {
          writes.push(call);
          return { ...JSON.parse(call.body ?? '{}'), version: 4, status: 'draft' };
        },
        'POST /spaces/s1/environments/main/content-types/article/published': (call) => {
          writes.push(call);
          return { ...live(article), version: 4 };
        },
      },
      {
        env: {
          COMMERCEWORKER_TOKEN: 't',
          COMMERCEWORKER_URL: 'https://api.cms.test',
          COMMERCEWORKER_SPACE: 's1',
        },
        ...opts,
      },
    );
    const dir = await mkdtemp(join(tmpdir(), 'cw-apply-'));
    const file = join(dir, 'model.json');
    return { h, writes, file };
  }

  it('--dry-run prints the plan as JSON and writes nothing', async () => {
    const { h, writes, file } = await setup([live(article)]);
    await writeFile(file, renderModel([{ ...article, fields: [field('title')] }], 'json'));
    const out = await h.run('model', 'apply', file, '--dry-run', '--json');
    expect(out.code).toBe(EXIT.ok);
    expect(h.json()).toEqual({
      changes: 1,
      destructive: 1,
      applied: false,
      untouched: [],
      types: [
        {
          apiId: 'article',
          action: 'update',
          changes: [
            {
              path: 'article.body',
              kind: 'remove-field',
              destructive: true,
              detail: 'remove RichText field (its values are lost)',
            },
          ],
        },
      ],
    });
    expect(writes).toEqual([]);
  });

  it('refuses a destructive plan without --allow-destructive (exit 4), even with --yes', async () => {
    const { h, writes, file } = await setup([live(article)]);
    await writeFile(file, renderModel([{ ...article, fields: [field('title')] }], 'json'));
    const out = await h.run('model', 'apply', file, '--yes', '--json');
    expect(out.code).toBe(EXIT.refused);
    const error = JSON.parse(out.stderr).error;
    expect(error.code).toBe('destructive_change');
    expect(error.details.destructive).toBe(1);
    expect(writes).toEqual([]);
  });

  it('never prompts off a terminal: a write needs --yes there (exit 2)', async () => {
    const { h, writes, file } = await setup([live(article)]);
    const next = { ...article, name: 'Story' };
    await writeFile(file, renderModel([next], 'json'));
    expect((await h.run('model', 'apply', file)).code).toBe(EXIT.usage);
    expect(writes).toEqual([]);

    const out = await h.run('model', 'apply', file, '--yes', '--json');
    expect(out.code).toBe(EXIT.ok);
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      'POST /spaces/s1/environments/main/content-types',
      'POST /spaces/s1/environments/main/content-types/article/published',
    ]);
    expect(JSON.parse(writes[0]?.body ?? '{}').name).toBe('Story');
    expect(h.json()).toMatchObject({
      applied: true,
      results: [{ apiId: 'article', action: 'update', version: 4, published: true }],
    });
  });

  it('asks on a terminal, and does nothing on no', async () => {
    const { h, writes, file } = await setup([live(article)], { interactive: true, answers: ['n'] });
    await writeFile(file, renderModel([{ ...article, name: 'Story' }], 'json'));
    expect((await h.run('model', 'apply', file)).code).toBe(EXIT.failure);
    expect(writes).toEqual([]);
  });

  it('--no-publish saves drafts only', async () => {
    const { h, writes, file } = await setup([live(article)]);
    await writeFile(file, renderModel([{ ...article, name: 'Story' }], 'json'));
    expect((await h.run('model', 'apply', file, '--yes', '--no-publish')).code).toBe(EXIT.ok);
    expect(writes.map((w) => w.path)).toEqual(['/spaces/s1/environments/main/content-types']);
  });
  it('reports what already applied when a later type is refused', async () => {
    const h = await harness(
      {
        'GET /spaces/s1/environments/main/content-types': () => ({ items: [] }),
        'POST /spaces/s1/environments/main/content-types': (call) => {
          const body = JSON.parse(call.body ?? '{}');
          return body.apiId === 'page'
            ? status(409, { code: 'conflict', message: 'Field in use' })
            : { ...body, version: 1, status: 'draft' };
        },
        'POST /spaces/s1/environments/main/content-types/article/published': () => live(article, 1),
      },
      {
        env: {
          COMMERCEWORKER_TOKEN: 't',
          COMMERCEWORKER_URL: 'https://api.cms.test',
          COMMERCEWORKER_SPACE: 's1',
        },
      },
    );
    const dir = await mkdtemp(join(tmpdir(), 'cw-apply-'));
    await writeFile(join(dir, 'm.json'), renderModel([article, page], 'json'));
    const out = await h.run('model', 'apply', join(dir, 'm.json'), '--yes', '--json');
    expect(out.code).toBe(EXIT.failure);
    const error = JSON.parse(out.stderr).error;
    expect(error.code).toBe('apply_failed');
    expect(error.details).toMatchObject({
      failed: 'page',
      status: 409,
      applied: [{ apiId: 'article', action: 'create', version: 1, published: true }],
    });
  });
});
