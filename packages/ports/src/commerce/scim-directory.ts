/** Commerce provisioning uses its own role vocabulary and database. */
import type { Role } from '@commerceworker/core';
import type { ScimDirectoryRecords, ScimPerson } from '../scim-directory';

export type { ScimFilter, ScimGroupRow, ScimPerson } from '../scim-directory';

export interface ScimDirectory extends ScimDirectoryRecords {
  /** Adds a viewer with no password. */
  addPerson(person: ScimPerson): Promise<void>;
  /** Email changes also attach legacy API tokens to their maker in the same batch. */
  updatePerson(
    id: string,
    set: { email?: string; name?: string; scimExternalId?: string | null },
  ): Promise<void>;
  /** Their role; viewer for someone not on the team. */
  role(id: string): Promise<Role>;
  setRole(id: string, role: Role): Promise<void>;
  setDisabled(id: string, at: number | null): Promise<void>;
}
