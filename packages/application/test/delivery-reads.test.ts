import { type Principal, SCOPES } from '@commerceworker/domain';
import type { DeliveryReadRequest } from '@commerceworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  deliveryGraphResolvers,
  deliveryReads,
  getPublishedEntry,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
} from '../src';

const blog = { spaceId: 'blog', environmentId: 'main' };
const shop = { spaceId: 'shop', environmentId: 'main' };
const blogStaging = { spaceId: 'blog', environmentId: 'staging' };
const reader: Principal = { spaceId: 'blog', kind: 'cda', scopes: [SCOPES.deliveryRead] };

let store: InMemoryContentStore;
let ctx: AppContext;
/** Every request the store's batched read received, in order. */
let sent: DeliveryReadRequest[];
/** Fails the next store read when set. */
let failNext = false;

beforeEach(async () => {
  store = new InMemoryContentStore();
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('r') };
  await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
  await createSpace(ctx, {
    spaceId: 'shop',
    name: 'Shop',
    defaultLocale: 'de',
    locales: ['de', 'en-US'],
  });
  sent = [];
  failNext = false;
  const inner = store.delivery.read;
  (store as { delivery: typeof store.delivery }).delivery = {
    read: async (scope, request) => {
      sent.push(request);
      if (failNext) {
        failNext = false;
        throw new Error('D1 unavailable');
      }
      return inner(scope, request);
    },
  };
});

describe('deliveryReads (one request’s reads)', () => {
  it('reads the config, content types and renditions once per request', async () => {
    const reads = deliveryReads(ctx);
    await reads.read(blog, { config: true, contentTypes: true });
    const again = await reads.read(blog, { config: true, contentTypes: true, renditions: true });
    expect(again.config?.defaultLocale).toBe('en-US');
    expect(again.contentTypes).toEqual([]);
    // Only the part not read yet goes to the store.
    expect(sent).toEqual([{ config: true, contentTypes: true }, { renditions: true }]);
  });

  it('shares one read between steps asking at the same time', async () => {
    const reads = deliveryReads(ctx);
    const [a, b] = await Promise.all([
      reads.read(blog, { config: true }),
      reads.read(blog, { config: true }),
    ]);
    expect(a.config).toEqual(b.config);
    expect(sent).toHaveLength(1);
  });

  it('never answers one scope with another’s', async () => {
    const reads = deliveryReads(ctx);
    expect((await reads.read(blog, { config: true })).config?.defaultLocale).toBe('en-US');
    expect((await reads.read(shop, { config: true })).config?.defaultLocale).toBe('de');
    // Same space, another environment: its own content types, its own read.
    await reads.read(blog, { contentTypes: true });
    await reads.read(blogStaging, { contentTypes: true });
    expect(sent).toHaveLength(4);
  });

  it('never remembers entries or assets', async () => {
    const reads = deliveryReads(ctx);
    await reads.read(blog, { entryId: 'e1', assetIds: ['a1'] });
    await reads.read(blog, { entryId: 'e1', assetIds: ['a1'] });
    expect(sent).toHaveLength(2);
  });

  it('lives only as long as its request: the next one reads the config afresh', async () => {
    const first = deliveryReads(ctx);
    await first.read(blog, { config: true });
    await store.spaces.create({
      spaceId: 'blog',
      name: 'Blog',
      defaultLocale: 'fr',
      locales: ['fr', 'en-US'],
    });
    const next = deliveryReads(ctx);
    expect((await next.read(blog, { config: true })).config?.defaultLocale).toBe('fr');
  });

  it('asks again after a failed read', async () => {
    const reads = deliveryReads(ctx);
    failNext = true;
    await expect(reads.read(blog, { config: true })).rejects.toThrow('D1 unavailable');
    expect((await reads.read(blog, { config: true })).config?.defaultLocale).toBe('en-US');
    expect(sent).toHaveLength(2);
  });

  it('sends nothing when everything asked for is already read', async () => {
    const reads = deliveryReads(ctx);
    await reads.read(blog, { config: true });
    await reads.read(blog, { config: true, entryIds: undefined });
    expect(sent).toHaveLength(1);
  });
});

describe('Delivery reads through one request', () => {
  beforeEach(async () => {
    await createContentType(ctx, SYSTEM_CALLER, blog, {
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
          apiId: 'related',
          name: 'Related',
          type: 'Link',
          linkType: 'Entry',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    });
    await publishContentType(ctx, blog, 'post');
  });

  async function post(title: string, related?: string): Promise<string> {
    const { entry } = await createEntry(ctx, blog, {
      contentTypeApiId: 'post',
      fields: {
        title: { 'en-US': title },
        ...(related ? { related: { 'en-US': { id: related, linkType: 'Entry' } } } : {}),
      },
    });
    await publishEntry(ctx, blog, entry.id);
    return entry.id;
  }

  it('reads an entry with its config together, then each include level in one read', async () => {
    const leaf = await post('Leaf');
    const root = await post('Root', leaf);
    sent = [];
    const e = await getPublishedEntry(ctx, blog, root, { include: 1, locale: 'en-US' });
    expect((e.fields.related as { fields: { title: string } }).fields.title).toBe('Leaf');
    expect(sent).toEqual([{ entryId: root, config: true }, { entryIds: [leaf] }]);
  });

  it('a GraphQL request reads the config its schema loaded only once', async () => {
    const leaf = await post('Leaf');
    const root = await post('Root', leaf);
    sent = [];
    const reads = deliveryReads(ctx);
    await reads.read(blog, { contentTypes: true, config: true });
    const resolvers = deliveryGraphResolvers(ctx, blog, reader, { rag: undefined, reads });
    const [a, b] = await Promise.all([
      resolvers.entry('post', root),
      resolvers.entry('post', leaf),
    ]);
    expect(a?.fields.title).toBe('Root');
    expect(b?.fields.title).toBe('Leaf');
    expect(await resolvers.localize({ 'en-US': 'Hi' })).toBe('Hi');
    expect(sent.filter((r) => r.config)).toHaveLength(1);
    expect(sent.filter((r) => r.contentTypes)).toHaveLength(1);
  });
});
