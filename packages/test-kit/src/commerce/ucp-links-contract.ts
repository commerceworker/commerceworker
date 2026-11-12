/**
 * The behaviour every `UcpLinks` keeps: the in-memory store runs it in node and the D1 store in
 * workerd (packages/db). Addresses end `@link.test`, which the D1 runner clears before each case;
 * secrets are made fresh per case, so a case never meets another's rows.
 */
import type { LinkCode, LinkGrant, LinkToken, UcpLinks } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

const now = 1_000_000;
let n = 0;
const uid = () =>
  `${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const hash = () => uid().padEnd(64, '0');

const code = (email: string, platformId = 'plat_a', at = now): LinkCode => ({
  codeHash: hash(),
  grantId: `lg_${uid()}`,
  platformId,
  email,
  scope: 'dev.ucp.shopping.order:read',
  redirectUri: 'https://a.example/cb',
  challenge: 'c'.repeat(43),
  createdAt: at,
  expiresAt: at + 60_000,
});
const grant = (email: string, platformId = 'plat_a', at = now): LinkGrant => ({
  id: `lg_${uid()}`,
  platformId,
  email,
  scope: 'dev.ucp.shopping.order:read',
  createdAt: at,
  expiresAt: at + 1_000_000,
  revokedAt: null,
});
const token = (g: LinkGrant, kind: 'access' | 'refresh', ttl: number, at = now): LinkToken => ({
  tokenHash: hash(),
  grantId: g.id,
  kind,
  scope: g.scope,
  createdAt: at,
  expiresAt: at + ttl,
});
/** A link with its first access and refresh tokens, stored. */
async function linked(links: UcpLinks, email: string, platformId = 'plat_a', at = now) {
  const g = grant(email, platformId, at);
  const access = token(g, 'access', 900_000, at);
  const refresh = token(g, 'refresh', 900_000, at);
  expect(await links.createGrant(g, [access, refresh], at, null)).toBe(true);
  return { g, access, refresh };
}

export function describeUcpLinksContract(name: string, make: () => Promise<UcpLinks>) {
  describe(`${name}: the identity-linking contract`, () => {
    it('spends a code once, and says a second use is a replay', async () => {
      const links = await make();
      const c = code('a@link.test');
      await links.issueCode(c);
      expect(await links.spendCode(c.codeHash, now + 1)).toEqual({ kind: 'spent', code: c });
      expect(await links.spendCode(c.codeHash, now + 2)).toEqual({
        kind: 'replayed',
        grantId: c.grantId,
      });
    });

    it('lets exactly one of two racing redemptions spend a code', async () => {
      const links = await make();
      const c = code('a@link.test');
      await links.issueCode(c);
      const [x, y] = await Promise.all([
        links.spendCode(c.codeHash, now + 1),
        links.spendCode(c.codeHash, now + 1),
      ]);
      expect([x?.kind, y?.kind].sort()).toEqual(['replayed', 'spent']);
    });

    it('refuses an expired or unknown code, and still calls a spent one a replay after it expired', async () => {
      const links = await make();
      const c = code('a@link.test');
      await links.issueCode(c);
      expect(await links.spendCode(c.codeHash, c.expiresAt)).toBeNull();
      expect(await links.spendCode(hash(), now)).toBeNull();
      const d = code('a@link.test');
      await links.issueCode(d);
      await links.spendCode(d.codeHash, now + 1);
      expect(await links.spendCode(d.codeHash, d.expiresAt + 1)).toMatchObject({
        kind: 'replayed',
      });
    });

    it('starts a link whose access token reads until it expires', async () => {
      const links = await make();
      const { g, access } = await linked(links, 'b@link.test');
      expect(await links.access(access.tokenHash, now + 1)).toEqual({ grant: g, scope: g.scope });
      expect(await links.access(access.tokenHash, access.expiresAt)).toBeNull();
      expect(await links.access(hash(), now)).toBeNull();
    });

    it('does not take a refresh token for an access token', async () => {
      const links = await make();
      const { refresh } = await linked(links, 'b@link.test');
      expect(await links.access(refresh.tokenHash, now + 1)).toBeNull();
    });

    it('ends every token of a link when it is revoked, and when it expires', async () => {
      const links = await make();
      const a = await linked(links, 'c@link.test');
      expect(await links.revokeGrant(a.g.id, now + 5)).toBe(true);
      expect(await links.revokeGrant(a.g.id, now + 6)).toBe(false);
      expect(await links.access(a.access.tokenHash, now + 7)).toBeNull();
      expect(await links.grant(a.g.id)).toMatchObject({ revokedAt: now + 5 });
      // Past the link's absolute end its access token is dead though the token itself isn't.
      const b = await linked(links, 'c@link.test', 'plat_b');
      expect(await links.access(b.access.tokenHash, b.g.expiresAt)).toBeNull();
    });

    it('keeps one live link per address and platform: a new consent ends the old one', async () => {
      const links = await make();
      const first = await linked(links, 'd@link.test', 'plat_a');
      const other = await linked(links, 'd@link.test', 'plat_b');
      const second = await linked(links, 'd@link.test', 'plat_a', now + 10);
      expect(await links.access(first.access.tokenHash, now + 11)).toBeNull();
      expect(await links.access(second.access.tokenHash, now + 11)).not.toBeNull();
      expect(await links.access(other.access.tokenHash, now + 11)).not.toBeNull();
      const mine = await links.forShopper('d@link.test', now + 11);
      expect(mine.map((l) => l.platformId).sort()).toEqual(['plat_a', 'plat_b']);
    });

    it('rotates a refresh token once, and stores the successors only for that one', async () => {
      const links = await make();
      const { g, refresh } = await linked(links, 'e@link.test');
      const next = (at: number) => [
        token(g, 'access', 900_000, at),
        token(g, 'refresh', 900_000, at),
      ];
      const [a, b] = [next(now + 1), next(now + 1)];
      const [x, y] = await Promise.all([
        links.rotate(refresh.tokenHash, a, now + 1),
        links.rotate(refresh.tokenHash, b, now + 1),
      ]);
      expect([x, y].sort()).toEqual(['reused', 'rotated']);
      const winner = x === 'rotated' ? a : b;
      const loser = x === 'rotated' ? b : a;
      expect(await links.access(winner[0]!.tokenHash, now + 2)).not.toBeNull();
      expect(await links.refresh(winner[1]!.tokenHash)).toMatchObject({ spent: false });
      // The loser's tokens were never stored.
      expect(await links.access(loser[0]!.tokenHash, now + 2)).toBeNull();
      expect(await links.refresh(loser[1]!.tokenHash)).toBeNull();
      expect(await links.refresh(refresh.tokenHash)).toMatchObject({
        spent: true,
        grant: { id: g.id },
      });
      expect(await links.rotate(refresh.tokenHash, next(now + 3), now + 3)).toBe('reused');
    });

    it('does not rotate an expired, unknown or revoked-link refresh token', async () => {
      const links = await make();
      const { g, refresh } = await linked(links, 'f@link.test');
      const next = (at: number) => [
        token(g, 'access', 900_000, at),
        token(g, 'refresh', 900_000, at),
      ];
      expect(await links.rotate(hash(), next(now), now)).toBe('unknown');
      expect(
        await links.rotate(refresh.tokenHash, next(refresh.expiresAt), refresh.expiresAt),
      ).toBe('unknown');
      await links.revokeGrant(g.id, now + 1);
      expect(await links.rotate(refresh.tokenHash, next(now + 2), now + 2)).toBe('unknown');
    });

    it('names the link a token of either kind belongs to', async () => {
      const links = await make();
      const { g, access, refresh } = await linked(links, 'g@link.test');
      expect(await links.grantOfToken(access.tokenHash)).toMatchObject({ id: g.id });
      expect(await links.grantOfToken(refresh.tokenHash)).toMatchObject({ id: g.id });
      expect(await links.grantOfToken(hash())).toBeNull();
    });

    it('lists a shopper’s own live links, newest first, and lets them end only those', async () => {
      const links = await make();
      const mine = await linked(links, 'h@link.test', 'plat_a', now);
      const mine2 = await linked(links, 'h@link.test', 'plat_b', now + 5);
      const theirs = await linked(links, 'i@link.test', 'plat_a', now);
      expect((await links.forShopper('h@link.test', now + 6)).map((l) => l.id)).toEqual([
        mine2.g.id,
        mine.g.id,
      ]);
      expect(await links.revokeForShopper('h@link.test', theirs.g.id, now + 6)).toBe(false);
      expect(await links.access(theirs.access.tokenHash, now + 7)).not.toBeNull();
      expect(await links.revokeForShopper('h@link.test', mine.g.id, now + 6)).toBe(true);
      expect(await links.access(mine.access.tokenHash, now + 7)).toBeNull();
      expect((await links.forShopper('h@link.test', now + 7)).map((l) => l.id)).toEqual([
        mine2.g.id,
      ]);
    });

    it('exports an address’s links without a code or a token, and erases them with both', async () => {
      const links = await make();
      const a = await linked(links, 'j@link.test');
      const c = code('j@link.test');
      await links.issueCode(c);
      const out = await links.exportFor('j@link.test');
      expect(out).toHaveLength(1);
      expect(JSON.stringify(out)).not.toContain(a.access.tokenHash);
      expect(JSON.stringify(out)).not.toContain(c.codeHash);
      const other = await linked(links, 'k@link.test');
      expect(await links.eraseFor('j@link.test')).toBe(1);
      expect(await links.exportFor('j@link.test')).toEqual([]);
      expect(await links.access(a.access.tokenHash, now + 1)).toBeNull();
      expect(await links.refresh(a.refresh.tokenHash)).toBeNull();
      expect(await links.spendCode(c.codeHash, now + 1)).toBeNull();
      expect(await links.access(other.access.tokenHash, now + 1)).not.toBeNull();
    });

    it('prunes expired codes and links that ended before the cut, with their tokens', async () => {
      const links = await make();
      const old = await linked(links, 'l@link.test', 'plat_a', now);
      const revoked = await linked(links, 'l@link.test', 'plat_b', now);
      await links.revokeGrant(revoked.g.id, now + 10);
      const live = await linked(links, 'l@link.test', 'plat_c', now);
      const c = code('l@link.test');
      await links.issueCode(c);
      const swept = await links.prune({
        codes: now + 61_000,
        grants: now + 1_000_001,
        tokens: 0,
        spent: 0,
      });
      // Everything made at `now` has expired by the cut except what the cut spares: nothing here, so all three.
      expect(swept.grants).toBeGreaterThanOrEqual(3);
      expect(swept.codes).toBeGreaterThanOrEqual(1);
      for (const x of [old, revoked, live]) {
        expect(await links.grant(x.g.id)).toBeNull();
        expect(await links.refresh(x.refresh.tokenHash)).toBeNull();
      }
    });

    it('keeps a revoked link and its tokens until it is older than the cut', async () => {
      const links = await make();
      const a = await linked(links, 'm@link.test');
      await links.revokeGrant(a.g.id, now + 100);
      await links.prune({ codes: 0, grants: now + 100, tokens: 0, spent: 0 });
      expect(await links.grant(a.g.id)).toMatchObject({ revokedAt: now + 100 });
      await links.prune({ codes: 0, grants: now + 101, tokens: 0, spent: 0 });
      expect(await links.grant(a.g.id)).toBeNull();
    });

    it('leaves no live link when a replay lands between spending a code and creating its link', async () => {
      const links = await make();
      const c = code('n@link.test');
      await links.issueCode(c);
      expect((await links.spendCode(c.codeHash, now + 1))?.kind).toBe('spent');
      // The replay finds nothing to end yet, but marks the code.
      expect(await links.spendCode(c.codeHash, now + 2)).toEqual({
        kind: 'replayed',
        grantId: c.grantId,
      });
      const g = { ...grant('n@link.test'), id: c.grantId };
      const access = token(g, 'access', 900_000);
      const refresh = token(g, 'refresh', 900_000);
      expect(await links.createGrant(g, [access, refresh], now + 3, c.codeHash)).toBe(false);
      expect(await links.grant(g.id)).toBeNull();
      expect(await links.access(access.tokenHash, now + 4)).toBeNull();
      expect(await links.refresh(refresh.tokenHash)).toBeNull();
      expect(await links.forShopper('n@link.test', now + 4)).toEqual([]);
    });

    it('does not end the shopper’s earlier link when the replayed code’s link is refused', async () => {
      const links = await make();
      const earlier = await linked(links, 'o@link.test');
      const c = code('o@link.test');
      await links.issueCode(c);
      await links.spendCode(c.codeHash, now + 1);
      await links.spendCode(c.codeHash, now + 2);
      const g = { ...grant('o@link.test'), id: c.grantId };
      expect(await links.createGrant(g, [token(g, 'access', 9)], now + 3, c.codeHash)).toBe(false);
      expect(await links.access(earlier.access.tokenHash, now + 4)).not.toBeNull();
    });

    it('creates the link when its code has not been replayed', async () => {
      const links = await make();
      const c = code('p@link.test');
      await links.issueCode(c);
      await links.spendCode(c.codeHash, now + 1);
      const g = { ...grant('p@link.test'), id: c.grantId };
      const access = token(g, 'access', 900_000);
      expect(await links.createGrant(g, [access], now + 2, c.codeHash)).toBe(true);
      expect(await links.access(access.tokenHash, now + 3)).not.toBeNull();
    });

    it('prunes expired access tokens and spent refresh tokens but the link’s latest spent one', async () => {
      const links = await make();
      const { g, access, refresh } = await linked(links, 'q@link.test');
      // Three rotations: the first two refresh tokens are spent and old, the third is the latest spent.
      let spent = refresh;
      const issued: LinkToken[] = [access];
      for (let i = 1; i <= 3; i++) {
        const next = [token(g, 'access', 900_000, now + i), token(g, 'refresh', 900_000, now + i)];
        expect(await links.rotate(spent.tokenHash, next, now + i)).toBe('rotated');
        issued.push(...next);
        spent = next[1]!;
      }
      const spentOnes = [refresh, issued[2]!, issued[4]!];
      const live = issued[6]!; // the newest refresh token, unspent
      const swept = await links.prune({
        codes: 0,
        grants: 0,
        tokens: now + 5_000_000,
        spent: now + 10,
      });
      // Every access token had expired; two of the three spent refresh tokens went.
      expect(swept.tokens).toBe(4 + 2);
      expect(await links.refresh(spentOnes[0]!.tokenHash)).toBeNull();
      expect(await links.refresh(spentOnes[1]!.tokenHash)).toBeNull();
      expect(await links.refresh(spentOnes[2]!.tokenHash)).toMatchObject({ spent: true });
      expect(await links.refresh(live.tokenHash)).toMatchObject({ spent: false });
      expect(await links.grant(g.id)).not.toBeNull();
      // The latest spent one still tells a copy of it from an unknown token.
      expect(await links.rotate(spentOnes[2]!.tokenHash, [token(g, 'refresh', 9)], now + 20)).toBe(
        'reused',
      );
    });
  });
}
