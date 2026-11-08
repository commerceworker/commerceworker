import { ConflictError, NotFoundError, ValidationError } from '@commerceworker/domain';
import {
  FakeBlobStore,
  FakeMediaPathSigner,
  FakePasswordHasher,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  addToAssetCollection,
  createAsset,
  createAssetCollection,
  createAssetShareLink,
  createEnvironment,
  createSpace,
  listAssetShareLinks,
  openShareLink,
  publishAsset,
  revokeAssetShareLink,
  sharedAssetFile,
  sharedAssets,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };
const DAY = 24 * 60 * 60 * 1000;

describe('share links', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;
  let blob: FakeBlobStore;
  let clock: FixedClock;
  const inDays = (n: number) => new Date(clock.now().getTime() + n * DAY).toISOString();
  const upload = async (fileName: string, s = scope) =>
    (await createAsset(ctx, blob, s, { fileName, contentType: 'image/png' })).asset;

  beforeEach(async () => {
    store = new InMemoryContentStore();
    blob = new FakeBlobStore();
    clock = new FixedClock();
    ctx = {
      store,
      clock,
      ids: new SequenceIdGenerator('s'),
      mediaPublicUrl: 'https://media.test',
      mediaPaths: new FakeMediaPathSigner(),
      passwords: new FakePasswordHasher(),
    };
    await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('links a published asset, with a URL on the media origin whose token verifies', async () => {
    const asset = await upload('a.png');
    await publishAsset(ctx, scope, asset.id);
    const link = await createAssetShareLink(
      ctx,
      scope,
      { targetType: 'asset', targetId: asset.id, expiresAt: inDays(7), allowDownload: true },
      { createdBy: 'ann' },
    );
    expect(link).toMatchObject({ allowDownload: true, hasPassword: false, createdBy: 'ann' });
    const token = link.url?.split('/').at(-1) ?? '';
    expect(link.url).toBe(`https://media.test/s/shop/main/${link.id}/${token}`);
    expect(ctx.mediaPaths?.verifyLink(scope, link.id, token)).toBe(true);
    // Another environment's link of the same id never shares the token.
    expect(ctx.mediaPaths?.verifyLink({ ...scope, environmentId: 'x' }, link.id, token)).toBe(
      false,
    );
    expect(store.allEvents().at(-1)).toMatchObject({
      type: 'asset_share.created',
      linkId: link.id,
    });
  });

  it('refuses a draft asset (links serve published files only) and a bad expiry', async () => {
    const draft = await upload('d.png');
    await expect(
      createAssetShareLink(ctx, scope, {
        targetType: 'asset',
        targetId: draft.id,
        expiresAt: inDays(1),
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await publishAsset(ctx, scope, draft.id);
    for (const expiresAt of [inDays(-1), inDays(91), 'soon']) {
      await expect(
        createAssetShareLink(ctx, scope, { targetType: 'asset', targetId: draft.id, expiresAt }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(
      createAssetShareLink(ctx, scope, {
        targetType: 'collection',
        targetId: 'ghost',
        expiresAt: inDays(1),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('hashes a password and never shows or stores it', async () => {
    const c = await createAssetCollection(ctx, scope, { name: 'Press' });
    const link = await createAssetShareLink(ctx, scope, {
      targetType: 'collection',
      targetId: c.id,
      expiresAt: inDays(1),
      password: 'correct horse',
    });
    expect(link.hasPassword).toBe(true);
    expect(JSON.stringify(link)).not.toContain('correct horse');
    const stored = await store.assetShareLinks.get(scope, link.id);
    expect(stored?.passwordHash).toBeDefined();
    expect(stored?.passwordHash).not.toContain('correct horse');
    expect(await ctx.passwords?.verify('correct horse', stored?.passwordHash ?? '')).toBe(true);
    await expect(
      createAssetShareLink(ctx, scope, {
        targetType: 'collection',
        targetId: c.id,
        expiresAt: inDays(1),
        password: 'short',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const without = { ...ctx, passwords: undefined };
    await expect(
      createAssetShareLink(without, scope, {
        targetType: 'collection',
        targetId: c.id,
        expiresAt: inDays(1),
        password: 'long enough',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('revokes once: a second revoke sends nothing; listing hides inactive links unless asked', async () => {
    const c = await createAssetCollection(ctx, scope, { name: 'C' });
    const live = await createAssetShareLink(ctx, scope, {
      targetType: 'collection',
      targetId: c.id,
      expiresAt: inDays(30),
    });
    clock.advance(1000);
    const short = await createAssetShareLink(ctx, scope, {
      targetType: 'collection',
      targetId: c.id,
      expiresAt: inDays(2),
    });
    const revoked = await revokeAssetShareLink(ctx, scope, live.id);
    expect(revoked.revokedAt).toBe(clock.now().toISOString());
    const events = store.allEvents().length;
    expect((await revokeAssetShareLink(ctx, scope, live.id)).revokedAt).toBe(revoked.revokedAt);
    expect(store.allEvents()).toHaveLength(events);
    clock.advance(3 * DAY);
    expect(await listAssetShareLinks(ctx, scope)).toEqual([]);
    expect(
      (await listAssetShareLinks(ctx, scope, { includeInactive: true })).map((l) => l.id),
    ).toEqual([short.id, live.id]);
  });

  it('opens a link from its row: active, then gone once revoked or expired', async () => {
    const c = await createAssetCollection(ctx, scope, { name: 'C' });
    const link = await createAssetShareLink(ctx, scope, {
      targetType: 'collection',
      targetId: c.id,
      expiresAt: inDays(1),
      password: 'long enough',
    });
    const now = () => clock.now().getTime();
    expect(await openShareLink(store, scope, link.id, now())).toMatchObject({
      targetType: 'collection',
      targetId: c.id,
      passwordHash: expect.stringMatching(/^fake:/),
    });
    expect(await openShareLink(store, scope, link.id, now() + 2 * DAY)).toBe('gone');
    await revokeAssetShareLink(ctx, scope, link.id);
    expect(await openShareLink(store, scope, link.id, now())).toBe('gone');
    expect(await openShareLink(store, scope, 'ghost', now())).toBeNull();
    // Another environment never opens it.
    expect(await openShareLink(store, { ...scope, environmentId: 'x' }, link.id, now())).toBeNull();
  });

  it('shows published members only, in order, and serves a file only of its target', async () => {
    const [draft, one, two, stranger] = [
      await upload('draft.png'),
      await upload('one.png'),
      await upload('two.png'),
      await upload('stranger.png'),
    ];
    for (const a of [one, two, stranger]) await publishAsset(ctx, scope, a.id);
    const c = await createAssetCollection(ctx, scope, { name: 'Kit', description: 'Logos' });
    await addToAssetCollection(ctx, scope, c.id, [two.id, draft.id, one.id]);
    const entry = { targetType: 'collection' as const, targetId: c.id };
    const shared = await sharedAssets(store, scope, entry);
    expect(shared).toMatchObject({ title: 'Kit', description: 'Logos' });
    expect(shared?.items.map((s) => s.assetId)).toEqual([two.id, one.id]);
    expect(await sharedAssetFile(store, scope, entry, one.id)).toMatchObject({ assetId: one.id });
    // Published, but not in the collection; in it, but a draft.
    expect(await sharedAssetFile(store, scope, entry, stranger.id)).toBeNull();
    expect(await sharedAssetFile(store, scope, entry, draft.id)).toBeNull();
    // An asset link serves that asset only.
    const single = { targetType: 'asset' as const, targetId: one.id };
    expect(await sharedAssetFile(store, scope, single, two.id)).toBeNull();
    expect((await sharedAssets(store, scope, single))?.items).toHaveLength(1);
  });

  it('never reaches another environment’s collection or asset', async () => {
    await createEnvironment(ctx, 'shop', 'staging');
    const staging = { spaceId: 'shop', environmentId: 'staging' };
    const theirs = await upload('theirs.png', staging);
    await publishAsset(ctx, staging, theirs.id);
    const c = await createAssetCollection(ctx, staging, { name: 'Theirs' });
    await addToAssetCollection(ctx, staging, c.id, [theirs.id]);
    // Same ids, read in this environment: nothing.
    expect(
      await sharedAssets(store, scope, { targetType: 'collection', targetId: c.id }),
    ).toBeNull();
    expect(
      await sharedAssetFile(store, scope, { targetType: 'collection', targetId: c.id }, theirs.id),
    ).toBeNull();
    await expect(
      createAssetShareLink(ctx, scope, {
        targetType: 'asset',
        targetId: theirs.id,
        expiresAt: inDays(1),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
