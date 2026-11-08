import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import type { Principal } from '@commerceworker/domain';
import { describe, expect, it } from 'vitest';
import { createApiHasher } from '../../src/api/auth';
import { deliveryApp, deliveryRoutes } from '../../src/api/routes/delivery';
import { testConfig } from './config';
import { wire } from './wire';

const config = testConfig({
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
});

/** The delivery routes as the delivery Worker serves them: on their own, behind its gateway. */
function app() {
  const { ctx, rag, blob, ai, bus } = wire(config);
  const principal = { spaceId: 's1', kind: 'cda', scopes: ['delivery:read'] } as Principal;
  return deliveryApp(
    deliveryRoutes({
      ctx,
      hasher: createApiHasher(config.tokenPepper),
      adminToken: '',
      rag,
      blob,
      ai,
      bus,
      agents: new InProcessAgentRuntime(makeActivities({ ctx, ai })),
      trustedPrincipal: () => principal,
    }),
  );
}

describe('the delivery routes served on their own', () => {
  it('answer an unknown entry with the api’s 404, not a bare 500', async () => {
    const res = await app().request(
      '/delivery/s1/main/entries/00000000-0000-7000-8000-000000000000',
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBeTruthy();
  });

  it('answer an unknown asset with a 404 too', async () => {
    const res = await app().request(
      '/delivery/s1/main/assets/00000000-0000-7000-8000-000000000000',
    );
    expect(res.status).toBe(404);
  });
});
