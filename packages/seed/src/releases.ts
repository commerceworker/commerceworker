import { addEntryToRelease, createRelease, listReleases } from '@commerceworker/application';
import type { SeedRun } from './types';

export interface ReleaseSeed {
  /** The open "Autumn launch" release — target for a scheduled publish. */
  readonly autumnReleaseId: string | null;
}

/**
 * Two demo releases: the original "Spring demo release" and an open
 * "Autumn launch" bundling articles + products (the scheduled-actions demo
 * targets the latter). Idempotent by title.
 */
export async function seedReleases(
  run: SeedRun,
  articleIds: readonly string[],
  productIds: readonly string[],
): Promise<ReleaseSeed> {
  const { ctx, scope } = run;
  const existing = await listReleases(ctx, scope);

  if (!existing.some((r) => r.title === 'Spring demo release') && articleIds.length >= 2) {
    const spring = await createRelease(ctx, scope, {
      title: 'Spring demo release',
      description: 'Sample release bundling seeded articles for the Releases UI.',
    });
    for (const entityId of articleIds.slice(0, 2)) {
      await addEntryToRelease(ctx, scope, spring.id, { entityId });
    }
  }

  // The list's summary and a freshly created release differ in shape; only the id is needed.
  let autumnId = existing.find((r) => r.title === 'Autumn launch')?.id;
  if (!autumnId && articleIds.length >= 4 && productIds.length >= 2) {
    const autumn = await createRelease(ctx, scope, {
      title: 'Autumn launch',
      description: 'Open release mixing articles and products; a scheduled publish targets it.',
    });
    autumnId = autumn.id;
    for (const entityId of [...articleIds.slice(2, 4), ...productIds.slice(0, 2)]) {
      await addEntryToRelease(ctx, scope, autumn.id, { entityId });
    }
  }
  return { autumnReleaseId: autumnId ?? null };
}
