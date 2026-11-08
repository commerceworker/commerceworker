/**
 * The flows port in memory. The contract in ./flow-store-contract.ts holds it to the same
 * behaviour as the D1 store.
 */
import type { FlowVersion } from '@commerceworker/core';
import type { Clock } from '@commerceworker/ports';
import type { FlowDraft, FlowRecord, FlowStore } from '@commerceworker/ports/commerce';

type Version = { version: number; publishedAt: number; json: string };

export class InMemoryFlowStore implements FlowStore {
  private readonly drafts = new Map<string, FlowRecord>();
  private readonly versions = new Map<string, Version[]>();

  constructor(private readonly clock: Clock = { now: () => new Date() }) {}

  private now() {
    return this.clock.now().getTime();
  }

  private versionOf(v: Version): FlowVersion {
    return {
      ...(JSON.parse(v.json) as FlowVersion),
      version: v.version,
      publishedAt: v.publishedAt,
    };
  }

  async flow(id: string) {
    const f = this.drafts.get(id);
    return f ? structuredClone(f) : undefined;
  }

  async list() {
    return [...this.drafts.values()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((f) => structuredClone(f));
  }

  async version(id: string, version?: number) {
    const all = this.versions.get(id) ?? [];
    const v = version === undefined ? all.at(-1) : all.find((x) => x.version === version);
    return v ? this.versionOf(v) : null;
  }

  async saveDraft(flow: FlowDraft) {
    const had = this.drafts.get(flow.id);
    this.drafts.set(flow.id, {
      ...structuredClone(flow),
      publishedVersion: had?.publishedVersion ?? null,
      archivedAt: had?.archivedAt ?? null,
      updatedAt: this.now(),
    });
  }

  async publish(
    flow: FlowDraft,
    opts: { unlessPublished?: boolean; publishedBy?: string | null } = {},
  ) {
    await this.saveDraft(flow);
    const json = JSON.stringify(flow);
    const all = this.versions.get(flow.id) ?? [];
    if (!(opts.unlessPublished && all.some((v) => v.json === json)))
      all.push({ version: (all.at(-1)?.version ?? 0) + 1, publishedAt: this.now(), json });
    this.versions.set(flow.id, all);
    const latest = all.at(-1)!.version;
    this.drafts.set(flow.id, { ...this.drafts.get(flow.id)!, publishedVersion: latest });
    return latest;
  }

  async seed(flows: readonly FlowDraft[]) {
    for (const f of flows) {
      const published = (this.versions.get(f.id) ?? []).some((v) => v.json === JSON.stringify(f));
      if (!published) await this.publish(f, { unlessPublished: true });
    }
  }

  async setArchived(id: string, archived: boolean) {
    const f = this.drafts.get(id);
    if (!f || f.publishedVersion !== null) return undefined;
    this.drafts.set(id, { ...f, archivedAt: archived ? this.now() : null });
    return { id, name: f.name };
  }

  async listWithPublished() {
    return (await this.list()).map((f) => {
      const v = (this.versions.get(f.id) ?? []).find((x) => x.version === f.publishedVersion);
      const live = v ? this.versionOf(v) : null;
      return {
        ...f,
        published: live
          ? {
              nodes: live.nodes as unknown[],
              edges: live.edges as unknown[],
              publishedAt: live.publishedAt,
            }
          : null,
      };
    });
  }

  async history(id: string) {
    return [...(this.versions.get(id) ?? [])]
      .sort((a, b) => b.version - a.version)
      .map(({ version, publishedAt }) => ({ version, publishedAt }));
  }

  async count() {
    return this.drafts.size;
  }

  async publishedVersions() {
    return [...this.drafts.values()]
      .filter((f) => f.publishedVersion !== null && f.archivedAt === null)
      .flatMap((f) => {
        const v = (this.versions.get(f.id) ?? []).find((x) => x.version === f.publishedVersion);
        return v ? [this.versionOf(v)] : [];
      });
  }
}
