import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import { recordSchedulerTick, SchedulerTick } from '@commerceworker/application';
import type { Principal } from '@commerceworker/domain';
import { type ApiConfig, loadConfig } from '@commerceworker/platform/config';
import { principalTarget, signPrincipal } from '@commerceworker/security/principal';
import {
  FixedClock,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  StubAIProvider,
} from '@commerceworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, HEALTH_SCHEDULER_TTL_MS } from '../../src/api/app';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';
import { testConfig } from './config';
import { wire } from './wire';

const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
});

function build() {
  const w = wire(config);
  const clock = new FixedClock(new Date('2026-11-01T10:00:00.000Z'));
  const ctx = { ...w.ctx, clock };
  return { ctx, clock, app: createApp(ctx, config, w.rag, w.blob, w.ai) };
}

async function tick(ctx: Parameters<typeof recordSchedulerTick>[0], fail?: string) {
  const t = new SchedulerTick(ctx.clock);
  t.ok('outbox-relay');
  if (fail) t.fail('scheduled-actions', new Error(fail));
  await recordSchedulerTick(ctx, t);
}

describe('GET /health', () => {
  it('says only whether the scheduler is ticking, and stays 200 when it is stale', async () => {
    const { ctx, clock, app } = build();
    let res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', scheduler: 'stale' });

    await tick(ctx, 'boom at https://user:secret@hooks.example');
    // The isolate keeps the answer it read for the window: a probe flood is one read.
    expect(await (await app.request('/health')).json()).toEqual({
      status: 'ok',
      scheduler: 'stale',
    });
    clock.advance(HEALTH_SCHEDULER_TTL_MS);
    res = await app.request('/health');
    const body = await res.json();
    expect(body).toEqual({ status: 'ok', scheduler: 'ok' });
    // Nothing about jobs or errors leaks to an unauthenticated caller.
    expect(JSON.stringify(body)).not.toMatch(/outbox|scheduled-actions|boom/);

    clock.advance(6 * 60_000);
    expect(await (await app.request('/health')).json()).toEqual({
      status: 'ok',
      scheduler: 'stale',
    });
  });
});

describe('GET /health/scheduler', () => {
  it('answers 503 while the scheduler is stale, for an uptime monitor, and 200 once it ticks', async () => {
    const { ctx, clock, app } = build();
    let res = await app.request('/health/scheduler');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ scheduler: 'stale' });
    // `/health` stays 200 through it: the api is live, and the deploy smoke test reads it.
    expect((await app.request('/health')).status).toBe(200);

    await tick(ctx, 'boom');
    clock.advance(HEALTH_SCHEDULER_TTL_MS);
    res = await app.request('/health/scheduler');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scheduler: 'ok' });
  });

  it('answers 503 when the heartbeat cannot be read', async () => {
    const { ctx, clock } = build();
    const broken = {
      ...ctx,
      store: {
        ...ctx.store,
        schedulerJobs: {
          ...ctx.store.schedulerJobs,
          list: async () => {
            throw new Error('D1_ERROR');
          },
        },
      },
    };
    const w = wire(config);
    const app = createApp({ ...broken, clock }, config, w.rag, w.blob, w.ai);
    const res = await app.request('/health/scheduler');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ scheduler: 'unknown' });
  });
});

describe('/deployment/scheduler/alerts', () => {
  const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };

  it('sets and reads who is emailed, for the deployment admin', async () => {
    const { app } = build();
    let res = await app.request('/deployment/scheduler/alerts', { headers: admin });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recipients: [], open: [], recent: [] });

    res = await app.request('/deployment/scheduler/alerts', {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ recipients: ['OnCall@Example.com', 'oncall@example.com'] }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { recipients: string[] }).recipients).toEqual([
      'oncall@example.com',
    ]);
  });

  it('refuses an address that is not one', async () => {
    const { app } = build();
    const res = await app.request('/deployment/scheduler/alerts', {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ recipients: ['oncall'] }),
    });
    expect(res.status).toBe(422);
  });

  it('refuses a signed-in person who is not a deployment administrator', async () => {
    const KEY = 'test-principal-key-0123456789abcdef';
    const signedConfig = loadConfig({
      ROLE: 'all',
      ADMIN_TOKEN: 'admin',
      CMA_KEY: 'cma',
      CDA_KEY: 'cda',
      CPA_KEY: 'cpa',
      SEED_SPACE_ID: 's1',
      PRINCIPAL_KEY: KEY,
    } as NodeJS.ProcessEnv);
    const w = wire(signedConfig);
    const app = createApp(w.ctx, signedConfig, w.rag, w.blob, w.ai);
    const member = async (method: string) => ({
      'x-cw-principal': await signPrincipal(
        KEY,
        { sub: 'usr_member', email: 'member@example.com', name: 'member', role: 'member' },
        principalTarget(method, '/deployment/scheduler/alerts'),
      ),
      'Content-Type': 'application/json',
    });
    const get = await app.request('/deployment/scheduler/alerts', { headers: await member('GET') });
    expect(get.status).toBe(403);
    const put = await app.request('/deployment/scheduler/alerts', {
      method: 'PUT',
      headers: await member('PUT'),
      body: JSON.stringify({ recipients: ['attacker@example.com'] }),
    });
    expect(put.status).toBe(403);
  });

  it('refuses a space’s own keys and anonymous callers', async () => {
    const { app } = build();
    const asKey = await app.request('/deployment/scheduler/alerts', {
      method: 'PUT',
      headers: { Authorization: 'Bearer cma', 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients: ['a@example.com'] }),
    });
    expect(asKey.status).toBe(403);
    expect(
      (
        await app.request('/deployment/scheduler/alerts', {
          headers: { Authorization: 'Bearer cma' },
        })
      ).status,
    ).toBe(403);
    expect((await app.request('/deployment/scheduler/alerts')).status).toBe(401);
  });
});

describe('GET /deployment/scheduler', () => {
  it('shows each sweep to the deployment admin', async () => {
    const { ctx, app } = build();
    await tick(ctx, 'queue unavailable');
    const res = await app.request('/deployment/scheduler', {
      headers: { Authorization: 'Bearer admin' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scheduler: string;
      jobs: { job: string; lastError?: string }[];
    };
    expect(body.scheduler).toBe('ok');
    expect(body.jobs.map((j) => j.job)).toEqual(['outbox-relay', 'scheduled-actions']);
    expect(body.jobs[1]?.lastError).toBe('queue unavailable');
  });

  it('refuses a space’s own keys and anonymous callers', async () => {
    const { app } = build();
    const asKey = await app.request('/deployment/scheduler', {
      headers: { Authorization: 'Bearer cma' },
    });
    expect(asKey.status).toBe(403);
    expect((await app.request('/deployment/scheduler')).status).toBe(401);
  });
});

describe('MCP scheduler_status', () => {
  const hasher = { hash: (v: string) => createHash('sha256').update(v).digest('hex') };

  async function connect(deps: McpDeps, principal: Principal) {
    const server = buildServer(deps, principal);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    return client;
  }

  function deps(ctx: McpDeps['ctx']): McpDeps {
    const ai = new StubAIProvider(() => ({}));
    return {
      ctx,
      ai,
      rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
      hasher,
      adminToken: 'admin',
      agents: new InProcessAgentRuntime(makeActivities({ ctx, ai })),
    };
  }

  it('answers the same as the route for the root token, and refuses a space key', async () => {
    const { ctx, app } = build();
    await tick(ctx, 'queue unavailable');
    const route = await (
      await app.request('/deployment/scheduler', { headers: { Authorization: 'Bearer admin' } })
    ).json();

    const root = await connect(deps(ctx), { spaceId: '*', kind: 'admin', scopes: [] });
    const result = await root.callTool({ name: 'scheduler_status', arguments: {} });
    const content = result.content as { type: string; text?: string }[];
    expect(JSON.parse(content.find((c) => c.type === 'text')?.text ?? 'null')).toEqual(route);

    const scoped = await connect(deps(ctx), {
      spaceId: 's1',
      kind: 'cma',
      scopes: ['space:admin'],
    });
    expect((await scoped.callTool({ name: 'scheduler_status', arguments: {} })).isError).toBe(true);
  });
});

describe('MCP scheduler alert tools', () => {
  const hasher = { hash: (v: string) => createHash('sha256').update(v).digest('hex') };

  async function connect(ctx: McpDeps['ctx'], principal: Principal) {
    const ai = new StubAIProvider(() => ({}));
    const server = buildServer(
      {
        ctx,
        ai,
        rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
        hasher,
        adminToken: 'admin',
        agents: new InProcessAgentRuntime(makeActivities({ ctx, ai })),
      },
      principal,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    return client;
  }
  const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
    JSON.parse(
      (result.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ??
        'null',
    );

  it('sets and reads the same as the routes, and refuses a space key', async () => {
    const { ctx, app } = build();
    const root = await connect(ctx, { spaceId: '*', kind: 'admin', scopes: [] });
    const set = await root.callTool({
      name: 'scheduler_alerts_set_recipients',
      arguments: { recipients: ['oncall@example.com'] },
    });
    expect(text(set).recipients).toEqual(['oncall@example.com']);
    const route = await (
      await app.request('/deployment/scheduler/alerts', {
        headers: { Authorization: 'Bearer admin' },
      })
    ).json();
    expect(text(await root.callTool({ name: 'scheduler_alerts', arguments: {} }))).toEqual(route);

    const scoped = await connect(ctx, { spaceId: 's1', kind: 'cma', scopes: ['space:admin'] });
    expect((await scoped.callTool({ name: 'scheduler_alerts', arguments: {} })).isError).toBe(true);
    expect(
      (
        await scoped.callTool({
          name: 'scheduler_alerts_set_recipients',
          arguments: { recipients: ['x@example.com'] },
        })
      ).isError,
    ).toBe(true);
  });

  it('declares the read read-only, and the setter not', async () => {
    const { ctx } = build();
    const root = await connect(ctx, { spaceId: '*', kind: 'admin', scopes: [] });
    const { tools } = await root.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.scheduler_alerts?.annotations?.readOnlyHint).toBe(true);
    expect(byName.scheduler_alerts_set_recipients?.annotations?.readOnlyHint).not.toBe(true);
  });
});

describe('scheduler alert recipients audit', () => {
  afterEach(() => vi.restoreAllMocks());

  const audits = (log: { mock: { calls: unknown[][] } }) =>
    log.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line)) as Record<string, unknown>;
        } catch {
          return {};
        }
      })
      .filter((l) => l.type === 'deployment_audit');

  it('records the root token as the actor over HTTP and over MCP alike', async () => {
    const { ctx, app } = build();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await app.request('/deployment/scheduler/alerts', {
      method: 'PUT',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients: ['oncall@example.com'] }),
    });
    expect(res.status).toBe(200);

    const ai = new StubAIProvider(() => ({}));
    const server = buildServer(
      {
        ctx,
        ai,
        rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
        hasher: { hash: (v: string) => createHash('sha256').update(v).digest('hex') },
        adminToken: 'admin',
        agents: new InProcessAgentRuntime(makeActivities({ ctx, ai })),
      },
      { spaceId: '*', kind: 'admin', scopes: [] },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: 'scheduler_alerts_set_recipients',
      arguments: { recipients: ['a@example.com', 'b@example.com'] },
    });
    expect(result.isError).not.toBe(true);

    expect(audits(log)).toEqual([
      expect.objectContaining({
        action: 'scheduler.alerts.recipients_set',
        actor: 'admin-token',
        count: 1,
      }),
      expect.objectContaining({
        action: 'scheduler.alerts.recipients_set',
        actor: 'admin-token',
        count: 2,
      }),
    ]);
    expect(JSON.stringify(audits(log))).not.toContain('example.com');
  });
});
