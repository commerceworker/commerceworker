import {
  AssetRightsError,
  type DomainEvent,
  type Principal,
  rightsExpireSoon,
  ValidationError,
  validateAssetRights,
} from '@commerceworker/domain';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryAssetGate,
  InMemoryContentStore,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createAsset,
  createEnvironment,
  createSpace,
  deleteEnvironment,
  dispatchEvent,
  expireAsset,
  getAsset,
  publishAsset,
  runDueAssetExpiries,
  setAssetRights,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };
const HOUR = 3_600_000;

function setup() {
  const store = new InMemoryContentStore();
  const blob = new FakeBlobStore();
  const gate = new InMemoryAssetGate();
  const clock = new FixedClock();
  const ctx: AppContext = { store, clock, ids: new SequenceIdGenerator('a') };
  let dispatched = 0;
  const drain = async () => {
    const events = store.allEvents();
    for (const e of events.slice(dispatched)) {
      await dispatchEvent(
        ctx,
        { sender: new RecordingWebhookSender(), blob, assetGate: gate },
        e as DomainEvent,
      );
    }
    dispatched = events.length;
  };
  const events = () => store.allEvents() as DomainEvent[];
  return { ctx, store, blob, gate, clock, drain, events };
}

type Harness = ReturnType<typeof setup>;

async function upload(h: Harness, s = scope) {
  return (await createAsset(h.ctx, h.blob, s, { fileName: 'hero.png', contentType: 'image/png' }))
    .asset;
}

const at = (h: Harness, ms: number) => new Date(h.clock.now().getTime() + ms).toISOString();

describe('validating rights', () => {
  it('trims text, normalizes dates to UTC and drops what is empty', () => {
    expect(
      validateAssetRights({
        license: '  CC BY 4.0 ',
        credit: '',
        expiresAt: '2026-03-01T12:00:00+02:00',
      }),
    ).toEqual({ license: 'CC BY 4.0', expiresAt: '2026-03-01T10:00:00.000Z' });
    expect(validateAssetRights({ credit: '  ' })).toBeUndefined();
  });

  it('refuses a date without a zone, a non-date, long text and an expiry before the embargo', () => {
    const issues = (rights: object) => {
      try {
        validateAssetRights(rights);
        return [];
      } catch (err) {
        return (err as ValidationError).issues.map((i) => i.field);
      }
    };
    expect(issues({ expiresAt: '2026-03-01' })).toEqual(['rights.expiresAt']);
    expect(issues({ embargoUntil: 'tomorrow' })).toEqual(['rights.embargoUntil']);
    expect(issues({ license: 'x'.repeat(501) })).toEqual(['rights.license']);
    expect(
      issues({ embargoUntil: '2026-03-02T00:00:00Z', expiresAt: '2026-03-01T00:00:00Z' }),
    ).toEqual(['rights.expiresAt']);
  });

  it('says when rights expire soon', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(rightsExpireSoon({ expiresAt: '2026-01-03T00:00:00Z' }, now, 7 * 24 * HOUR)).toBe(true);
    expect(rightsExpireSoon({ expiresAt: '2026-02-01T00:00:00Z' }, now, 7 * 24 * HOUR)).toBe(false);
    expect(rightsExpireSoon({ expiresAt: '2025-12-01T00:00:00Z' }, now, 7 * 24 * HOUR)).toBe(false);
    expect(rightsExpireSoon(undefined, now, HOUR)).toBe(false);
  });
});

describe('asset rights', () => {
  let h: Harness;

  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('sets rights on a draft without touching Delivery, and clears them', async () => {
    const asset = await upload(h);
    const updated = await setAssetRights(h.ctx, scope, asset.id, {
      license: 'CC BY',
      credit: 'Ana',
    });
    expect(updated.rights).toEqual({ license: 'CC BY', credit: 'Ana' });
    expect(h.events().filter((e) => e.type === 'asset.rights_changed')).toEqual([]);
    const cleared = await setAssetRights(h.ctx, scope, asset.id, null);
    expect(cleared.rights).toBeUndefined();
    expect((await getAsset(h.ctx, scope, asset.id)).rights).toBeUndefined();
  });

  it('applies to a published asset at once: the snapshot, the gate and an event', async () => {
    const asset = await upload(h);
    await publishAsset(h.ctx, scope, asset.id);
    await h.drain();
    const expiresAt = at(h, 2 * HOUR);
    await setAssetRights(h.ctx, scope, asset.id, { credit: 'Ana', expiresAt });
    expect((await h.store.assets.getPublished(scope, asset.id))?.rights).toEqual({
      credit: 'Ana',
      expiresAt,
    });
    expect(h.events().at(-1)).toMatchObject({ type: 'asset.rights_changed', assetId: asset.id });
    await h.drain();
    expect(await h.gate.get(scope, asset.id)).toMatchObject({ expiresAt });
  });

  it('refuses an embargo on an asset that is already delivered', async () => {
    const asset = await upload(h);
    await publishAsset(h.ctx, scope, asset.id);
    await expect(
      setAssetRights(h.ctx, scope, asset.id, { embargoUntil: at(h, HOUR) }),
    ).rejects.toThrow(ValidationError);
    // A lifted one is no embargo.
    await setAssetRights(h.ctx, scope, asset.id, { embargoUntil: at(h, -HOUR) });
  });

  it('refuses to publish under embargo, then publishes once it lifts', async () => {
    const asset = await upload(h);
    const until = at(h, HOUR);
    await setAssetRights(h.ctx, scope, asset.id, { embargoUntil: until });
    const refused = await publishAsset(h.ctx, scope, asset.id).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AssetRightsError);
    expect(refused).toMatchObject({ code: 'asset_embargoed', details: { embargoUntil: until } });
    expect((refused as Error).message).toContain(until);
    expect(await h.store.assets.getPublished(scope, asset.id)).toBeNull();
    h.clock.advance(HOUR);
    await publishAsset(h.ctx, scope, asset.id);
    expect(await h.store.assets.getPublished(scope, asset.id)).not.toBeNull();
  });

  it('refuses to publish once the rights have expired', async () => {
    const asset = await upload(h);
    await setAssetRights(h.ctx, scope, asset.id, { expiresAt: at(h, HOUR) });
    h.clock.advance(HOUR);
    await expect(publishAsset(h.ctx, scope, asset.id)).rejects.toMatchObject({
      code: 'asset_expired',
    });
  });
});

describe('the asset expiry sweep', () => {
  let h: Harness;

  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('unpublishes what has expired, emits asset.expired, and removes the gate', async () => {
    const due = await upload(h);
    const later = await upload(h);
    await setAssetRights(h.ctx, scope, due.id, { expiresAt: at(h, HOUR) });
    await setAssetRights(h.ctx, scope, later.id, { expiresAt: at(h, 3 * HOUR) });
    await publishAsset(h.ctx, scope, due.id);
    await publishAsset(h.ctx, scope, later.id);
    await h.drain();
    expect(await runDueAssetExpiries(h.ctx)).toMatchObject({ expired: 0, failed: 0 });

    h.clock.advance(HOUR);
    expect(await runDueAssetExpiries(h.ctx)).toEqual({ expired: 1, failed: 0, errors: [] });
    expect((await getAsset(h.ctx, scope, due.id)).status).toBe('draft');
    expect(await h.store.assets.getPublished(scope, due.id)).toBeNull();
    expect(await h.store.assets.getPublished(scope, later.id)).not.toBeNull();
    const tail = h.events().slice(-2);
    expect(tail.map((e) => e.type)).toEqual(['asset.unpublished', 'asset.expired']);
    expect(tail[1]).toMatchObject({ assetId: due.id, expiresAt: at(h, 0) });
    await h.drain();
    expect(await h.gate.get(scope, due.id)).toBeNull();
    expect(await h.gate.get(scope, later.id)).not.toBeNull();

    // A second run finds nothing more to do.
    expect(await runDueAssetExpiries(h.ctx)).toMatchObject({ expired: 0 });
  });

  it('leaves an asset whose expiry moved later after the sweep read it', async () => {
    const asset = await upload(h);
    await setAssetRights(h.ctx, scope, asset.id, { expiresAt: at(h, HOUR) });
    await publishAsset(h.ctx, scope, asset.id);
    h.clock.advance(HOUR);
    // The rights change commits between the sweep's read and its write.
    const withTransaction = h.store.withTransaction.bind(h.store);
    h.store.withTransaction = (async (fn) => {
      h.store.withTransaction = withTransaction;
      await setAssetRights(h.ctx, scope, asset.id, { expiresAt: at(h, HOUR) });
      return withTransaction(fn);
    }) as typeof h.store.withTransaction;
    expect(await expireAsset(h.ctx, scope, asset.id, h.clock.now())).toBe(false);
    expect((await getAsset(h.ctx, scope, asset.id)).status).toBe('published');
    expect(h.events().some((e) => e.type === 'asset.expired')).toBe(false);
  });

  it('skips a deleted environment, whose rows linger until purged', async () => {
    await createEnvironment(h.ctx, 'shop', 'staging');
    const staging = { spaceId: 'shop', environmentId: 'staging' };
    const asset = await upload(h, staging);
    await setAssetRights(h.ctx, staging, asset.id, { expiresAt: at(h, HOUR) });
    await publishAsset(h.ctx, staging, asset.id);
    await deleteEnvironment(h.ctx, 'shop', 'staging', {
      confirm: 'staging',
      principal: { spaceId: '*', kind: 'admin', scopes: [] } as unknown as Principal,
    });
    h.clock.advance(HOUR);
    expect(await runDueAssetExpiries(h.ctx)).toMatchObject({ expired: 0 });
  });
});
