/**
 * The workspace port in memory, seeded with members and tokens. The contract in
 * ./workspace-store-contract.ts holds it to the same behaviour as the D1 store.
 */
import type { Member, NewToken, TeamPerson, WorkspaceStore } from '@commerceworker/ports/commerce';

/** A member, with what the Team page shows about them when a test names it. */
type FixtureMember = Member &
  Partial<Pick<TeamPerson, 'createdAt' | 'lastLoginAt' | 'twoFactorAt' | 'passwordChangeDue'>>;

type Token = Pick<NewToken, 'id' | 'role' | 'createdById' | 'createdBy'> &
  Partial<Omit<NewToken, 'id' | 'role' | 'createdById' | 'createdBy'>> & {
    revokedAt?: number | null;
    lastUsedAt?: number | null;
  };

export interface WorkspaceFixture {
  members?: FixtureMember[];
  tokens?: Token[];
  settings?: Record<string, string>;
}

export class InMemoryWorkspaceStore implements WorkspaceStore {
  private readonly members: FixtureMember[];
  readonly tokens: NonNullable<WorkspaceFixture['tokens']>;
  private readonly settings: Map<string, { value: string; by: string; at: number }>;

  constructor(fixture: WorkspaceFixture = {}) {
    const f = structuredClone(fixture);
    this.members = f.members ?? [];
    this.tokens = (f.tokens ?? []).map((t) => ({ ...t, revokedAt: t.revokedAt ?? null }));
    this.settings = new Map(
      Object.entries(f.settings ?? {}).map(([k, value]) => [k, { value, by: 'seed', at: 0 }]),
    );
  }

  async team() {
    const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return {
      people: [...this.members]
        .sort((a, b) => byText(a.email, b.email))
        .map((m) => ({
          id: m.id,
          email: m.email,
          name: m.name,
          role: m.role,
          disabledAt: m.disabledAt,
          createdAt: m.createdAt ?? 0,
          lastLoginAt: m.lastLoginAt ?? null,
          twoFactorAt: m.twoFactorAt ?? null,
          passwordChangeDue: m.passwordChangeDue ?? false,
        })),
      tokens: [...this.tokens]
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        .map((t) => ({
          id: t.id,
          name: t.name ?? t.id,
          prefix: t.prefix ?? t.id,
          role: t.role,
          createdBy: t.createdBy,
          createdAt: t.createdAt ?? 0,
          lastUsedAt: t.lastUsedAt ?? null,
          revokedAt: t.revokedAt ?? null,
          expiresAt: t.expiresAt ?? null,
        })),
    };
  }

  async setDisabled(id: string, at: number | null) {
    const m = this.members.find((x) => x.id === id);
    if (m) Object.assign(m, { disabledAt: at });
  }

  async addToken(t: NewToken) {
    if (this.tokens.some((x) => x.id === t.id)) throw new Error('UNIQUE constraint failed');
    this.tokens.push({ ...t, revokedAt: null, lastUsedAt: null });
  }

  async revokeToken(id: string, at: number) {
    const t = this.tokens.find((x) => x.id === id);
    if (!t || t.revokedAt) return undefined;
    t.revokedAt = at;
    return { name: t.name ?? t.id, prefix: t.prefix ?? t.id };
  }

  async member(id: string) {
    const m = this.members.find((x) => x.id === id);
    return m && { id: m.id, email: m.email, name: m.name, role: m.role, disabledAt: m.disabledAt };
  }

  async hasOtherAdmin(exceptId: string) {
    return this.members.some(
      (m) => m.role === 'admin' && m.disabledAt === null && m.id !== exceptId,
    );
  }

  async setRole(id: string, role: string) {
    const m = this.members.find((x) => x.id === id);
    if (!m || (role !== 'admin' && !(await this.hasOtherAdmin(id)))) return false;
    Object.assign(m, { role });
    return true;
  }

  async revokeTokens(member: Pick<Member, 'id' | 'email'>, roles: readonly string[] | null) {
    let n = 0;
    for (const t of this.tokens)
      if (
        (t.createdById === member.id || (t.createdById === null && t.createdBy === member.email)) &&
        !t.revokedAt &&
        (!roles || roles.includes(t.role))
      ) {
        t.revokedAt = Date.now();
        n++;
      }
    return n;
  }

  async admins(limit: number) {
    return this.members
      .filter((m) => m.role === 'admin' && m.disabledAt === null)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, limit)
      .map(({ name, email }) => ({ name, email }));
  }

  async names(ids: readonly string[]) {
    return this.members.filter((m) => ids.includes(m.id)).map(({ id, name }) => ({ id, name }));
  }

  async setting(key: string) {
    return this.settings.get(key)?.value;
  }

  async claimSetting(key: string, value: string, by: string) {
    if (this.settings.get(key)?.value === value) return false;
    this.settings.set(key, { value, by, at: Date.now() });
    return true;
  }

  async restoreSetting(key: string, before: string | undefined) {
    if (before === undefined) this.settings.delete(key);
    else
      this.settings.set(key, {
        value: before,
        by: this.settings.get(key)?.by ?? 'restored',
        at: Date.now(),
      });
  }

  async settingRecord(key: string) {
    const s = this.settings.get(key);
    return s && { value: s.value, updatedAt: s.at, updatedBy: s.by };
  }

  async clearSetting(key: string) {
    this.settings.delete(key);
  }

  async setSetting(key: string, value: string, by: string) {
    this.settings.set(key, { value, by, at: Date.now() });
  }
}
