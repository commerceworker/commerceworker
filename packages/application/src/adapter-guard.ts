/** Ports that composition roots may silently satisfy with dev fakes. */
export type FakeAdapterKey = 'ai' | 'decisions' | 'blob' | 'embeddings' | 'vectors';

/** A dev fake bound where a persistent deployment expected a real adapter. */
export interface FakeAdapterBinding {
  /** Key accepted by ALLOW_FAKE_ADAPTERS (comma-separated list). */
  readonly key: FakeAdapterKey;
  /** What was bound and which env selects the real adapter instead. */
  readonly detail: string;
}

/**
 * Fail fast when a persistent deployment (real database) would boot with dev
 * fakes silently bound — a stub AIProvider, an in-memory blob store, hash-based
 * embeddings, or an in-memory vector store. In-memory-store deployments
 * (dev/demo) are exempt: fakes are the point there.
 *
 * Escape hatch: `ALLOW_FAKE_ADAPTERS` names the fakes a deployment accepts
 * deliberately — a comma-separated list of keys (`ai,blob`), or `all` for
 * everything. Granular on purpose: a deployment that doesn't use RAG can
 * allow `embeddings` without also disarming the blob/AI checks.
 */
export function assertNoFakeAdapters(input: {
  readonly persistent: boolean;
  readonly allowFakeAdapters?: string;
  readonly fakes: readonly FakeAdapterBinding[];
}): void {
  if (!input.persistent || input.fakes.length === 0) return;
  const allowed = new Set(
    (input.allowFakeAdapters ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  if (allowed.has('all')) return;
  const blocked = input.fakes.filter((f) => !allowed.has(f.key));
  if (blocked.length === 0) return;
  const keys = blocked.map((f) => f.key).join(',');
  const lines = blocked.map((f) => `  - ${f.key}: ${f.detail}`).join('\n');
  throw new Error(
    `Refusing to start: the store is persistent but dev fakes are bound:\n${lines}\nConfigure the real adapters, or set ALLOW_FAKE_ADAPTERS=${keys} to accept them deliberately.`,
  );
}
