import { env } from 'cloudflare:workers';
import { describeUcpLinksContract } from '@commerceworker/test-kit/commerce';
import { inArray, like } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/index';
import { ucpLinkCodes, ucpLinkGrants, ucpLinkTokens, ucpPlatforms } from '../src/schema';
import { d1UcpLinks } from '../src/ucp-links';

const { DB } = env as unknown as { DB: D1Database };

/** Clears what an earlier case left under the contract's addresses. */
async function clear() {
  const db = createDb(DB);
  const mine = db
    .select({ id: ucpLinkGrants.id })
    .from(ucpLinkGrants)
    .where(like(ucpLinkGrants.email, '%@link.test'));
  await db.delete(ucpLinkTokens).where(inArray(ucpLinkTokens.grantId, mine));
  await db.delete(ucpLinkCodes).where(like(ucpLinkCodes.email, '%@link.test'));
  await db.delete(ucpLinkGrants).where(like(ucpLinkGrants.email, '%@link.test'));
}

describeUcpLinksContract('D1', async () => {
  await clear();
  return d1UcpLinks(DB);
});

describe('what D1 keeps', () => {
  it('names each link’s platform, and falls back to its id for one it no longer has', async () => {
    await clear();
    const db = createDb(DB);
    await db
      .insert(ucpPlatforms)
      .values({
        id: 'plat_named',
        name: 'Acme Agent',
        profileUrl: 'https://acme.example/.well-known/ucp',
        keyPrefix: 'cmw_ucp_x',
        keyHash: `named-${Math.random()}`,
        createdAt: 0,
      })
      .onConflictDoNothing();
    const links = d1UcpLinks(DB);
    const g = (id: string, platformId: string) => ({
      id,
      platformId,
      email: 'names@link.test',
      scope: 'dev.ucp.shopping.order:read',
      createdAt: 1,
      expiresAt: 10_000,
      revokedAt: null,
    });
    await links.createGrant(g('lg_named', 'plat_named'), [], 1, null);
    await links.createGrant(g('lg_gone', 'plat_deleted'), [], 2, null);
    const list = await links.forShopper('names@link.test', 3);
    expect(list.map((l) => l.platformName).sort()).toEqual(['Acme Agent', 'plat_deleted']);
    await clear();
  });
});
