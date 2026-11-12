/**
 * The UCP port in memory, seeded with platforms. The contract in ./ucp-store-contract.ts holds it
 * to the same behaviour as the D1 store.
 */
import type { UcpPlatform, UcpStore } from '@commerceworker/ports/commerce';

type Key = {
  requestHash: string;
  status: number | null;
  response: string | null;
  createdAt: number;
};
type Platform = UcpPlatform & {
  keyHash: string;
  profile: string | null;
  profileFetchedAt: number | null;
};

export interface UcpFixture {
  /** What a test leaves out is as the D1 runner seeds it: named after its id, made at 0. */
  platforms?: ({ id: string } & Partial<Platform>)[];
}

/** A platform as the admin API shows it: never its key. */
const view = (p: Platform): UcpPlatform => ({
  id: p.id,
  name: p.name,
  profileUrl: p.profileUrl,
  keyPrefix: p.keyPrefix,
  redirectUris: p.redirectUris,
  createdAt: p.createdAt,
  createdBy: p.createdBy,
  lastUsedAt: p.lastUsedAt,
  revokedAt: p.revokedAt,
});

export class InMemoryUcpStore implements UcpStore {
  private readonly keys = new Map<string, Key>();
  private readonly byId = new Map<string, Platform>();

  constructor(fixture: UcpFixture = {}) {
    for (const p of fixture.platforms ?? [])
      this.byId.set(p.id, {
        name: p.id,
        profileUrl: `https://${p.id}.example/.well-known/ucp`,
        keyPrefix: p.id,
        redirectUris: [],
        keyHash: p.id,
        createdAt: 0,
        createdBy: null,
        lastUsedAt: null,
        profile: null,
        profileFetchedAt: null,
        revokedAt: null,
        ...p,
      });
  }

  async platforms(limit: number) {
    return [...this.byId.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(view);
  }

  async addPlatform(p: Omit<UcpPlatform, 'lastUsedAt' | 'revokedAt'> & { keyHash: string }) {
    if (this.byId.has(p.id) || [...this.byId.values()].some((x) => x.keyHash === p.keyHash))
      throw new Error('UNIQUE constraint failed: ucp_platforms');
    this.byId.set(p.id, {
      ...p,
      lastUsedAt: null,
      revokedAt: null,
      profile: null,
      profileFetchedAt: null,
    });
  }

  async revokePlatform(id: string, at: number) {
    const p = this.byId.get(id);
    if (!p || p.revokedAt) return undefined;
    const revoked = { ...p, revokedAt: at };
    this.byId.set(id, revoked);
    return view(revoked);
  }

  async livePlatform(keyHash: string) {
    const p = [...this.byId.values()].find((x) => x.keyHash === keyHash && !x.revokedAt);
    return p && view(p);
  }

  async livePlatformById(id: string) {
    const p = this.byId.get(id);
    return p && !p.revokedAt ? view(p) : undefined;
  }

  async touchPlatform(id: string, at: number) {
    const p = this.byId.get(id);
    if (p) this.byId.set(id, { ...p, lastUsedAt: at });
  }

  async claimKey(
    ownerId: string,
    key: string,
    requestHash: string,
    now: number,
    staleBefore: number,
  ) {
    const k = `${ownerId}|${key}`;
    const held = this.keys.get(k);
    if (held && held.createdAt >= staleBefore) return false;
    this.keys.set(k, { requestHash, status: null, response: null, createdAt: now });
    return true;
  }

  async heldKey(ownerId: string, key: string) {
    const held = this.keys.get(`${ownerId}|${key}`);
    return held
      ? { requestHash: held.requestHash, status: held.status, response: held.response }
      : undefined;
  }

  async settleKey(ownerId: string, key: string, status: number, response: string) {
    const held = this.keys.get(`${ownerId}|${key}`);
    if (held) Object.assign(held, { status, response });
  }

  async releaseKey(ownerId: string, key: string) {
    this.keys.delete(`${ownerId}|${key}`);
  }

  async platform(id: string) {
    const p = this.byId.get(id);
    return p
      ? { profile: p.profile, profileFetchedAt: p.profileFetchedAt, revokedAt: p.revokedAt }
      : undefined;
  }

  async cacheProfile(id: string, profile: string, at: number) {
    const p = this.byId.get(id);
    if (p) Object.assign(p, { profile, profileFetchedAt: at });
  }
}
