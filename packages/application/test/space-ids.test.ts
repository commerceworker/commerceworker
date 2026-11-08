import { isReservedSpaceId, RESERVED_SPACE_IDS, ValidationError } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createSpace,
  listSpaces,
  pluginBundleKey,
  versionBodyKey,
} from '../src/index';
import { importChunkKey } from '../src/job-staging';

/**
 * A space's id is the first segment of its asset keys in the media bucket, which it shares with
 * archived version bodies, import staging, plugin bundles and dead letters. Those prefixes are
 * never space ids, so deleting a space's files can never reach them.
 */
let ctx: AppContext;

beforeEach(() => {
  ctx = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('s'),
  };
});

describe('creating a space', () => {
  it('refuses each of the bucket’s shared prefixes as its id, in any case', async () => {
    const ids = RESERVED_SPACE_IDS.flatMap((id) => [
      id,
      id.toUpperCase(),
      `${id[0]?.toUpperCase()}${id.slice(1)}`,
    ]);
    for (const spaceId of ids) {
      const err = await createSpace(ctx, { spaceId, name: spaceId, defaultLocale: 'en-US' }).catch(
        (e: unknown) => e,
      );
      expect(err, spaceId).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).issues[0]?.field).toBe('spaceId');
    }
    expect(await listSpaces(ctx)).toEqual([]);
  });

  it('covers the first segment of every key the bucket shares with asset files', () => {
    const scope = { spaceId: 'acme', environmentId: 'main' };
    for (const key of [
      versionBodyKey(scope, 'e1', 1),
      importChunkKey(scope, 'job1', 'c00000'),
      pluginBundleKey('acme', 'p1', 'abc'),
    ]) {
      expect(isReservedSpaceId(key.split('/')[0] ?? ''), key).toBe(true);
    }
  });

  it('still takes an id that only starts like one', async () => {
    for (const spaceId of ['versions-2', 'my-imports', 'plugins.dev']) {
      await createSpace(ctx, { spaceId, name: spaceId, defaultLocale: 'en-US' });
    }
    expect((await listSpaces(ctx)).map((s) => s.spaceId).sort()).toEqual([
      'my-imports',
      'plugins.dev',
      'versions-2',
    ]);
  });
});
