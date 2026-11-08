import { ValidationError } from '@commerceworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
  StubAIProvider,
  StubDecisionModel,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  applyEntryTags,
  autofillField,
  createConcept,
  createContentType,
  createEntry,
  createScheme,
  createSpace,
  createTag,
  getEntry,
  getEntryMetadata,
  listTags,
  SYSTEM_CALLER,
  setEntryMetadata,
  suggestEntryTags,
  summarizeEntry,
  translateEntry,
} from '../src/index';

const scope = { spaceId: 'blog', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  return { ctx };
}

async function seed(ctx: AppContext) {
  await createSpace(ctx, {
    spaceId: 'blog',
    name: 'Blog',
    defaultLocale: 'en-US',
    locales: ['en-US', 'fr-FR'],
  });
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'post',
    name: 'Post',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: true,
        required: true,
        position: 0,
      },
      { apiId: 'body', name: 'Body', type: 'Text', localized: true, required: false, position: 1 },
      {
        apiId: 'summary',
        name: 'Summary',
        type: 'Text',
        localized: true,
        required: false,
        position: 2,
      },
    ],
  });
}

async function newPost(ctx: AppContext) {
  const { entry } = await createEntry(ctx, scope, {
    contentTypeApiId: 'post',
    fields: {
      title: { 'en-US': 'Hello World' },
      body: { 'en-US': 'A short article about greetings.' },
    },
  });
  return entry.id;
}

describe('translateEntry', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ({ ctx } = setup());
    await seed(ctx);
  });

  it('translates localized text fields into the target locale and applies', async () => {
    const id = await newPost(ctx);
    const ai = new StubAIProvider(() => ({ title: 'Bonjour le monde', body: 'Un court article.' }));
    const result = await translateEntry(ctx, ai, scope, id, { targetLocale: 'fr-FR', apply: true });
    expect(result.translatedFields.sort()).toEqual(['body', 'title']);
    expect(result.applied).toBe(true);
    const { fields } = await getEntry(ctx, scope, id);
    expect(fields.title?.['fr-FR']).toBe('Bonjour le monde');
    expect(fields.title?.['en-US']).toBe('Hello World'); // source untouched
  });

  it('rejects an unknown target locale', async () => {
    const id = await newPost(ctx);
    const ai = new StubAIProvider(() => ({}));
    await expect(translateEntry(ctx, ai, scope, id, { targetLocale: 'de-DE' })).rejects.toThrow(
      ValidationError,
    );
  });
});

describe('summarizeEntry', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ({ ctx } = setup());
    await seed(ctx);
  });

  it('summarizes and can write into a target field', async () => {
    const id = await newPost(ctx);
    const ai = new StubAIProvider(() => ({ summary: 'Greetings article.' }));
    const result = await summarizeEntry(ctx, ai, scope, id, {
      targetField: 'summary',
      apply: true,
    });
    expect(result.summary).toBe('Greetings article.');
    const { fields } = await getEntry(ctx, scope, id);
    expect(fields.summary?.['en-US']).toBe('Greetings article.');
  });

  it('refuses an answer without the shape asked for, never a TypeError', async () => {
    const id = await newPost(ctx);
    for (const answer of [{ summary: 42 }, ['Greetings.'], {}]) {
      await expect(
        summarizeEntry(ctx, new StubAIProvider(() => answer), scope, id),
        JSON.stringify(answer),
      ).rejects.toThrow(ValidationError);
    }
  });
});

describe('autofillField', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ({ ctx } = setup());
    await seed(ctx);
  });

  it('fills a scalar field from the other fields', async () => {
    const id = await newPost(ctx);
    const ai = new StubAIProvider(() => ({ value: 'A friendly greeting post.' }));
    const result = await autofillField(ctx, ai, scope, id, { field: 'summary', apply: true });
    expect(result.value).toBe('A friendly greeting post.');
    const { fields } = await getEntry(ctx, scope, id);
    expect(fields.summary?.['en-US']).toBe('A friendly greeting post.');
  });

  it('rejects an unknown field', async () => {
    const id = await newPost(ctx);
    const ai = new StubAIProvider(() => ({ value: 'x' }));
    await expect(autofillField(ctx, ai, scope, id, { field: 'nope' })).rejects.toThrow();
  });
});

describe('suggestEntryTags', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ({ ctx } = setup());
    await seed(ctx);
  });

  it('matches existing tags and applies to entry metadata', async () => {
    const id = await newPost(ctx);
    const greetings = await createTag(ctx, scope, { name: 'greetings' });
    const ai = new StubAIProvider(() => ({ existingTags: ['greetings'], newTags: ['intro'] }));
    const result = await suggestEntryTags(ctx, ai, scope, id, { apply: true });
    expect(result.tagIds).toEqual([greetings.id]);
    expect(result.newTags).toEqual(['intro']);
    const meta = await getEntryMetadata(ctx, scope, id);
    expect(meta?.tags).toContain(greetings.id);
    expect(meta?.tags).toHaveLength(2); // greetings + created "intro"
  });

  it('picks existing tags with the decision model, asking the generative model nothing', async () => {
    const id = await newPost(ctx);
    const greetings = await createTag(ctx, scope, { name: 'greetings' });
    await createTag(ctx, scope, { name: 'finance' });
    const decisions = new StubDecisionModel((req) => {
      const yes: Record<string, { type: 'noul'; probability: number }> = {};
      for (const [qid, q] of Object.entries(req.questions)) {
        yes[qid] = {
          type: 'noul',
          probability: q.instructions.includes('"greetings"') ? 0.9 : 0.1,
        };
      }
      return yes;
    });
    const ai = new StubAIProvider(() => ({ existingTags: ['finance'], newTags: ['x'] }));
    const result = await suggestEntryTags({ ...ctx, decisions }, ai, scope, id);
    expect(result.tagIds).toEqual([greetings.id]);
    expect(result.newTags).toEqual([]);
    expect(ai.requests).toEqual([]);
  });

  it('asks for new tag names only when no existing tag fits, and keeps that decision', async () => {
    const id = await newPost(ctx);
    await createTag(ctx, scope, { name: 'finance' });
    const decisions = new StubDecisionModel(); // every tag: no
    // The generative model tries to pick an existing tag anyway; only its new names are taken.
    const ai = new StubAIProvider(() => ({ existingTags: ['finance'], newTags: ['intro'] }));
    const result = await suggestEntryTags({ ...ctx, decisions }, ai, scope, id);
    expect(result.tagIds).toEqual([]);
    expect(result.newTags).toEqual(['intro']);
    expect(ai.requests).toHaveLength(1);
  });

  it('suggests nothing from an answer without the shape asked for, never a TypeError', async () => {
    const id = await newPost(ctx);
    await createTag(ctx, scope, { name: 'greetings' });
    for (const answer of [
      { existingTags: 'Sample existingTags', newTags: 'Sample newTags' },
      { existingTags: [{ name: 'greetings' }], newTags: [] },
      'greetings',
    ]) {
      const result = await suggestEntryTags(ctx, new StubAIProvider(() => answer), scope, id, {
        apply: true,
      });
      expect(result, JSON.stringify(answer)).toMatchObject({ tagIds: [], newTags: [] });
    }
    expect((await getEntryMetadata(ctx, scope, id))?.tags ?? []).toEqual([]);
  });

  it('asks about a large vocabulary 64 tags at a time', async () => {
    const id = await newPost(ctx);
    for (let n = 0; n < 70; n++) await createTag(ctx, scope, { name: `tag-${n}` });
    const decisions = new StubDecisionModel();
    await suggestEntryTags({ ...ctx, decisions }, new StubAIProvider(() => ({})), scope, id);
    expect(decisions.requests.map((r) => Object.keys(r.questions).length)).toEqual([64, 6]);
  });

  it('apply merges tags without wiping the entry’s concepts', async () => {
    const id = await newPost(ctx);
    const scheme = await createScheme(ctx, scope, { name: 'topics' });
    const concept = await createConcept(ctx, scope, { schemeId: scheme.id, prefLabel: 'travel' });
    await setEntryMetadata(ctx, scope, id, { tags: [], concepts: [concept.id] });
    const ai = new StubAIProvider(() => ({ existingTags: [], newTags: ['intro'] }));
    await suggestEntryTags(ctx, ai, scope, id, { apply: true });
    const meta = await getEntryMetadata(ctx, scope, id);
    expect(meta?.tags).toHaveLength(1);
    expect(meta?.concepts).toEqual([concept.id]);
  });
});

describe('applyEntryTags', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ({ ctx } = setup());
    await seed(ctx);
  });

  it('persists the reviewed suggestion without a model call', async () => {
    const id = await newPost(ctx);
    const greetings = await createTag(ctx, scope, { name: 'greetings' });
    const result = await applyEntryTags(ctx, scope, id, {
      tagIds: [greetings.id],
      newTags: ['intro'],
    });
    expect(result.createdTags).toHaveLength(1);
    expect(result.createdTags[0]?.name).toBe('intro');
    expect(result.tagIds).toContain(greetings.id);
    const meta = await getEntryMetadata(ctx, scope, id);
    expect(meta?.tags).toHaveLength(2);
  });

  it('reuses an existing tag when a new name matches case-insensitively', async () => {
    const id = await newPost(ctx);
    const greetings = await createTag(ctx, scope, { name: 'Greetings' });
    const result = await applyEntryTags(ctx, scope, id, { newTags: ['greetings'] });
    expect(result.createdTags).toHaveLength(0);
    expect(result.tagIds).toEqual([greetings.id]);
    expect(await listTags(ctx, scope)).toHaveLength(1); // no duplicate created
  });

  it('merges with existing tags and preserves concepts', async () => {
    const id = await newPost(ctx);
    const existing = await createTag(ctx, scope, { name: 'kept' });
    const scheme = await createScheme(ctx, scope, { name: 'topics' });
    const concept = await createConcept(ctx, scope, { schemeId: scheme.id, prefLabel: 'travel' });
    await setEntryMetadata(ctx, scope, id, { tags: [existing.id], concepts: [concept.id] });
    const result = await applyEntryTags(ctx, scope, id, { newTags: ['fresh'] });
    expect(result.tagIds).toContain(existing.id);
    const meta = await getEntryMetadata(ctx, scope, id);
    expect(meta?.tags).toHaveLength(2);
    expect(meta?.concepts).toEqual([concept.id]); // apply must not wipe concepts
  });

  it('rejects an unknown tag id before creating any new tags', async () => {
    const id = await newPost(ctx);
    await expect(
      applyEntryTags(ctx, scope, id, { tagIds: ['nope'], newTags: ['fresh'] }),
    ).rejects.toThrow();
    const meta = await getEntryMetadata(ctx, scope, id);
    expect(meta?.tags ?? []).toHaveLength(0);
    expect(await listTags(ctx, scope)).toHaveLength(0); // no orphaned vocabulary
  });

  it('rejects an unknown entry without creating tags', async () => {
    await expect(applyEntryTags(ctx, scope, 'missing', { newTags: ['x'] })).rejects.toThrow();
    expect(await listTags(ctx, scope)).toHaveLength(0);
  });
});
