import type { TeamPerson, WorkspaceStore } from './commerce/workspace';

/** Studio's deployment team, never content space memberships or commerce API tokens. */
export interface AdminTeam extends Pick<WorkspaceStore, 'hasOtherAdmin' | 'setRole' | 'admins'> {
  people(): Promise<TeamPerson[]>;
  /** Disabling is guarded in the write, like demotion: another active admin must remain. */
  setDisabled(id: string, at: number | null): Promise<boolean>;
}
