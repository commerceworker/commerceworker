import { type DomainEvent, NotFoundError, ValidationError } from '@commerceworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import {
  type AppContext,
  createWebhook,
  deleteWebhook,
  dispatchEvent,
  listWebhookDeliveries,
  listWebhooks,
  redeliverWebhook,
  updateWebhook,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };
const staging = { spaceId: 'shop', environmentId: 'staging' };
const hook = { url: 'https://hook.example/cw', topics: ['*' as const], secret: 's' };
const unpublished = (s: typeof scope, id = 'evt-1') =>
  ({
    id,
    type: 'entry.unpublished',
    scope: s,
    occurredAt: '2026-01-01T00:00:00.000Z',
    entryId: 'e1',
    contentTypeApiId: 'article',
  }) as DomainEvent;

function ctx(): AppContext {
  return {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('w'),
  };
}

describe('webhook management', () => {
  it('creates, updates (partial), toggles, and deletes a webhook', async () => {
    const c = ctx();
    const created = await createWebhook(c, scope, {
      url: 'https://hook.example/cw',
      topics: ['entry.published'],
      secret: 's3cr3t',
    });
    expect(created.active).toBe(true);

    // Partial update leaves untouched fields intact.
    const updated = await updateWebhook(c, scope, created.id, {
      topics: ['*'],
      active: false,
    });
    expect(updated.topics).toEqual(['*']);
    expect(updated.active).toBe(false);
    expect(updated.url).toBe('https://hook.example/cw');
    expect(updated.secret).toBe('s3cr3t');

    // Delete removes it from the list.
    await deleteWebhook(c, scope, created.id);
    expect(await listWebhooks(c, scope)).toHaveLength(0);
  });

  it('404s on update/delete of an unknown (or foreign-space) webhook', async () => {
    const c = ctx();
    await expect(updateWebhook(c, scope, 'nope', { active: false })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(deleteWebhook(c, scope, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lists recorded delivery attempts newest-first (404 if the webhook is gone)', async () => {
    const c = ctx();
    const wh = await createWebhook(c, scope, {
      url: 'https://hook.example/cw',
      topics: ['*'],
      secret: 's',
    });
    await c.store.webhooks.recordDelivery(scope, {
      webhookId: wh.id,
      eventId: 'e1',
      status: 'failed',
      statusCode: 500,
      attempts: 3,
      error: 'boom',
    });
    await c.store.webhooks.recordDelivery(scope, {
      webhookId: wh.id,
      eventId: 'e2',
      status: 'success',
      statusCode: 200,
      attempts: 1,
    });

    const deliveries = await listWebhookDeliveries(c, scope, wh.id);
    expect(deliveries.map((d) => d.eventId)).toEqual(['e2', 'e1']); // newest first
    expect(deliveries[0]?.status).toBe('success');
    expect(deliveries[1]?.error).toBe('boom');

    await expect(listWebhookDeliveries(c, scope, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('webhook environments', () => {
  it('scopes a new hook to its environment, or to every environment with allEnvironments', async () => {
    const c = ctx();
    expect((await createWebhook(c, staging, hook)).environmentId).toBe('staging');
    expect(
      (await createWebhook(c, staging, { ...hook, allEnvironments: false })).environmentId,
    ).toBe('staging');
    expect(
      (await createWebhook(c, staging, { ...hook, allEnvironments: true })).environmentId,
    ).toBe(null);
  });

  it("lists, under an environment, its own hooks and the space-wide ones, never another environment's", async () => {
    const c = ctx();
    const mainHook = await createWebhook(c, scope, hook);
    const stagingHook = await createWebhook(c, staging, hook);
    const everywhere = await createWebhook(c, scope, { ...hook, allEnvironments: true });

    expect((await listWebhooks(c, staging)).map((w) => w.id).sort()).toEqual(
      [stagingHook.id, everywhere.id].sort(),
    );
    expect((await listWebhooks(c, scope)).map((w) => w.id).sort()).toEqual(
      [mainHook.id, everywhere.id].sort(),
    );
    // Another environment's hook can't be read, changed or removed from here.
    await expect(updateWebhook(c, staging, mainHook.id, { active: false })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(deleteWebhook(c, staging, mainHook.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listWebhookDeliveries(c, staging, mainHook.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await c.store.webhooks.get(scope, mainHook.id))?.active).toBe(true);
    // A space-wide hook is managed from any environment.
    await deleteWebhook(c, staging, everywhere.id);
    expect(await listWebhooks(c, scope)).toEqual([mainHook]);
  });

  it('keeps the scope on an update that omits allEnvironments, and switches it when given', async () => {
    const c = ctx();
    const created = await createWebhook(c, staging, hook);
    expect((await updateWebhook(c, staging, created.id, { active: false })).environmentId).toBe(
      'staging',
    );
    const wide = await updateWebhook(c, staging, created.id, { allEnvironments: true });
    expect(wide.environmentId).toBeNull();
    // false scopes it to the environment the update is made in, which may be another one.
    const moved = await updateWebhook(c, scope, created.id, { allEnvironments: false });
    expect(moved.environmentId).toBe('main');
    expect(await listWebhooks(c, staging)).toEqual([]);
    expect((await listWebhooks(c, scope)).map((w) => w.id)).toEqual([created.id]);
  });

  it('never pins a hook to the target of the alias it was named through', async () => {
    const c = ctx();
    // `prod` is an alias of `blue`: the surfaces resolve it, and hand on the name as given.
    const blue = { spaceId: 'shop', environmentId: 'blue' };
    const viaProd = { requestedEnvironment: 'prod' };
    expect((await createWebhook(c, blue, hook, viaProd)).environmentId).toBeNull();
    expect(
      (await createWebhook(c, blue, { ...hook, allEnvironments: true }, viaProd)).environmentId,
    ).toBeNull();
    await expect(
      createWebhook(c, blue, { ...hook, allEnvironments: false }, viaProd),
    ).rejects.toBeInstanceOf(ValidationError);
    // Named by its own id, it is scoped as usual.
    const scoped = await createWebhook(c, blue, hook, { requestedEnvironment: 'blue' });
    expect(scoped.environmentId).toBe('blue');

    // An update under the alias keeps the scope, can widen it, and can't pin it.
    expect(
      (await updateWebhook(c, blue, scoped.id, { active: false }, viaProd)).environmentId,
    ).toBe('blue');
    await expect(
      updateWebhook(c, blue, scoped.id, { allEnvironments: false }, viaProd),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await c.store.webhooks.get(blue, scoped.id))?.environmentId).toBe('blue');
    expect(
      (await updateWebhook(c, blue, scoped.id, { allEnvironments: true }, viaProd)).environmentId,
    ).toBeNull();
  });

  it("delivers an environment's events to its own hooks and the space-wide ones only", async () => {
    const c = ctx();
    const mainHook = await createWebhook(c, scope, hook);
    const stagingHook = await createWebhook(c, staging, hook);
    const everywhere = await createWebhook(c, scope, { ...hook, allEnvironments: true });

    const sender = new RecordingWebhookSender();
    await dispatchEvent(c, { sender }, unpublished(staging, 'evt-staging'));
    expect(sender.sent.map((s) => s.webhook.id).sort()).toEqual(
      [stagingHook.id, everywhere.id].sort(),
    );

    sender.sent.length = 0;
    await dispatchEvent(c, { sender }, unpublished(scope, 'evt-main'));
    expect(sender.sent.map((s) => s.webhook.id).sort()).toEqual(
      [mainHook.id, everywhere.id].sort(),
    );
  });

  it("drops a retry once its hook has been scoped away from the event's environment", async () => {
    const c = ctx();
    const created = await createWebhook(c, staging, hook);
    const event = unpublished(staging);
    const sender = new RecordingWebhookSender();
    expect(
      await redeliverWebhook(c, { sender }, { webhookId: created.id, event, attempt: 2 }),
    ).toEqual({ delivered: true });
    // Moved to main from main's side (a space-wide hook is visible there first).
    await updateWebhook(c, staging, created.id, { allEnvironments: true });
    await updateWebhook(c, scope, created.id, { allEnvironments: false });
    expect(
      await redeliverWebhook(c, { sender }, { webhookId: created.id, event, attempt: 3 }),
    ).toBeNull();
    expect(sender.sent).toHaveLength(1);
  });
});
