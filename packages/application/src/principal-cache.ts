import type { AppContext } from './context';

/** Cache tag on every cached principal of a space (see {@link authenticateCached}). */
export const principalCacheTag = (spaceId: string) => `principals:${spaceId}`;

/** Drops every cached principal of a space; call after any change to its keys or roles. */
export async function invalidateCachedPrincipals(ctx: AppContext, spaceId: string): Promise<void> {
  await ctx.cache?.invalidateTag(principalCacheTag(spaceId)).catch(() => {});
}
