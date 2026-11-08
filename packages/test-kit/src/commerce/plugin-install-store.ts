/**
 * The plugin installs port in memory. Its guards stand in for the D1 store's indexes: one active or
 * disabled row per id, one row per id and version. The contract in
 * ./plugin-install-store-contract.ts holds it to the same behaviour.
 */
import type {
  PluginInstallRecord,
  PluginInstallStatus,
  PluginInstallStore,
} from '@commerceworker/ports/commerce';

export class InMemoryPluginInstallStore implements PluginInstallStore {
  private rows: PluginInstallRecord[] = [];
  private readonly secrets = new Map<string, string>();
  readonly errorLog = new Map<string, { message: string; at: number }[]>();

  private set(id: string, sha: string, change: Partial<PluginInstallRecord>) {
    this.rows = this.rows.map((r) => (r.id === id && r.sha === sha ? { ...r, ...change } : r));
  }

  async versions(id: string) {
    return this.rows.filter((r) => r.id === id);
  }

  async all() {
    return [...this.rows];
  }

  async active() {
    return this.rows
      .filter((r) => r.status === 'active')
      .map((r) => ({
        id: r.id,
        sha: r.sha,
        personalData: r.personalDataGranted === 1,
        publisher: r.publisher,
      }));
  }

  async activeSha(id: string) {
    return this.rows.find((r) => r.id === id && r.status === 'active')?.sha;
  }

  async upload(row: PluginInstallRecord) {
    const same = this.rows.find((r) => r.id === row.id && r.sha === row.sha);
    if (same) {
      if (same.status === 'uninstalled')
        this.set(row.id, row.sha, {
          publisher: row.publisher,
          status: 'pending',
          personalDataGranted: 0,
          uploadedBy: row.uploadedBy,
          uploadedAt: row.uploadedAt,
          approvedBy: null,
          approvedAt: null,
          request: row.request,
          cases: row.cases,
        });
      return 'ok' as const;
    }
    if (this.rows.some((r) => r.id === row.id && r.version === row.version))
      return 'conflict' as const;
    this.rows.push({ ...row });
    return 'ok' as const;
  }

  async activate(
    v: { id: string; sha: string },
    from: PluginInstallStatus,
    set: { approvedBy?: string; approvedAt?: number; personalDataGranted?: number },
  ) {
    const row = this.rows.find((r) => r.id === v.id && r.sha === v.sha);
    if (row?.status !== from) return false;
    for (const r of this.rows)
      if (r.id === v.id && r.sha !== v.sha && (r.status === 'active' || r.status === 'disabled'))
        this.set(r.id, r.sha, { status: 'superseded' });
    this.set(v.id, v.sha, { ...set, status: 'active' });
    return true;
  }

  async setStatus(id: string, sha: string, from: string, to: PluginInstallStatus) {
    const row = this.rows.find((r) => r.id === id && r.sha === sha);
    if (row?.status !== from) return false;
    this.set(id, sha, { status: to });
    return true;
  }

  async setCases(id: string, sha: string, prev: string | null, next: string) {
    const row = this.rows.find((r) => r.id === id && r.sha === sha);
    if (!row || row.cases !== prev) return false;
    this.set(id, sha, { cases: next });
    return true;
  }

  async uninstall(id: string) {
    this.rows = this.rows.map((r) => (r.id === id ? { ...r, status: 'uninstalled' } : r));
    for (const k of [...this.secrets.keys()]) if (k.startsWith(`${id}/`)) this.secrets.delete(k);
  }

  async secret(id: string, name: string) {
    return this.secrets.get(`${id}/${name}`);
  }

  async setSecret(id: string, name: string, sealed: string) {
    this.secrets.set(`${id}/${name}`, sealed);
  }

  async errors(id: string, limit: number) {
    return (this.errorLog.get(id) ?? [])
      .slice(0, limit)
      .map((e, i) => ({ id: `${id}:${e.at}:${i}`, message: e.message, at: e.at }));
  }
  async recordErrors(id: string, errors: readonly { message: string; at: number }[], keep: number) {
    if (!errors.length) return;
    const all = [...(this.errorLog.get(id) ?? []), ...errors].sort((a, b) => b.at - a.at);
    this.errorLog.set(id, all.slice(0, keep));
  }
}
