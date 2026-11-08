import { type BulkChunkDueEvent, type DomainEvent, NotFoundError } from '@commerceworker/domain';
import type { BulkJob, BulkJobChunk } from '@commerceworker/ports';
import {
  FixedClock,
  InMemoryContentStore,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import {
  type AppContext,
  type BulkChunkOutcome,
  cancelBulkJob,
  createSpace,
  dispatchEvent,
  getBulkJob,
  getStarterInstall,
  listBulkJobs,
  persistJob,
} from '../src/index';

/**
 * A starter's background install: one `starter_install` job per phase, each naming the next in
 * `config.next`, run through the bulk machinery with an injected chunk runner (the engine binds
 * `@commerceworker/seed`'s). The phases here are stand-ins: what matters is the chain.
 */
const scope = { spaceId: 'acme', environmentId: 'main' };
const PHASES = ['model', 'taxonomy', 'content', 'governance'];

type Runner = (scope: unknown, job: BulkJob, chunk: BulkJobChunk) => Promise<BulkChunkOutcome>;

async function setup(runner: Runner) {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('s') };
  await createSpace(ctx, { spaceId: 'acme', name: 'Acme', defaultLocale: 'en-US' });
  await createSpace(ctx, { spaceId: 'other', name: 'Other', defaultLocale: 'en-US' });
  let dispatched = store.allEvents().length;
  /** Runs the outbox's new events through dispatch, as the engine does (chunks included). */
  const drain = async () => {
    while (store.allEvents().length > dispatched) {
      const batch = store.allEvents().slice(dispatched);
      dispatched += batch.length;
      for (const e of batch) {
        await dispatchEvent(
          ctx,
          { sender: new RecordingWebhookSender(), starterChunk: runner },
          e as DomainEvent,
        );
      }
    }
  };
  return { ctx, store, drain };
}

/** Starts an install as `startEnterpriseInstall` does: the first phase's job, the rest nested. */
async function startInstall(ctx: AppContext, install = 'inst-1') {
  const configOf = (i: number) => ({
    starter: 'enterprise',
    install,
    phase: PHASES[i],
    title: `Phase ${PHASES[i]}`,
    step: i + 1,
    steps: PHASES.length,
  });
  let next: Record<string, unknown> | undefined;
  for (let i = PHASES.length - 1; i >= 1; i--) {
    next = {
      id: `${install}-job-${i + 1}`,
      totalItems: 1,
      chunkIds: ['c00000'],
      config: { ...configOf(i), ...(next ? { next } : {}) },
    };
  }
  const now = ctx.clock.now().toISOString();
  const jobId = `${install}-job-1`;
  await persistJob(
    ctx,
    scope,
    {
      id: jobId,
      action: 'starter_install',
      status: 'running',
      totalItems: 1,
      totalChunks: 1,
      completedChunks: 0,
      succeeded: 0,
      failed: 0,
      createdAt: now,
      config: { ...configOf(0), ...(next ? { next } : {}) },
    },
    [{ jobId, chunkId: 'c00000', entryIds: [], status: 'pending', attempts: 0, failures: [] }],
    now,
  );
  return jobId;
}

const phaseOf = (job: BulkJob) => String(job.config?.phase);

describe('starter installs', () => {
  it('runs every phase in order, one job each, and reads as completed', async () => {
    const ran: string[] = [];
    const h = await setup(async (_s, job) => {
      ran.push(phaseOf(job));
      // Mid-chain, the install reads as running on the phase being run.
      const progress = await getStarterInstall(h.ctx, scope, 'inst-1');
      expect(progress).toMatchObject({ status: 'running', phase: phaseOf(job) });
      return { succeeded: 1, failures: [] };
    });
    await startInstall(h.ctx);
    expect(await getStarterInstall(h.ctx, scope, 'inst-1')).toMatchObject({
      status: 'running',
      step: 1,
      steps: 4,
      phase: 'model',
      title: 'Phase model',
    });

    await h.drain();

    expect(ran).toEqual(PHASES);
    expect(await getStarterInstall(h.ctx, scope, 'inst-1')).toEqual({
      install: 'inst-1',
      starter: 'enterprise',
      step: 4,
      steps: 4,
      phase: 'governance',
      title: 'Phase governance',
      jobId: 'inst-1-job-4',
      status: 'completed',
    });
    const completed = h.store
      .allEvents()
      .filter((e) => e.type === 'bulk.job_completed')
      .map((e) => (e as { action: string }).action);
    expect(completed).toEqual([
      'starter_install',
      'starter_install',
      'starter_install',
      'starter_install',
    ]);
  });

  it('stops after a phase that fails, and reads as failed with its failures', async () => {
    const ran: string[] = [];
    const h = await setup(async (_s, job) => {
      ran.push(phaseOf(job));
      if (phaseOf(job) === 'taxonomy') {
        return { succeeded: 0, failures: [{ id: 'taxonomy', error: 'concept scheme refused' }] };
      }
      return { succeeded: 1, failures: [] };
    });
    await startInstall(h.ctx);
    await h.drain();

    expect(ran).toEqual(['model', 'taxonomy']);
    expect((await listBulkJobs(h.ctx, scope)).map((j) => j.id).sort()).toEqual([
      'inst-1-job-1',
      'inst-1-job-2',
    ]);
    expect(await getStarterInstall(h.ctx, scope, 'inst-1')).toMatchObject({
      status: 'failed',
      step: 2,
      phase: 'taxonomy',
      jobId: 'inst-1-job-2',
      failures: [{ id: 'taxonomy', error: 'concept scheme refused' }],
    });
  });

  it('retries a phase whose run threw, without running it twice once it succeeds', async () => {
    let attempts = 0;
    const ran: string[] = [];
    const h = await setup(async (_s, job) => {
      if (phaseOf(job) === 'content' && attempts++ === 0) throw new Error('D1 blip');
      ran.push(phaseOf(job));
      return { succeeded: 1, failures: [] };
    });
    await startInstall(h.ctx);
    await expect(h.drain()).rejects.toThrow('D1 blip');
    expect(await getStarterInstall(h.ctx, scope, 'inst-1')).toMatchObject({
      status: 'running',
      phase: 'content',
    });

    // The queue redelivers the chunk (released on the throw, so the claim succeeds), and a
    // duplicate delivery after it finds the chunk done.
    const due: BulkChunkDueEvent = {
      id: 'redelivery',
      type: 'bulk.chunk_due',
      scope,
      occurredAt: h.ctx.clock.now().toISOString(),
      jobId: 'inst-1-job-3',
      chunkId: 'c00000',
    };
    const deps = {
      sender: new RecordingWebhookSender(),
      starterChunk: async (_s: unknown, job: BulkJob) => {
        ran.push(phaseOf(job));
        return { succeeded: 1, failures: [] };
      },
    };
    await dispatchEvent(h.ctx, deps, due);
    await dispatchEvent(h.ctx, deps, { ...due, id: 'duplicate' });
    await h.drain();

    expect(ran).toEqual(['model', 'taxonomy', 'content', 'governance']);
    expect((await getStarterInstall(h.ctx, scope, 'inst-1')).status).toBe('completed');
  });

  it('stops the chain at a phase that keeps throwing, once its attempts run out', async () => {
    const ran: string[] = [];
    const h = await setup(async (_s, job) => {
      if (phaseOf(job) === 'taxonomy') throw new Error('always');
      ran.push(phaseOf(job));
      return { succeeded: 1, failures: [] };
    });
    await startInstall(h.ctx);
    await expect(h.drain()).rejects.toThrow('always');
    const due: BulkChunkDueEvent = {
      id: 'again',
      type: 'bulk.chunk_due',
      scope,
      occurredAt: h.ctx.clock.now().toISOString(),
      jobId: 'inst-1-job-2',
      chunkId: 'c00000',
    };
    const deps = {
      sender: new RecordingWebhookSender(),
      starterChunk: async (): Promise<BulkChunkOutcome> => {
        throw new Error('always');
      },
    };
    // Five more deliveries throw; the sixth finds the attempts spent and fails the chunk for good.
    for (let i = 0; i < 6; i++) await dispatchEvent(h.ctx, deps, due).catch(() => {});
    await h.drain();

    expect(ran).toEqual(['model']);
    expect(await getBulkJob(h.ctx, scope, 'inst-1-job-2')).toMatchObject({
      status: 'completed',
      failed: 1,
    });
    expect(await getStarterInstall(h.ctx, scope, 'inst-1')).toMatchObject({
      status: 'failed',
      phase: 'taxonomy',
      failures: [{ id: 'c00000', error: expect.stringMatching(/attempts/) }],
    });
    expect(await h.store.bulkJobs.getJob(scope, 'inst-1-job-3')).toBe(null);
  });

  it('leaves a chunk claimable when no starter runner is bound', async () => {
    const store = new InMemoryContentStore();
    const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('n') };
    await createSpace(ctx, { spaceId: 'acme', name: 'Acme', defaultLocale: 'en-US' });
    const jobId = await startInstall(ctx);
    const due = store.allEvents().find((e) => e.type === 'bulk.chunk_due') as DomainEvent;
    await dispatchEvent(ctx, { sender: new RecordingWebhookSender() }, due);
    expect((await store.bulkJobs.listChunks(scope, jobId))[0]?.status).toBe('pending');
    expect((await getStarterInstall(ctx, scope, 'inst-1')).status).toBe('running');
  });

  it('reads a cancelled phase as failed', async () => {
    const h = await setup(async () => ({ succeeded: 1, failures: [] }));
    const jobId = await startInstall(h.ctx);
    await cancelBulkJob(h.ctx, scope, jobId);
    await h.drain();
    const progress = await getStarterInstall(h.ctx, scope, 'inst-1');
    expect(progress).toMatchObject({ status: 'failed', step: 1 });
    expect(progress.failures?.length).toBe(1);
  });

  it('never shows a reader the chain, only the id of the job it starts', async () => {
    const h = await setup(async () => ({ succeeded: 1, failures: [] }));
    const jobId = await startInstall(h.ctx);
    const job = await getBulkJob(h.ctx, scope, jobId);
    expect(job.config).not.toHaveProperty('next');
    expect(job.config).toMatchObject({ install: 'inst-1', nextJobId: 'inst-1-job-2' });
    const [listed] = await listBulkJobs(h.ctx, scope);
    expect(listed?.config).not.toHaveProperty('next');
    // The machinery still has the plan.
    expect((await h.store.bulkJobs.getJob(scope, jobId))?.config).toHaveProperty('next');
  });

  it('finds an install only in its own environment, and refuses an unknown id', async () => {
    const h = await setup(async () => ({ succeeded: 1, failures: [] }));
    await startInstall(h.ctx);
    await expect(
      getStarterInstall(h.ctx, { spaceId: 'other', environmentId: 'main' }, 'inst-1'),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(getStarterInstall(h.ctx, scope, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});
