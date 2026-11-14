/** Binding-free records shared by the two deployment directories. */
export interface ScimPerson {
  readonly id: string;
  /** Their SCIM `userName`, lowercased. */
  readonly email: string;
  readonly name: string;
  readonly disabledAt: number | null;
  /** The identity provider's id for them. */
  readonly scimExternalId: string | null;
  readonly createdAt: number;
}

export interface ScimGroupRow {
  readonly id: string;
  readonly displayName: string;
  readonly externalId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** The one filter SCIM clients send: an attribute equal to a value (`userName` matched lowercased). */
export type ScimFilter = {
  readonly attr: 'userName' | 'externalId' | 'displayName' | 'id';
  readonly value: string;
};

export interface ScimDirectoryRecords {
  /** A page of people (oldest first) matching the filter, and how many match. */
  people(
    f: ScimFilter | null,
    offset: number,
    limit: number,
  ): Promise<{ total: number; rows: ScimPerson[] }>;
  person(id: string): Promise<ScimPerson | undefined>;
  personByEmail(email: string): Promise<ScimPerson | undefined>;
  /** Adds a person without a password, using the directory’s default role. */
  addPerson(p: ScimPerson): Promise<void>;
  /** Updates the provisioned identity record. */
  updatePerson(
    id: string,
    set: { email?: string; name?: string; scimExternalId?: string | null },
  ): Promise<void>;
  /** Whether the person has a password, and whether single sign-on is linked to them. */
  signsInWith(id: string): Promise<{ password: boolean; linked: boolean }>;
  /** How many active admins there are besides `exceptId`. */
  otherAdmins(exceptId: string): Promise<number>;

  /** A page of groups (oldest first) matching the filter, and how many match. */
  groups(
    f: ScimFilter | null,
    offset: number,
    limit: number,
  ): Promise<{ total: number; rows: ScimGroupRow[] }>;
  group(id: string): Promise<ScimGroupRow | undefined>;
  addGroup(g: ScimGroupRow): Promise<void>;
  updateGroup(
    id: string,
    set: { displayName?: string; externalId?: string | null; updatedAt: number },
  ): Promise<void>;
  /** Deletes a group and its memberships, together. */
  deleteGroup(id: string): Promise<void>;
  members(groupId: string): Promise<string[]>;
  /** Of these ids, the ones that are people, in the order given. */
  existing(ids: readonly string[]): Promise<string[]>;
  /** Adds members; one already in the group stays once. */
  addMembers(groupId: string, ids: readonly string[]): Promise<void>;
  removeMembers(groupId: string, ids: readonly string[]): Promise<void>;
  /** Removes a person from every group. */
  leaveGroups(userId: string): Promise<void>;
  groupsOf(userId: string): Promise<string[]>;
  /** Every group by name, with how many members it has, for the Team page. */
  groupSizes(): Promise<{ id: string; displayName: string; members: number }[]>;
}
