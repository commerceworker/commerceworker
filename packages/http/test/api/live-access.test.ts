import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import { LIVE_ACCESS_HEADER, liveHubName } from '@commerceworker/platform/do/live-access';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { createApiHasher } from '../../src/api/auth';
import { liveRoutes } from '../../src/routes/live';
import { testConfig } from './config';
import { wire } from './wire';

const config = testConfig({
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  adminToken: 'admin',
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
});
const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };

/**
 * The live route over a stand-in hub namespace that records which hub it was asked for and the
 * request forwarded to it.
 */
async function setup() {
  const wired = wire(config);
  const { ctx, rag, blob, ai, bus } = wired;
  const app = createApp(ctx, config, rag, blob, ai, inMemoryEdge(), bus);
  const forwarded: { hub: string; request: Request }[] = [];
  const ns = {
    idFromName: (name: string) => name,
    get: (hub: string) => ({
      fetch: async (request: Request) => {
        forwarded.push({ hub, request });
        return new Response('stream');
      },
    }),
  } as unknown as DurableObjectNamespace;
  const live = liveRoutes(
    {
      ...inMemoryEdge(),
      ctx,
      hasher: createApiHasher(config.tokenPepper),
      adminToken: '',
      rag,
      blob,
      ai,
      bus,
      agents: new InProcessAgentRuntime(makeActivities({ ctx, ai })),
    },
    // biome-ignore lint/suspicious/noExplicitAny: the stand-in only implements what the route uses
    ns as any,
  );
  /** A delivery key whose role carries `contentGrants`. */
  const keyFor = async (contentGrants: unknown[]) => {
    const role = (await (
      await app.request('/spaces/s1/roles', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ name: 'Live reader', scopes: ['delivery:read'], contentGrants }),
      })
    ).json()) as { id: string };
    const key = (await (
      await app.request('/spaces/s1/api-keys', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ kind: 'cda', roleId: role.id }),
      })
    ).json()) as { token: string };
    return key.token;
  };
  const access = (i = 0) => JSON.parse(forwarded[i]?.request.headers.get(LIVE_ACCESS_HEADER) ?? '');
  return { live, forwarded, keyFor, access };
}

describe('the live route’s access stamp', () => {
  it('replaces whatever access a caller sends with the authorized principal’s', async () => {
    const { live, keyFor, access } = await setup();
    const token = await keyFor([{ contentTypeApiId: 'post', actions: ['read'] }]);
    const res = await live.request('/delivery/s1/main/live', {
      headers: { Authorization: `Bearer ${token}`, [LIVE_ACCESS_HEADER]: '{}' },
    });
    expect(res.status).toBe(200);
    expect(access()).toEqual({
      scope: { spaceId: 's1', environmentId: 'main' },
      contentGrants: [{ contentTypeApiId: 'post', actions: ['read'] }],
    });
  });

  it('keeps a role with no grants restricted to nothing, and an unrestricted key unrestricted', async () => {
    const { live, keyFor, access } = await setup();
    const none = await keyFor([]);
    await live.request('/delivery/s1/main/live', { headers: { Authorization: `Bearer ${none}` } });
    expect(access(0).contentGrants).toEqual([]);
    await live.request('/delivery/s1/main/live', { headers: { Authorization: 'Bearer cda' } });
    expect(access(1).contentGrants).toBeUndefined();
  });

  it('never names another scope’s hub through a separator in the environment', async () => {
    const { live, forwarded } = await setup();
    await live.request('/delivery/s1/eu:main/live', { headers: { Authorization: 'Bearer cda' } });
    for (const { hub } of forwarded) {
      expect(hub).not.toBe(liveHubName({ spaceId: 's1:eu', environmentId: 'main' }));
    }
  });
});
