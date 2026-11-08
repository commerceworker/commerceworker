/**
 * The SCIM directory port in memory. Its state is public so a protocol test can set the scene (a
 * person with a password, one linked to single sign-on) and read the outcome; the contract in
 * ./scim-directory-contract.ts holds it to the same behaviour as the D1 store.
 */
import type { Role } from '@commerceworker/core';
import type {
  ScimDirectory,
  ScimFilter,
  ScimGroupRow,
  ScimPerson,
} from '@commerceworker/ports/commerce';

export interface ScimDirectoryFixture {
  people?: (ScimPerson & { role?: Role; password?: boolean; linked?: boolean })[];
  groups?: ScimGroupRow[];
  members?: { groupId: string; userId: string }[];
}

/** SQLite's text order: by code unit. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class InMemoryScimDirectory implements ScimDirectory {
  readonly persons = new Map<string, ScimPerson & { role: Role }>();
  readonly groupRows = new Map<string, ScimGroupRow>();
  /** Each group's members, by group id. */
  readonly memberships = new Map<string, Set<string>>();
  /** People with a password, and people single sign-on is linked to. */
  readonly passwords = new Set<string>();
  readonly linked = new Set<string>();

  constructor(f: ScimDirectoryFixture = {}) {
    for (const { role, password, linked, ...p } of structuredClone(f.people ?? [])) {
      this.persons.set(p.id, { ...p, role: role ?? 'viewer' });
      if (password) this.passwords.add(p.id);
      if (linked) this.linked.add(p.id);
    }
    for (const g of structuredClone(f.groups ?? [])) {
      this.groupRows.set(g.id, g);
      this.memberships.set(g.id, new Set());
    }
    for (const m of f.members ?? []) this.memberships.get(m.groupId)?.add(m.userId);
  }

  private plain(p: ScimPerson & { role: Role }): ScimPerson {
    const { role: _r, ...rest } = p;
    return { ...rest };
  }

  private matching(f: ScimFilter | null) {
    return [...this.persons.values()]
      .filter(
        (p) =>
          !f ||
          (f.attr === 'userName' && p.email === f.value.toLowerCase()) ||
          (f.attr === 'externalId' && p.scimExternalId === f.value) ||
          (f.attr === 'id' && p.id === f.value) ||
          (f.attr === 'displayName' && p.name === f.value),
      )
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async people(f: ScimFilter | null, offset: number, limit: number) {
    const all = this.matching(f);
    return {
      total: all.length,
      rows: all.slice(offset, offset + limit).map((p) => this.plain(p)),
    };
  }
  async person(id: string) {
    const p = this.persons.get(id);
    return p && this.plain(p);
  }
  async personByEmail(email: string) {
    const p = [...this.persons.values()].find((x) => x.email === email);
    return p && this.plain(p);
  }
  async addPerson(p: ScimPerson) {
    if (this.persons.has(p.id) || [...this.persons.values()].some((x) => x.email === p.email))
      throw new Error('UNIQUE constraint failed: users.email');
    this.persons.set(p.id, { ...p, role: 'viewer' });
  }
  async updatePerson(
    id: string,
    set: { email?: string; name?: string; scimExternalId?: string | null },
  ) {
    const p = this.persons.get(id);
    if (p) this.persons.set(id, { ...p, ...set });
  }
  async signsInWith(id: string) {
    return { password: this.passwords.has(id), linked: this.linked.has(id) };
  }
  async role(id: string) {
    return this.persons.get(id)?.role ?? 'viewer';
  }
  async setRole(id: string, role: Role) {
    const p = this.persons.get(id);
    if (p) this.persons.set(id, { ...p, role });
  }
  async otherAdmins(exceptId: string) {
    return [...this.persons.values()].filter(
      (p) => p.role === 'admin' && p.disabledAt === null && p.id !== exceptId,
    ).length;
  }
  async setDisabled(id: string, at: number | null) {
    const p = this.persons.get(id);
    if (p) this.persons.set(id, { ...p, disabledAt: at });
  }

  async groups(f: ScimFilter | null, offset: number, limit: number) {
    const all = [...this.groupRows.values()]
      .filter(
        (g) =>
          !f ||
          (f.attr === 'externalId' && g.externalId === f.value) ||
          (f.attr === 'id' && g.id === f.value) ||
          ((f.attr === 'displayName' || f.attr === 'userName') && g.displayName === f.value),
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    return { total: all.length, rows: all.slice(offset, offset + limit).map((g) => ({ ...g })) };
  }
  async group(id: string) {
    const g = this.groupRows.get(id);
    return g && { ...g };
  }
  async addGroup(g: ScimGroupRow) {
    if (this.groupRows.has(g.id)) throw new Error('UNIQUE constraint failed: scim_groups.id');
    this.groupRows.set(g.id, { ...g });
    this.memberships.set(g.id, new Set());
  }
  async updateGroup(
    id: string,
    set: { displayName?: string; externalId?: string | null; updatedAt: number },
  ) {
    const g = this.groupRows.get(id);
    if (g) this.groupRows.set(id, { ...g, ...set });
  }
  async deleteGroup(id: string) {
    this.groupRows.delete(id);
    this.memberships.delete(id);
  }
  async members(groupId: string) {
    return [...(this.memberships.get(groupId) ?? [])];
  }
  async existing(ids: readonly string[]) {
    return ids.filter((id) => this.persons.has(id));
  }
  async addMembers(groupId: string, ids: readonly string[]) {
    const m = this.memberships.get(groupId);
    // A member must be a person, and the group must exist (D1's foreign keys).
    if (!m || ids.some((id) => !this.persons.has(id)))
      throw new Error('FOREIGN KEY constraint failed');
    for (const id of ids) m.add(id);
  }
  async removeMembers(groupId: string, ids: readonly string[]) {
    for (const id of ids) this.memberships.get(groupId)?.delete(id);
  }
  async leaveGroups(userId: string) {
    for (const m of this.memberships.values()) m.delete(userId);
  }
  async groupsOf(userId: string) {
    return [...this.memberships].filter(([, m]) => m.has(userId)).map(([g]) => g);
  }
  async groupSizes() {
    return [...this.groupRows.values()]
      .sort((a, b) => cmp(a.displayName, b.displayName))
      .map((g) => ({
        id: g.id,
        displayName: g.displayName,
        members: this.memberships.get(g.id)?.size ?? 0,
      }));
  }
}
