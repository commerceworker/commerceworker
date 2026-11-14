/** Plain audit records keep content-only consumers independent of the commerce core. */
export interface AdminAuditRow {
  id: string;
  at: number;
  action: string;
  actor: string | null;
  actorId: string | null;
  actorKind: string | null;
  target: string | null;
  detail: string | null;
  ip: string | null;
}
export interface AdminAuditHead {
  seq: number;
  hash: string;
}
export type AdminAuditEvent = AdminAuditRow & {
  seq: number | null;
  prevHash: string | null;
  hash: string | null;
};
export type AdminSealedAuditRow = AdminAuditRow & { seq: number; prevHash: string; hash: string };

/** Studio's audit chain, including historical unsealed rows and time/id page cursors. */
export interface AdminAuditLog {
  append(
    seal: (head: AdminAuditHead | null) => Promise<AdminSealedAuditRow>,
  ): Promise<AdminSealedAuditRow>;
  link(seq: number): Promise<AdminAuditHead | undefined>;
  list(filter: {
    group?: string;
    before?: number;
    beforeId?: string;
    after?: number;
    limit: number;
  }): Promise<AdminAuditEvent[]>;
  /** Sequence-bearing rows retain nullable hashes so verification can detect malformed rows. */
  sealedAfter(after: number | undefined, limit: number): Promise<AdminAuditEvent[]>;
}
