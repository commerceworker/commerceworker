import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { type AppContext, createEnvironment, createSpace, listEnvironments } from '../src/index';

function ctx(): AppContext {
  return {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('s'),
  };
}

describe('environments (branches)', () => {
  it('provisions a space with environments and lists them; adds more by name', async () => {
    const c = ctx();
    await createSpace(c, {
      spaceId: 'shop',
      name: 'Shop',
      defaultLocale: 'en-US',
      environments: ['main', 'staging'],
    });

    expect((await listEnvironments(c, 'shop')).map((e) => e.id)).toEqual(['main', 'staging']);

    await createEnvironment(c, 'shop', 'preview', 'Preview branch');
    const envs = await listEnvironments(c, 'shop');
    expect(envs.map((e) => e.id)).toEqual(['main', 'staging', 'preview']);
    expect(envs.find((e) => e.id === 'preview')?.name).toBe('Preview branch');

    // Adding an existing environment is a no-op (idempotent).
    await createEnvironment(c, 'shop', 'main');
    expect(await listEnvironments(c, 'shop')).toHaveLength(3);
  });
});
