import type { ScimDirectoryRecords, ScimPerson } from './scim-directory';

/** Deployment roles in the content admin, distinct from commerce workspace roles. */
export type AdminScimRole = 'member' | 'admin';

/** Provisioned users and groups; token settings and access revocation use separate ports. */
export interface AdminScimDirectory extends ScimDirectoryRecords {
  /** Adds a member with no password; content API credentials live with the API. */
  addPerson(person: ScimPerson): Promise<void>;
  /** Updates Studio's identity record; external token revocation is handled by the protocol. */
  updatePerson(
    id: string,
    set: { email?: string; name?: string; scimExternalId?: string | null },
  ): Promise<void>;
  role(id: string): Promise<AdminScimRole>;
  /** False when missing or when taking away the last active admin. */
  setRole(id: string, role: AdminScimRole): Promise<boolean>;
  setDisabled(id: string, at: number | null): Promise<boolean>;
}
