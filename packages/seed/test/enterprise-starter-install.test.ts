import {
  type AppContext,
  dispatchEvent,
  getSpaceConfig,
  getStarterInstall,
  listBulkJobs,
  listTags,
} from '@commerceworker/application';
import { type DomainEvent, ValidationError } from '@commerceworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { describe, expect, it, vi } from 'vitest';
import {
  availableStarters,
  createSpaceWithStarter,
  ENTERPRISE_STARTER_INFO,
  starterChunkRunner,
} from '../src/index';

/**
 * Stand-in phases, so this tests the install's wiring (the space, the job chain, the runner) and
 * not the brand's data, which has its own D1 test. Each writes a tag, so a duplicate run shows.
 */
vi.mock('../src/enterprise/phases', async () => {
  const { createTag, listTags } = await import('@commerceworker/application');
  const phase = (id: string) => ({
    id,
    title: `Phase ${id}`,
    run: async (run: { ctx: AppContext; scope: { spaceId: string; environmentId: string } }) => {
      if ((await listTags(run.ctx, run.scope)).some((t) => t.name === id)) return;
      await createTag(run.ctx, run.scope, { name: id });
    },
  });
  return { ENTERPRISE_PHASES: [phase('model'), phase('content'), phase('governance')] };
});

const scope = { spaceId: 'acme', environmentId: 'main' };
const input = {
  spaceId: 'acme',
  name: 'Acme',
  defaultLocale: 'en-US',
  starter: 'enterprise' as const,
};

function setup() {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  let dispatched = 0;
  const drain = async () => {
    const deps = { sender: new RecordingWebhookSender(), starterChunk: starterChunkRunner(ctx) };
    while (store.allEvents().length > dispatched) {
      const batch = store.allEvents().slice(dispatched);
      dispatched += batch.length;
      for (const e of batch) await dispatchEvent(ctx, deps, e as DomainEvent);
    }
  };
  return { ctx, store, drain };
}

describe('the enterprise starter install', () => {
  it('is refused where the deployment does not offer it, before anything is written', async () => {
    const h = setup();
    const refused = createSpaceWithStarter(h.ctx, input);
    await expect(refused).rejects.toBeInstanceOf(ValidationError);
    await expect(refused).rejects.toMatchObject({
      issues: [{ field: 'starter', message: expect.stringMatching(/not available/) }],
    });
    expect(await h.store.spaces.getConfig(scope)).toBe(null);
    expect(availableStarters(false).map((s) => s.id)).toEqual(['sample', 'empty']);
  });

  it('creates the space with the brand locales and runs its phases in the background', async () => {
    const h = setup();
    const created = await createSpaceWithStarter(h.ctx, input, {}, { allowEnterprise: true });
    expect(created.starter).toBe('enterprise');
    expect(created.installed).toBeUndefined();
    expect(created.installing).toMatchObject({ steps: 3 });
    const install = created.installing?.install as string;

    const config = await getSpaceConfig(h.ctx, scope);
    expect(config.defaultLocale).toBe('en-US');
    expect([...config.locales].sort()).toEqual([...ENTERPRISE_STARTER_INFO.locales].sort());

    // Nothing is installed by the request itself: one job is waiting for the engine.
    expect(await listTags(h.ctx, scope)).toEqual([]);
    const [first] = await listBulkJobs(h.ctx, scope);
    expect(first).toMatchObject({ id: created.installing?.jobId, action: 'starter_install' });
    expect(await getStarterInstall(h.ctx, scope, install)).toMatchObject({
      status: 'running',
      step: 1,
      steps: 3,
      phase: 'model',
    });

    await h.drain();
    expect((await listTags(h.ctx, scope)).map((t) => t.name).sort()).toEqual([
      'content',
      'governance',
      'model',
    ]);
    expect(await getStarterInstall(h.ctx, scope, install)).toMatchObject({
      status: 'completed',
      step: 3,
      phase: 'governance',
    });
  });

  it('starting it again adds nothing the first install already made', async () => {
    const h = setup();
    await createSpaceWithStarter(h.ctx, input, {}, { allowEnterprise: true });
    await h.drain();
    const again = await createSpaceWithStarter(h.ctx, input, {}, { allowEnterprise: true });
    await h.drain();
    expect((await listTags(h.ctx, scope)).length).toBe(3);
    expect(
      (await getStarterInstall(h.ctx, scope, again.installing?.install as string)).status,
    ).toBe('completed');
  });

  it('is offered, after the request-time starters, where the deployment allows it', () => {
    expect(availableStarters(true)).toEqual([
      expect.objectContaining({ id: 'sample', background: false }),
      expect.objectContaining({ id: 'empty', background: false }),
      expect.objectContaining({
        id: 'enterprise',
        background: true,
        title: ENTERPRISE_STARTER_INFO.title,
      }),
    ]);
  });
});
