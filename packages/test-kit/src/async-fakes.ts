import type { DomainEvent, Webhook } from '@commerceworker/domain';
import type {
  AIProvider,
  Cache,
  DecisionAnswer,
  DecisionModel,
  DecisionRequest,
  DecisionResult,
  EventBus,
  GenerateRequest,
  GenerateResult,
  Queue,
  QueueMessage,
  Subscription,
  WebhookSender,
  WebhookSendResult,
} from '@commerceworker/ports';

/**
 * An in-memory queue. Jobs are buffered until `drain()` runs them through their
 * registered handlers, giving tests deterministic control over async dispatch.
 */
export class InMemoryQueue implements Queue {
  private readonly handlers = new Map<string, (payload: unknown) => Promise<void>>();
  private readonly jobs: { topic: string; payload: unknown }[] = [];

  async enqueue(topic: string, payload: unknown): Promise<void> {
    this.jobs.push({ topic, payload });
  }

  async enqueueMany(topic: string, messages: readonly QueueMessage[]): Promise<void> {
    for (const msg of messages) this.jobs.push({ topic, payload: msg.payload });
  }

  process(topic: string, handler: (payload: unknown) => Promise<void>): Subscription {
    this.handlers.set(topic, handler);
    return { close: async () => void this.handlers.delete(topic) };
  }

  /** Runs all buffered jobs through their handlers, FIFO. */
  async drain(): Promise<void> {
    while (this.jobs.length > 0) {
      const job = this.jobs.shift();
      if (!job) break;
      const handler = this.handlers.get(job.topic);
      if (handler) await handler(job.payload);
    }
  }

  get depth(): number {
    return this.jobs.length;
  }
}

/**
 * An in-memory EventBus with synchronous fan-out — for tests and single-process
 * dev. Matching: '*' = all, trailing '*' = prefix on the event type (the same
 * semantics as the Worker's LiveHubDO-backed bus).
 */
export class InMemoryEventBus implements EventBus {
  private handlers: { pattern: string; handler: (e: DomainEvent) => Promise<void> }[] = [];

  async publish(event: DomainEvent): Promise<void> {
    for (const h of this.handlers) {
      if (this.matches(h.pattern, event.type)) await h.handler(event);
    }
  }

  subscribe(pattern: string, handler: (event: DomainEvent) => Promise<void>): Subscription {
    const entry = { pattern, handler };
    this.handlers.push(entry);
    return {
      close: async () => {
        this.handlers = this.handlers.filter((h) => h !== entry);
      },
    };
  }

  private matches(pattern: string, type: string): boolean {
    if (!pattern || pattern === '*') return true;
    if (pattern.endsWith('*')) return type.startsWith(pattern.slice(0, -1));
    return pattern === type;
  }
}

/** An in-memory tag-aware cache (the same contract as the KV adapter). */
export class InMemoryCache implements Cache {
  private readonly store = new Map<string, string>();
  private readonly tags = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    opts?: { ttlSeconds?: number; tags?: readonly string[] },
  ): Promise<void> {
    this.store.set(key, value);
    for (const tag of opts?.tags ?? []) {
      const set = this.tags.get(tag) ?? new Set();
      set.add(key);
      this.tags.set(tag, set);
    }
  }

  async invalidateTag(tag: string): Promise<void> {
    for (const key of this.tags.get(tag) ?? []) this.store.delete(key);
    this.tags.delete(tag);
  }

  async invalidateTags(tags: readonly string[]): Promise<void> {
    for (const tag of new Set(tags)) await this.invalidateTag(tag);
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * A scripted AIProvider for tests. `respond` receives the request and returns
 * the object the model should "generate"; the stub serializes it as the text
 * and attaches it as `object` when an outputSchema was requested.
 */
export class StubAIProvider implements AIProvider {
  readonly requests: GenerateRequest[] = [];
  constructor(private readonly respond: (req: GenerateRequest) => unknown) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    const value = this.respond(req);
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return {
      text,
      object: req.outputSchema ? value : undefined,
      usage: { inputTokens: 10, outputTokens: 20 },
    };
  }
}

/** A webhook sender that records calls instead of making HTTP requests. */
export class RecordingWebhookSender implements WebhookSender {
  readonly sent: {
    webhook: Webhook;
    event: DomainEvent;
    timestamp: string;
    resendOf?: number;
  }[] = [];
  constructor(private readonly result: WebhookSendResult = { delivered: true, statusCode: 200 }) {}

  async send(
    webhook: Webhook,
    payload: DomainEvent,
    opts?: { readonly timestamp?: string; readonly resendOf?: number },
  ): Promise<WebhookSendResult> {
    this.sent.push({
      webhook,
      event: payload,
      timestamp: opts?.timestamp ?? payload.occurredAt,
      ...(opts?.resendOf !== undefined ? { resendOf: opts.resendOf } : {}),
    });
    return this.result;
  }
}

/**
 * A DecisionModel answering from `respond` (per question id), or, by default, the first option /
 * no / the lowest level. Records every request.
 */
export class StubDecisionModel implements DecisionModel {
  readonly requests: DecisionRequest[] = [];
  constructor(
    private readonly respond: (req: DecisionRequest) => Record<string, DecisionAnswer> = () => ({}),
  ) {}

  async decide(req: DecisionRequest): Promise<DecisionResult> {
    this.requests.push(req);
    const given = this.respond(req);
    const answers: Record<string, DecisionAnswer> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const answer = given[id];
      if (answer) answers[id] = answer;
      else if (q.type === 'noul') answers[id] = { type: 'noul', probability: 0 };
      else if (q.type === 'choice') {
        const first = Object.keys(q.options)[0] as string;
        answers[id] = {
          type: 'choice',
          choice: first,
          confidence: 1,
          probabilities: { [first]: 1 },
        };
      } else {
        answers[id] = {
          type: 'score',
          score: 0,
          probabilities: q.levels.map((_, i) => (i ? 0 : 1)),
        };
      }
    }
    return { answers, model: 'stub', usage: { inputTokens: 10 } };
  }
}
