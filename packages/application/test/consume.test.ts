import type { DomainEvent } from '@commerceworker/domain';
import {
  FixedClock,
  InMemoryCache,
  InMemoryContentStore,
  InMemoryEventBus,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentRunner,
  type AppContext,
  cacheTag,
  consumeEvent,
  createContentType,
  createEntry,
  createSpace,
  createWebhook,
  publishEntry,
  SYSTEM_CALLER,
  semanticSearch,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

function publishedEvent(entryId: string): DomainEvent {
  return {
    id: 'evt-1',
    type: 'entry.published',
    scope,
    occurredAt: '2026-01-01T00:00:00.000Z',
    entryId,
    contentTypeApiId: 'article',
    version: 1,
    fields: { title: { 'en-US': 'V1' } },
  };
}

function recordingAgents() {
  const calls: { workflow: string; entryId: string }[] = [];
  const agents: AgentRunner = {
    async run(workflow, input) {
      calls.push({ workflow, entryId: input.entryId });
      return {
        status: 'completed',
        decisions: [`${workflow} ran`],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  return { agents, calls };
}

describe('consumeEvent', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;
  let cache: InMemoryCache;
  let sender: RecordingWebhookSender;
  let entryId: string;

  beforeEach(async () => {
    store = new InMemoryContentStore();
    cache = new InMemoryCache();
    sender = new RecordingWebhookSender();
    ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('c'), cache };
    await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'article',
      name: 'Article',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
      ],
    });
    const created = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'V1' } },
    });
    entryId = created.entry.id;
    await publishEntry(ctx, scope, entryId);
  });

  it('dispatches (webhooks + cache), fans out to the live bus, and runs publish agents', async () => {
    await createWebhook(ctx, scope, {
      url: 'https://hook.example/cw',
      topics: ['entry.published'],
      secret: 's3cr3t',
    });
    await cache.set(cacheTag(scope, entryId), 'cached', { tags: [cacheTag(scope, entryId)] });
    const bus = new InMemoryEventBus();
    const live: DomainEvent[] = [];
    bus.subscribe('*', async (ev) => {
      live.push(ev);
    });
    const { agents, calls } = recordingAgents();

    const runs = await consumeEvent(
      ctx,
      {
        sender,
        cache,
        bus,
        agents,
        agentConfig: { enrich: true, moderate: true, autoApply: false },
      },
      publishedEvent(entryId),
    );

    expect(sender.sent.map((s) => s.event.type)).toContain('entry.published');
    expect(live.map((e) => e.type)).toContain('entry.published');
    expect(calls.map((c) => c.workflow)).toEqual(['enrich', 'moderate']);
    expect(runs.map((r) => r.workflow)).toEqual(['enrich', 'moderate']);
    // The agent runs are recorded in the ledger.
    const ledger = await store.agentRuns.list(scope, {});
    expect(ledger.length).toBe(2);
  });

  it('skips agents for non-publish events and when agents are not configured', async () => {
    const { agents, calls } = recordingAgents();
    const unpublished: DomainEvent = {
      id: 'evt-2',
      type: 'entry.unpublished',
      scope,
      occurredAt: '2026-01-01T00:00:00.000Z',
      entryId,
    };
    const runsForUnpublish = await consumeEvent(
      ctx,
      { sender, agents, agentConfig: { enrich: true, moderate: false, autoApply: false } },
      unpublished,
    );
    const runsWithoutAgents = await consumeEvent(ctx, { sender }, publishedEvent(entryId));

    expect(runsForUnpublish).toEqual([]);
    expect(runsWithoutAgents).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('runs a reindex when it consumes a search.reindex_requested event', async () => {
    await publishEntry(ctx, scope, entryId);
    const rag = {
      embeddings: new LocalEmbeddingsProvider(256),
      vectors: new InMemoryVectorStore(),
    };
    // Nothing indexed yet in this harness.
    expect((await semanticSearch(rag, scope, 'V1', { topK: 5 })).length).toBe(0);

    const reindexEvent: DomainEvent = {
      id: 'evt-reindex',
      type: 'search.reindex_requested',
      scope,
      occurredAt: '2026-01-01T00:00:00.000Z',
    };
    await consumeEvent(ctx, { sender, rag }, reindexEvent);

    // The published entry is now embedded and searchable.
    expect((await semanticSearch(rag, scope, 'V1', { topK: 5 })).length).toBeGreaterThan(0);
  });

  it('reports live-bus failures via onLiveError without failing the consume', async () => {
    const failingBus = {
      publish: async () => {
        throw new Error('bus down');
      },
      subscribe: () => ({ close: async () => {} }),
    };
    const errors: unknown[] = [];
    const runs = await consumeEvent(
      ctx,
      { sender, bus: failingBus, onLiveError: (err) => errors.push(err) },
      publishedEvent(entryId),
    );
    expect(runs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('bus down');
  });
});
