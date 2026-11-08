import { type AppContext, dispatchEvent } from '@commerceworker/application';
import type { DomainEvent } from '@commerceworker/domain';
import { loadConfig } from '@commerceworker/platform/config';
import { starterChunkRunner } from '@commerceworker/seed';
import { RecordingWebhookSender } from '@commerceworker/test-kit';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app';
import { wire } from './wire';

/**
 * The enterprise starter over HTTP: offered only where the deployment says (DEMO_STARTERS),
 * installed in the background as a chain of bulk jobs, and followed at
 * `…/starter-installs/{install}`. Stand-in phases: the brand's data is tested where it lives.
 */
vi.mock('../../../seed/src/enterprise/phases', async () => {
  const { createTag } = await import('@commerceworker/application');
  const phase = (id: string, fail = false) => ({
    id,
    title: `Phase ${id}`,
    run: async (run: { ctx: AppContext; scope: { spaceId: string; environmentId: string } }) => {
      if (fail && run.scope.spaceId === 'broken') throw new Error('phase refused');
      await createTag(run.ctx, run.scope, { name: id });
    },
  });
  return { ENTERPRISE_PHASES: [phase('model'), phase('content', true)] };
});

const configWith = (demoStarters: boolean) =>
  loadConfig({
    ROLE: 'all',
    ADMIN_TOKEN: 'admin',
    CMA_KEY: 'cma',
    CDA_KEY: 'cda',
    CPA_KEY: 'cpa',
    SEED_SPACE_ID: 's1',
    ...(demoStarters ? { DEMO_STARTERS: 'true' } : {}),
  } as NodeJS.ProcessEnv);

const admin = { authorization: 'Bearer admin', 'content-type': 'application/json' };

function setup(demoStarters: boolean) {
  const config = configWith(demoStarters);
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  const store = wired.ctx.store as unknown as { allEvents(): DomainEvent[] };
  let dispatched = store.allEvents().length;
  /** The engine's part: every new event through dispatch, starter chunks included. */
  const drain = async () => {
    const deps = {
      sender: new RecordingWebhookSender(),
      starterChunk: starterChunkRunner(wired.ctx),
    };
    while (store.allEvents().length > dispatched) {
      const batch = store.allEvents().slice(dispatched);
      dispatched += batch.length;
      for (const e of batch) await dispatchEvent(wired.ctx, deps, e).catch(() => {});
    }
  };
  const create = (spaceId: string, starter: string) =>
    app.request('/spaces', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ spaceId, name: spaceId, defaultLocale: 'en-US', starter }),
    });
  const progress = (spaceId: string, install: string, token = 'admin') =>
    app.request(`/spaces/${spaceId}/environments/main/starter-installs/${install}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  return { wired, app, drain, create, progress };
}

describe('the enterprise starter over HTTP', () => {
  it('is a 422 naming the starter where the deployment does not offer it', async () => {
    const h = setup(false);
    const res = await h.create('acme', 'enterprise');
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { issues: { field: string; message: string }[] } };
    expect(body.error.issues[0]).toMatchObject({
      field: 'starter',
      message: expect.stringMatching(/not available on this deployment/),
    });
    expect(
      await h.wired.ctx.store.spaces.getConfig({ spaceId: 'acme', environmentId: 'main' }),
    ).toBe(null);
  });

  it('creates the space at once and installs it in the background, followed to completion', async () => {
    const h = setup(true);
    const res = await h.create('acme', 'enterprise');
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      starter: string;
      installing: { install: string; jobId: string; steps: number };
    };
    expect(body).toMatchObject({ id: 'acme', starter: 'enterprise', installing: { steps: 2 } });
    const { install, jobId } = body.installing;

    const running = await h.progress('acme', install);
    expect(running.status).toBe(200);
    expect(await running.json()).toMatchObject({
      install,
      starter: 'enterprise',
      status: 'running',
      step: 1,
      steps: 2,
      phase: 'model',
      jobId,
    });
    // The job a client can read carries no chain plan.
    const job = await h.app.request(`/spaces/acme/environments/main/bulk/jobs/${jobId}`, {
      headers: { authorization: 'Bearer admin' },
    });
    const read = (await job.json()) as { action: string; config: Record<string, unknown> };
    expect(read.action).toBe('starter_install');
    expect(read.config).not.toHaveProperty('next');
    expect(typeof read.config.nextJobId).toBe('string');

    await h.drain();
    expect(await (await h.progress('acme', install)).json()).toMatchObject({
      status: 'completed',
      step: 2,
      phase: 'content',
    });
  });

  it('reads a phase that failed for good as failed, with what went wrong', async () => {
    const h = setup(true);
    const { installing } = (await (await h.create('broken', 'enterprise')).json()) as {
      installing: { install: string };
    };
    // Each delivery throws and releases the chunk; the attempt limit then fails it for good.
    for (let i = 0; i < 7; i++) {
      await h.drain();
      const chunk = (
        await h.wired.ctx.store.bulkJobs.findStalledChunks(new Date('2100-01-01'), 10)
      )[0];
      if (!chunk) break;
      await dispatchEvent(
        h.wired.ctx,
        { sender: new RecordingWebhookSender(), starterChunk: starterChunkRunner(h.wired.ctx) },
        {
          id: `retry-${i}`,
          type: 'bulk.chunk_due',
          scope: chunk.scope,
          occurredAt: new Date().toISOString(),
          jobId: chunk.jobId,
          chunkId: chunk.chunkId,
        },
      ).catch(() => {});
    }
    const body = (await (await h.progress('broken', installing.install)).json()) as {
      status: string;
      phase: string;
      failures: { error: string }[];
    };
    expect(body).toMatchObject({ status: 'failed', phase: 'content' });
    expect(body.failures[0]?.error).toMatch(/attempts/);
  });

  it('keeps an install to its own space, and its progress to content:write callers', async () => {
    const h = setup(true);
    const { installing } = (await (await h.create('acme', 'enterprise')).json()) as {
      installing: { install: string };
    };
    expect((await h.progress('s1', installing.install)).status).toBe(404);
    expect((await h.progress('acme', 'unknown')).status).toBe(404);
    // A delivery key, and a management key of another space.
    expect((await h.progress('s1', installing.install, 'cda')).status).toBe(403);
    expect((await h.progress('acme', installing.install, 'cma')).status).toBe(403);
  });
});

describe('GET /starters', () => {
  const list = async (demoStarters: boolean, token = 'admin') =>
    setup(demoStarters).app.request('/starters', {
      headers: { authorization: `Bearer ${token}` },
    });

  it('lists the request-time starters, and the enterprise one where offered', async () => {
    const plain = (await (await list(false)).json()) as { items: { id: string }[] };
    expect(plain.items.map((s) => s.id)).toEqual(['sample', 'empty']);
    const demo = (await (await list(true)).json()) as {
      items: { id: string; background: boolean; title: string; description: string }[];
    };
    expect(demo.items.map((s) => [s.id, s.background])).toEqual([
      ['sample', false],
      ['empty', false],
      ['enterprise', true],
    ]);
    expect(demo.items[2]?.description).toMatch(/background/);
  });

  it("refuses anyone who can't create a space: a space's own keys", async () => {
    for (const token of ['cma', 'cda']) expect((await list(true, token)).status, token).toBe(403);
    expect((await setup(true).app.request('/starters')).status).toBe(401);
  });
});
