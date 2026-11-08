import { type DomainEvent, SecretUnreadableError, type Webhook } from '@commerceworker/domain';
import type { WebhookSender } from '@commerceworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import {
  type AppContext,
  createSecretSealer,
  createWebhook,
  dispatchEvent,
  isSealedSecret,
  listWebhooks,
  resealSecrets,
  secretContext,
  updateWebhook,
  withSealedSecrets,
} from '../src/index';

const KEY = 'current-data-key-0123456789abcdef0123456789';
const OLD = 'previous-data-key-0123456789abcdef012345678';
const scope = { spaceId: 'shop', environmentId: 'main' };

describe('SecretSealer (AES-256-GCM, e1.<kid>.<iv>.<ct>)', () => {
  const sealer = createSecretSealer({ current: KEY });

  it('round-trips a value and uses the documented format', async () => {
    const sealed = await sealer.seal('whsec_abc', 'webhooks.secret:w1');
    expect(sealed).toMatch(/^e1\.[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed.startsWith(await sealer.currentPrefix())).toBe(true);
    expect(sealed).not.toContain('whsec_abc');
    expect(await sealer.open(sealed, 'webhooks.secret:w1')).toBe('whsec_abc');
  });

  it('uses a fresh IV per seal', async () => {
    const a = await sealer.seal('same', 'ctx');
    const b = await sealer.seal('same', 'ctx');
    expect(a).not.toBe(b);
  });

  it('refuses a ciphertext moved to another row (wrong AAD)', async () => {
    const sealed = await sealer.seal('whsec_abc', 'webhooks.secret:w1');
    await expect(sealer.open(sealed, 'webhooks.secret:w2')).rejects.toBeInstanceOf(
      SecretUnreadableError,
    );
  });

  it('refuses a tampered ciphertext', async () => {
    const sealed = await sealer.seal('whsec_abc', 'ctx');
    const parts = sealed.split('.');
    const ct = parts[3] ?? '';
    // Flip one base64url character of the ciphertext.
    parts[3] = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    await expect(sealer.open(parts.join('.'), 'ctx')).rejects.toBeInstanceOf(SecretUnreadableError);
    await expect(sealer.open('e1.only-two', 'ctx')).rejects.toBeInstanceOf(SecretUnreadableError);
  });

  it('refuses a value sealed under a key it does not hold', async () => {
    const other = createSecretSealer({ current: OLD });
    const sealed = await other.seal('x', 'ctx');
    await expect(sealer.open(sealed, 'ctx')).rejects.toBeInstanceOf(SecretUnreadableError);
  });

  it('opens values under DATA_KEY_PREVIOUS during a rotation, sealing only under DATA_KEY', async () => {
    const before = createSecretSealer({ current: OLD });
    const rotated = createSecretSealer({ current: KEY, previous: OLD });
    const old = await before.seal('whsec_abc', 'ctx');
    expect(await rotated.open(old, 'ctx')).toBe('whsec_abc');
    const fresh = await rotated.seal('whsec_abc', 'ctx');
    expect(fresh.startsWith(await sealer.currentPrefix())).toBe(true);
    expect(old.startsWith(await sealer.currentPrefix())).toBe(false);
  });

  it('refuses a value not in the sealed format', async () => {
    expect(isSealedSecret('whsec_plain')).toBe(false);
    await expect(sealer.open('whsec_plain', 'ctx')).rejects.toBeInstanceOf(SecretUnreadableError);
  });

  it('refuses to build without a current key', () => {
    expect(() => createSecretSealer({ current: '' })).toThrow(/DATA_KEY/);
  });
});

function sealedCtx(keys: { current: string; previous?: string } = { current: KEY }) {
  const raw = new InMemoryContentStore();
  const sealer = createSecretSealer(keys);
  const ctx: AppContext = {
    store: withSealedSecrets(raw, sealer),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('w'),
  };
  return { raw, sealer, ctx };
}

describe('webhook secrets sealed at rest (store decorator)', () => {
  it('stores the signing secret and header values sealed; use-cases see plaintext', async () => {
    const { raw, ctx } = sealedCtx();
    const created = await createWebhook(ctx, scope, {
      url: 'https://hook.example/cw',
      topics: ['*'],
      secret: 'whsec_plain',
      headers: { Authorization: 'Bearer tok' },
    });
    expect(created.secret).toBe('whsec_plain');

    const [stored] = await raw.webhooks.list(scope);
    expect(isSealedSecret(stored?.secret ?? '')).toBe(true);
    expect(stored?.headers?.Authorization).toMatch(/^e1\./);
    // Header names stay readable; only values are sealed.
    expect(Object.keys(stored?.headers ?? {})).toEqual(['Authorization']);

    const [read] = await listWebhooks(ctx, scope);
    expect(read?.secret).toBe('whsec_plain');
    expect(read?.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('reseals on update and keeps the untouched secret readable', async () => {
    const { raw, ctx } = sealedCtx();
    const w = await createWebhook(ctx, scope, {
      url: 'https://hook.example/cw',
      topics: ['*'],
      secret: 'whsec_plain',
    });
    const updated = await updateWebhook(ctx, scope, w.id, { active: false });
    expect(updated.secret).toBe('whsec_plain');
    const stored = await raw.webhooks.get(scope, w.id);
    expect(isSealedSecret(stored?.secret ?? '')).toBe(true);
    expect((await ctx.store.webhooks.get(scope, w.id))?.secret).toBe('whsec_plain');
  });

  it('signs dispatched events with the plaintext secret', async () => {
    const { ctx } = sealedCtx();
    await createWebhook(ctx, scope, {
      url: 'https://hook.example/cw',
      topics: ['*'],
      secret: 'whsec_plain',
      headers: { 'X-Api-Key': 'k1' },
    });
    const seen: Webhook[] = [];
    const sender: WebhookSender = {
      send: async (webhook) => {
        seen.push(webhook);
        return { delivered: true, statusCode: 200 };
      },
    };
    const event = {
      id: 'e1',
      type: 'entry.published',
      scope,
      entryId: 'x',
      contentTypeApiId: 'article',
      version: 1,
      occurredAt: new Date(0).toISOString(),
    } as unknown as DomainEvent;
    await dispatchEvent(ctx, { sender }, event);
    expect(seen[0]?.secret).toBe('whsec_plain');
    expect(seen[0]?.headers).toEqual({ 'X-Api-Key': 'k1' });
  });

  it('refuses a row written around the sealer (unsealed value)', async () => {
    const { raw, ctx } = sealedCtx();
    await raw.webhooks.create(scope, {
      id: 'raw',
      url: 'https://hook.example/cw',
      topics: ['*'],
      secret: 'whsec_unsealed',
      active: true,
      environmentId: null,
    });
    await expect(ctx.store.webhooks.get(scope, 'raw')).rejects.toBeInstanceOf(
      SecretUnreadableError,
    );
  });

  it('surfaces an unreadable secret instead of treating it as unset', async () => {
    const { raw } = sealedCtx();
    const foreign = createSecretSealer({ current: OLD });
    await raw.webhooks.create(scope, {
      id: 'w9',
      url: 'https://hook.example/cw',
      topics: ['*'],
      secret: await foreign.seal('x', secretContext.webhookSecret('w9')),
      active: true,
      environmentId: null,
    });
    const store = withSealedSecrets(raw, createSecretSealer({ current: KEY }));
    await expect(store.webhooks.get(scope, 'w9')).rejects.toBeInstanceOf(SecretUnreadableError);
  });

  it('passes every other store member through to the original store', async () => {
    const { raw, ctx } = sealedCtx();
    expect(ctx.store.entries).toBe(raw.entries);
    expect(ctx.store.storedSecrets).toBe(raw.storedSecrets);
    expect(await ctx.store.withTransaction(async () => 7)).toBe(7);
  });
});

describe('resealSecrets (daily sweep)', () => {
  /** A store mid-rotation: rows sealed under OLD, the deployment now on KEY with OLD previous. */
  function rotating() {
    const raw = new InMemoryContentStore();
    const sealer = createSecretSealer({ current: KEY, previous: OLD });
    const ctx: AppContext = {
      store: withSealedSecrets(raw, sealer),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('w'),
    };
    const oldStore = withSealedSecrets(raw, createSecretSealer({ current: OLD }));
    const oldRow = (id: string, secret: string) =>
      oldStore.webhooks.create(scope, {
        id,
        url: 'https://hook.example/cw',
        topics: ['*'],
        secret,
        active: true,
        environmentId: null,
        headers: { Authorization: `Bearer ${id}` },
      });
    return { raw, sealer, ctx, oldRow };
  }

  it('reseals previous-key values (secret and header values) and is idempotent', async () => {
    const { raw, sealer, ctx, oldRow } = rotating();
    await oldRow('a', 'whsec_a');
    await oldRow('b', 'whsec_b');

    const r = await resealSecrets({ store: raw, sealer });
    expect(r).toMatchObject({ examined: 4, resealed: 4, unreadable: 0, complete: true });

    const prefix = await sealer.currentPrefix();
    for (const w of await raw.webhooks.list(scope)) {
      expect(w.secret.startsWith(prefix)).toBe(true);
      expect(w.headers?.Authorization?.startsWith(prefix)).toBe(true);
    }
    const a = await ctx.store.webhooks.get(scope, 'a');
    expect(a?.secret).toBe('whsec_a');
    expect(a?.headers?.Authorization).toBe('Bearer a');

    expect(await resealSecrets({ store: raw, sealer })).toMatchObject({
      examined: 0,
      resealed: 0,
      complete: true,
    });
  });

  it('moves values from DATA_KEY_PREVIOUS onto DATA_KEY (rotation)', async () => {
    // Written under the old key...
    const before = sealedCtx({ current: OLD });
    await createWebhook(before.ctx, scope, {
      url: 'https://hook.example/cw',
      topics: ['*'],
      secret: 'whsec_rot',
      headers: { 'X-Key': 'hv' },
    });
    // ...then the deployment rotates: DATA_KEY=new, DATA_KEY_PREVIOUS=old.
    const rotated = createSecretSealer({ current: KEY, previous: OLD });
    const r = await resealSecrets({ store: before.raw, sealer: rotated });
    expect(r).toMatchObject({ resealed: 2, unreadable: 0, complete: true });

    // Once resealed, the new key alone opens everything.
    const newOnly = withSealedSecrets(before.raw, createSecretSealer({ current: KEY }));
    const [w] = await newOnly.webhooks.list(scope);
    expect(w?.secret).toBe('whsec_rot');
    expect(w?.headers).toEqual({ 'X-Key': 'hv' });
  });

  it('skips a value that changed between read and write (compare-and-set)', async () => {
    const { raw, sealer, ctx, oldRow } = rotating();
    await oldRow('a', 'whsec_old');
    // A user rotates the webhook secret while the sweep is between its read
    // and its write: intercept the first replace to simulate that interleaving.
    const original = raw.storedSecrets.replace;
    let raced = false;
    raw.storedSecrets.replace = async (ref, was, next) => {
      if (!raced && ref.column === 'webhooks.secret') {
        raced = true;
        await updateWebhook(ctx, scope, 'a', { secret: 'whsec_new' });
      }
      return original(ref, was, next);
    };
    const r = await resealSecrets({ store: raw, sealer });
    expect(r.skipped).toBe(1);
    // The user's new secret survives; the sweep never wrote the stale one back.
    expect((await ctx.store.webhooks.get(scope, 'a'))?.secret).toBe('whsec_new');
  });

  it('counts unreadable values, reports where they live, and leaves them untouched', async () => {
    const { raw, sealer } = sealedCtx();
    const lost = createSecretSealer({ current: OLD });
    const sealedLost = await lost.seal('x', secretContext.webhookSecret('z'));
    await raw.webhooks.create(scope, {
      id: 'z',
      url: 'https://hook.example/cw',
      topics: ['*'],
      secret: sealedLost,
      active: true,
      environmentId: null,
    });
    const r = await resealSecrets({ store: raw, sealer });
    expect(r.unreadable).toBe(1);
    expect(r.unreadableRefs).toEqual([{ column: 'webhooks.secret', id: 'z' }]);
    expect((await raw.webhooks.get(scope, 'z'))?.secret).toBe(sealedLost);
  });

  it('is bounded per run and continues on the next run', async () => {
    const { raw, sealer, oldRow } = rotating();
    for (const id of ['a', 'b', 'c', 'd', 'e']) await oldRow(id, `whsec_${id}`);
    // 5 secrets + 5 header values = 10 previous-key values; a budget of 4 per run.
    const first = await resealSecrets({ store: raw, sealer }, { maxRows: 4 });
    expect(first).toMatchObject({ examined: 4, resealed: 4, complete: false });
    const second = await resealSecrets({ store: raw, sealer }, { maxRows: 4 });
    expect(second).toMatchObject({ examined: 4, complete: false });
    const third = await resealSecrets({ store: raw, sealer }, { maxRows: 4 });
    expect(third).toMatchObject({ examined: 2, complete: true });
    const last = await resealSecrets({ store: raw, sealer }, { maxRows: 4 });
    expect(last).toMatchObject({ examined: 0, complete: true });
  });
});
