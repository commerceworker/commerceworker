import { ValidationError } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  getPublishedEntry,
  getReverseReferences,
  listPublishedEntries,
  publishEntry,
  SYSTEM_CALLER,
  unpublishEntry,
  updateEntry,
} from '../src/index';

const scope = { spaceId: 'blog', environmentId: 'main' };

function makeContext() {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  return { ctx, store };
}

async function seedModel(ctx: AppContext) {
  await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'author',
    name: 'Author',
    displayField: 'name',
    fields: [
      {
        apiId: 'name',
        name: 'Name',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
    ],
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
        localized: false,
        required: true,
        position: 0,
      },
      {
        apiId: 'author',
        name: 'Author',
        type: 'Link',
        localized: false,
        required: false,
        position: 1,
        linkType: 'Entry',
      },
    ],
  });
}

describe('P3: references + link resolution', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ({ ctx } = makeContext());
  });

  it('materializes edges on publish and resolves them with ?include', async () => {
    await seedModel(ctx);
    const author = await createEntry(ctx, scope, {
      contentTypeApiId: 'author',
      fields: { name: { 'en-US': 'Ada' } },
    });
    await publishEntry(ctx, scope, author.entry.id);

    const post = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: {
        title: { 'en-US': 'Hello' },
        author: { 'en-US': { id: author.entry.id, linkType: 'Entry' } },
      },
    });
    await publishEntry(ctx, scope, post.entry.id);

    // Without include: the link is a stub.
    const flat = await getPublishedEntry(ctx, scope, post.entry.id, { locale: 'en-US' });
    expect(flat.fields.author).toEqual({ id: author.entry.id, linkType: 'Entry' });

    // With include=1: the author entry is embedded.
    const resolved = await getPublishedEntry(ctx, scope, post.entry.id, {
      locale: 'en-US',
      include: 1,
    });
    const embedded = resolved.fields.author as { id: string; fields: Record<string, unknown> };
    expect(embedded.id).toBe(author.entry.id);
    expect(embedded.fields.name).toBe('Ada');

    // Reverse lookup: the post links to the author.
    const reverse = await getReverseReferences(ctx, scope, author.entry.id);
    expect(reverse).toHaveLength(1);
    expect(reverse[0]?.fromEntryId).toBe(post.entry.id);
  });

  it('refuses to publish an entry that links to a nonexistent entry', async () => {
    await seedModel(ctx);
    const post = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: {
        title: { 'en-US': 'Orphan' },
        author: { 'en-US': { id: 'does-not-exist', linkType: 'Entry' } },
      },
    });
    await expect(publishEntry(ctx, scope, post.entry.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it('embeds a two-level link chain at include=2 and stubs beyond the depth', async () => {
    await seedModel(ctx);
    // bio <- author <- post: three levels, resolved to depth 2.
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'bio',
      name: 'Bio',
      displayField: 'text',
      fields: [
        {
          apiId: 'text',
          name: 'Text',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
      ],
    });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'author2',
      name: 'Author2',
      displayField: 'name',
      fields: [
        {
          apiId: 'name',
          name: 'Name',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
        {
          apiId: 'bio',
          name: 'Bio',
          type: 'Link',
          localized: false,
          required: false,
          position: 1,
          linkType: 'Entry',
        },
      ],
    });
    const bio = await createEntry(ctx, scope, {
      contentTypeApiId: 'bio',
      fields: { text: { 'en-US': 'Wrote things' } },
    });
    await publishEntry(ctx, scope, bio.entry.id);
    const author = await createEntry(ctx, scope, {
      contentTypeApiId: 'author2',
      fields: {
        name: { 'en-US': 'Ada' },
        bio: { 'en-US': { id: bio.entry.id, linkType: 'Entry' } },
      },
    });
    await publishEntry(ctx, scope, author.entry.id);
    const post = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: {
        title: { 'en-US': 'Chain' },
        author: { 'en-US': { id: author.entry.id, linkType: 'Entry' } },
      },
    });
    await publishEntry(ctx, scope, post.entry.id);

    const two = await getPublishedEntry(ctx, scope, post.entry.id, { locale: 'en-US', include: 2 });
    const embeddedAuthor = two.fields.author as { fields: Record<string, unknown> };
    const embeddedBio = embeddedAuthor.fields.bio as {
      id: string;
      fields?: Record<string, unknown>;
    };
    expect(embeddedBio.fields?.text).toBe('Wrote things'); // level 2 embedded

    const one = await getPublishedEntry(ctx, scope, post.entry.id, { locale: 'en-US', include: 1 });
    const shallowAuthor = one.fields.author as { fields: Record<string, unknown> };
    // Beyond the depth budget the link stays an unresolved stub.
    expect(shallowAuthor.fields.bio).toEqual({ id: bio.entry.id, linkType: 'Entry' });
  });

  it('stubs a revisited link in a reference cycle instead of recursing', async () => {
    await seedModel(ctx);
    // Mutual links: a -> b -> a. Both exist as drafts before publish, so
    // referential integrity permits the cycle.
    const a = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'A' } },
    });
    const b = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: {
        title: { 'en-US': 'B' },
        author: { 'en-US': { id: a.entry.id, linkType: 'Entry' } },
      },
    });
    await updateEntry(ctx, scope, a.entry.id, {
      title: { 'en-US': 'A' },
      author: { 'en-US': { id: b.entry.id, linkType: 'Entry' } },
    });
    await publishEntry(ctx, scope, a.entry.id);
    await publishEntry(ctx, scope, b.entry.id);

    const resolved = await getPublishedEntry(ctx, scope, a.entry.id, {
      locale: 'en-US',
      include: 3,
    });
    const embeddedB = resolved.fields.author as { id: string; fields: Record<string, unknown> };
    expect(embeddedB.id).toBe(b.entry.id);
    // The cycle back to `a` terminates as a stub, not infinite recursion.
    expect(embeddedB.fields.author).toEqual({ id: a.entry.id, linkType: 'Entry' });
  });

  it('leaves a stub for a link whose target was unpublished after publish', async () => {
    await seedModel(ctx);
    const author = await createEntry(ctx, scope, {
      contentTypeApiId: 'author',
      fields: { name: { 'en-US': 'Ada' } },
    });
    await publishEntry(ctx, scope, author.entry.id);
    const post = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: {
        title: { 'en-US': 'Dangling' },
        author: { 'en-US': { id: author.entry.id, linkType: 'Entry' } },
      },
    });
    await publishEntry(ctx, scope, post.entry.id);
    await unpublishEntry(ctx, scope, author.entry.id);

    const resolved = await getPublishedEntry(ctx, scope, post.entry.id, {
      locale: 'en-US',
      include: 1,
    });
    // getPublishedMany misses the unpublished target — the stub survives.
    expect(resolved.fields.author).toEqual({ id: author.entry.id, linkType: 'Entry' });
  });

  it('resolves links inside array fields', async () => {
    await seedModel(ctx);
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'collection',
      name: 'Collection',
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
          apiId: 'posts',
          name: 'Posts',
          type: 'Array',
          localized: false,
          required: false,
          position: 1,
          items: { type: 'Link', linkType: 'Entry' },
        },
      ],
    });
    const p1 = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'One' } },
    });
    const p2 = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Two' } },
    });
    await publishEntry(ctx, scope, p1.entry.id);
    await publishEntry(ctx, scope, p2.entry.id);
    const coll = await createEntry(ctx, scope, {
      contentTypeApiId: 'collection',
      fields: {
        title: { 'en-US': 'Both' },
        posts: {
          'en-US': [
            { id: p1.entry.id, linkType: 'Entry' },
            { id: p2.entry.id, linkType: 'Entry' },
          ],
        },
      },
    });
    await publishEntry(ctx, scope, coll.entry.id);

    const resolved = await getPublishedEntry(ctx, scope, coll.entry.id, {
      locale: 'en-US',
      include: 1,
    });
    const posts = resolved.fields.posts as { id: string; fields: Record<string, unknown> }[];
    expect(posts.map((p) => p.fields.title)).toEqual(['One', 'Two']);
  });

  it('listPublishedEntries embeds links across all rows with one shared prefetch', async () => {
    await seedModel(ctx);
    const author = await createEntry(ctx, scope, {
      contentTypeApiId: 'author',
      fields: { name: { 'en-US': 'Shared' } },
    });
    await publishEntry(ctx, scope, author.entry.id);
    for (const title of ['P1', 'P2']) {
      const post = await createEntry(ctx, scope, {
        contentTypeApiId: 'post',
        fields: {
          title: { 'en-US': title },
          author: { 'en-US': { id: author.entry.id, linkType: 'Entry' } },
        },
      });
      await publishEntry(ctx, scope, post.entry.id);
    }

    const rows = await listPublishedEntries(
      ctx,
      scope,
      { contentTypeApiId: 'post' },
      { locale: 'en-US', include: 1 },
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const embedded = row.fields.author as { fields: Record<string, unknown> };
      expect(embedded.fields.name).toBe('Shared');
    }
  });

  it('clears edges on unpublish', async () => {
    await seedModel(ctx);
    const author = await createEntry(ctx, scope, {
      contentTypeApiId: 'author',
      fields: { name: { 'en-US': 'Ada' } },
    });
    await publishEntry(ctx, scope, author.entry.id);
    const post = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: {
        title: { 'en-US': 'Hi' },
        author: { 'en-US': { id: author.entry.id, linkType: 'Entry' } },
      },
    });
    await publishEntry(ctx, scope, post.entry.id);
    expect(await getReverseReferences(ctx, scope, author.entry.id)).toHaveLength(1);

    await unpublishEntry(ctx, scope, post.entry.id);
    expect(await getReverseReferences(ctx, scope, author.entry.id)).toHaveLength(0);
  });
});
