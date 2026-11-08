import { InvalidStateError, NotFoundError } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createSpace,
  deleteEnvironmentAlias,
  listEnvironmentAliases,
  resolveEnvironment,
  setEnvironmentAlias,
} from '../src/index';

function makeContext(): AppContext {
  return {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('s'),
  };
}

describe('environment aliases (blue/green)', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ctx = makeContext();
    await createSpace(ctx, {
      spaceId: 'shop',
      name: 'Shop',
      defaultLocale: 'en-US',
      environments: ['main', 'release-1', 'release-2'],
    });
  });

  it('resolves an alias to its target and repoints atomically', async () => {
    await setEnvironmentAlias(ctx, 'shop', 'production', 'release-1');
    expect(await resolveEnvironment(ctx, 'shop', 'production')).toBe('release-1');

    // A non-alias name resolves to itself (direct environment reference).
    expect(await resolveEnvironment(ctx, 'shop', 'main')).toBe('main');

    // Repoint the alias — blue/green cutover in one write.
    await setEnvironmentAlias(ctx, 'shop', 'production', 'release-2');
    expect(await resolveEnvironment(ctx, 'shop', 'production')).toBe('release-2');

    const aliases = await listEnvironmentAliases(ctx, 'shop');
    expect(aliases).toHaveLength(1);
    expect(aliases[0]).toMatchObject({ alias: 'production', targetEnvironmentId: 'release-2' });
  });

  it('rejects a target environment that does not exist', async () => {
    await expect(setEnvironmentAlias(ctx, 'shop', 'production', 'ghost')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('rejects an alias name that collides with a real environment', async () => {
    await expect(setEnvironmentAlias(ctx, 'shop', 'main', 'release-1')).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });

  it('deletes an alias (resolution falls back to the literal name)', async () => {
    await setEnvironmentAlias(ctx, 'shop', 'production', 'release-1');
    await deleteEnvironmentAlias(ctx, 'shop', 'production');
    expect(await listEnvironmentAliases(ctx, 'shop')).toHaveLength(0);
    expect(await resolveEnvironment(ctx, 'shop', 'production')).toBe('production');
    await expect(deleteEnvironmentAlias(ctx, 'shop', 'production')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
