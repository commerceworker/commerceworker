/**
 * The passkeys port in memory, seeded with people. The contract in ./passkey-store-contract.ts
 * holds it to the same behaviour as the D1 store.
 */
import type { Passkey, PasskeyStore } from '@commerceworker/ports/commerce';

export interface PasskeyFixture {
  users?: { id: string; email: string; name: string; role: string; disabledAt?: number | null }[];
}

export class InMemoryPasskeyStore implements PasskeyStore {
  private readonly keys = new Map<string, Passkey>();
  private readonly challenges = new Map<
    string,
    { challenge: string; userId: string | null; expiresAt: number }
  >();

  constructor(private readonly fixture: PasskeyFixture = {}) {}

  async forUser(userId: string) {
    return [...this.keys.values()]
      .filter((k) => k.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async withUser(id: string) {
    const passkey = this.keys.get(id);
    const u = passkey && this.fixture.users?.find((x) => x.id === passkey.userId);
    return passkey && u ? { passkey, user: { ...u, disabledAt: u.disabledAt ?? null } } : undefined;
  }
  async add(p: Passkey) {
    if (this.keys.has(p.id)) return;
    this.keys.set(p.id, structuredClone(p));
  }
  async used(id: string, counter: number, at: number) {
    const k = this.keys.get(id);
    if (k) this.keys.set(id, { ...k, counter, lastUsedAt: at });
  }
  async remove(id: string, userId: string) {
    const k = this.keys.get(id);
    if (!k || k.userId !== userId) return undefined;
    this.keys.delete(id);
    return k.name;
  }
  async clear(userId: string) {
    let n = 0;
    for (const [id, k] of this.keys)
      if (k.userId === userId) {
        this.keys.delete(id);
        n++;
      }
    return n;
  }
  async putChallenge(
    c: { id: string; challenge: string; userId: string | null; expiresAt: number },
    now: number,
  ) {
    this.challenges.set(c.id, { challenge: c.challenge, userId: c.userId, expiresAt: c.expiresAt });
    for (const [id, x] of this.challenges) if (x.expiresAt < now) this.challenges.delete(id);
  }
  async takeChallenge(id: string, now: number) {
    const c = this.challenges.get(id);
    this.challenges.delete(id);
    return c && c.expiresAt > now ? { challenge: c.challenge, userId: c.userId } : undefined;
  }
}
