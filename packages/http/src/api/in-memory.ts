import type { AppContext, RagDeps } from '@commerceworker/application';
import { type ApiKeyKind, scopesForKind } from '@commerceworker/domain';
import type { ApiConfig } from '@commerceworker/platform/config';
import { newId as uuidv7 } from '@commerceworker/platform/ids';
import type {
  AIProvider,
  BlobStore,
  Clock,
  ContentStore,
  EventBus,
  GenerateRequest,
  IdGenerator,
} from '@commerceworker/ports';
import { pbkdf2PasswordHasher } from '@commerceworker/security/credentials';
import {
  FakeBlobStore,
  InMemoryContentStore,
  InMemoryCostGuard,
  InMemoryEventBus,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  StubAIProvider,
} from '@commerceworker/test-kit';
import { createApiHasher } from './auth';

const clock: Clock = { now: () => new Date() };
const ids: IdGenerator = { newId: () => uuidv7() };

export interface InMemoryWired {
  readonly ctx: AppContext;
  readonly rag: RagDeps;
  readonly blob: BlobStore;
  readonly ai: AIProvider;
  readonly bus: EventBus;
}

/** Placeholder generation from the requested JSON schema (same as the Worker's dev stub). */
function devGenerate(req: GenerateRequest): unknown {
  const props =
    (req.outputSchema as { properties?: Record<string, { type?: string; description?: string }> })
      ?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(props)) {
    if (def.type === 'integer' || def.type === 'number') out[key] = 0;
    else if (def.type === 'boolean') out[key] = false;
    else if (/ISO-8601|date/i.test(def.description ?? '')) out[key] = '2024-01-01';
    else out[key] = `Sample ${def.description ?? key}`;
  }
  return out;
}

/**
 * In-memory wiring of the HTTP API: a fresh seeded store (space + the dev API
 * keys) per call, so callers never share state. Used by the API tests and by
 * the public docs build (apps/docs/scripts/content-openapi.ts), which renders the
 * OpenAPI document from the routes `createApp` registers. It is the test-kit
 * equivalent of the Worker's demo mode (`wireEdge` with no D1 binding), minus
 * that path's module-scope memoization. Never used by the deployed Worker.
 */
export function wire(config: ApiConfig): InMemoryWired {
  const store = new InMemoryContentStore();
  store.seedSpace({
    spaceId: config.seed.spaceId,
    defaultLocale: config.seed.defaultLocale,
    locales: config.seed.locales,
  });
  const hasher = createApiHasher(config.tokenPepper);
  const tokens: Record<ApiKeyKind, string> = {
    cma: config.cmaKey,
    cda: config.cdaKey,
    cpa: config.cpaKey,
  };
  for (const [kind, token] of Object.entries(tokens) as [ApiKeyKind, string][]) {
    store.seedApiKey({
      id: ids.newId(),
      spaceId: config.seed.spaceId,
      kind,
      name: `dev-${kind}`,
      hashedToken: hasher.hash(token),
      scopes: scopesForKind(kind),
      revoked: false,
    });
  }
  const limits = config.aiBudget;
  const costGuard =
    limits && limits.maxRequests > 0 && limits.maxTokens > 0
      ? new InMemoryCostGuard(limits)
      : undefined;
  const embeddings = new LocalEmbeddingsProvider(1536);
  return {
    ctx: {
      store: store as ContentStore,
      clock,
      ids,
      costGuard,
      // Share-link passwords, hashed as the edge hashes them.
      passwords: pbkdf2PasswordHasher,
    },
    rag: { embeddings, vectors: new InMemoryVectorStore() },
    blob: new FakeBlobStore(),
    ai: new StubAIProvider(devGenerate),
    bus: new InMemoryEventBus(),
  };
}
