import type {
  AssetPlaceholder,
  AssetShareTargetType,
  AssetVideoStatus,
  DomainEvent,
  FieldIssue,
  FocalPoint,
  Scope,
  Webhook,
} from '@commerceworker/domain';

/**
 * Infrastructure ports for the async backbone and AI layer. They are defined
 * here so the seams exist from day one (per the architecture's "leave clean
 * seams" rule); adapters are implemented in later phases. The application layer
 * may depend on these interfaces without any concrete infra being present.
 */

/** One message in a batched enqueue. */
export interface QueueMessage {
  readonly payload: unknown;
  readonly delayMs?: number;
  readonly dedupeKey?: string;
}

/** Generic work queue (Cloudflare Queues in production; in-memory in tests). */
export interface Queue {
  enqueue(
    topic: string,
    payload: unknown,
    opts?: { delayMs?: number; dedupeKey?: string },
  ): Promise<void>;
  /**
   * Enqueues many messages in as few backend calls as the adapter allows
   * (Cloudflare `sendBatch`). Same at-least-once and dedupe
   * semantics as {@link enqueue}; callers must not assume atomicity across the
   * whole batch — a crash mid-call may leave a prefix enqueued.
   */
  enqueueMany(topic: string, messages: readonly QueueMessage[]): Promise<void>;
  process(topic: string, handler: (payload: unknown) => Promise<void>): Subscription;
}

/** Pub/sub fan-out of domain events. */
export interface EventBus {
  publish(event: DomainEvent): Promise<void>;
  subscribe(pattern: string, handler: (event: DomainEvent) => Promise<void>): Subscription;
}

export interface Subscription {
  close(): Promise<void>;
}

export interface DownloadUrlOptions {
  readonly expiresInSeconds?: number;
  readonly origin?: string;
}

/** Object storage for assets (R2). */
export interface BlobStore {
  getUploadUrl(
    key: string,
    contentType: string,
  ): Promise<{ url: string; headers: Record<string, string> }>;
  /**
   * A URL that reads `key`. Without options: the stored, non-expiring download URL. With
   * `expiresInSeconds`, one that stops working then (Management and Preview reads); `origin`
   * points it at another host that verifies the same signature (the media origin).
   */
  getDownloadUrl(key: string, opts?: DownloadUrlOptions): Promise<string>;
  delete(key: string): Promise<void>;
  /**
   * Server-side write, for content the server owns rather than proxies.
   *
   * Distinct from {@link getUploadUrl}, which delegates the transfer to a
   * client — right for a user uploading an image, wrong for something the
   * server must also read back and verify, where presigning a URL for
   * ourselves to then fetch is a round-trip through the network for no reason.
   */
  put(key: string, body: string | Uint8Array, contentType: string): Promise<void>;
  /** Server-side read. `null` when the object does not exist. */
  get(key: string): Promise<string | null>;
  /**
   * Deletes every object under `prefix` except those `keep` names, and returns how many went.
   * Optional: a store without it leaves the objects (a deleted environment's files stay).
   */
  deletePrefix?(prefix: string, keep: (key: string) => boolean): Promise<number>;
  /**
   * Streams `key`'s bytes, for work that reads a file once without holding it (hashing). `null`
   * when the object does not exist. Optional: a store without it can't feed asset ingest.
   */
  open?(key: string): Promise<BlobObject | null>;
  /**
   * What is stored under `key`, without its bytes: `null` when nothing is. Optional: a store
   * without it can't confirm an upload landed, so replacing an asset's file needs it and the
   * abandoned-upload sweep doesn't run without it.
   */
  head?(key: string): Promise<BlobHead | null>;
  /**
   * `length` bytes of `key` from `offset`, streamed: what a zip reads of each file, a part at a
   * time. `null` when the object does not exist. Optional, like {@link open}.
   */
  openRange?(key: string, offset: number, length: number): Promise<BlobObject | null>;
  /**
   * Multipart uploads, for files too large for one request. Optional: a store without them takes
   * single uploads only. Every part but the last must have the same length (R2's rule).
   */
  readonly multipart?: MultipartBlobStore;
}

/** One uploaded part, as completing a multipart upload names it. */
export interface UploadedPart {
  readonly partNumber: number;
  readonly etag: string;
}

/** Multipart uploads of one object key (R2's `createMultipartUpload` and its parts). */
export interface MultipartBlobStore {
  create(key: string, contentType: string): Promise<{ readonly uploadId: string }>;
  /**
   * A signed URL a client PUTs one part to: bound to the key, the upload, the part number and the
   * part's exact length, and short-lived like an upload URL.
   */
  partUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    length: number,
  ): Promise<{ readonly url: string; readonly expiresAt: string }>;
  /** Server-side: writes one part (a zip the engine builds). */
  uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array,
  ): Promise<UploadedPart>;
  /** Assembles the parts into the object; what is now stored there. */
  complete(key: string, uploadId: string, parts: readonly UploadedPart[]): Promise<BlobHead>;
  /** Discards the upload and its parts. An upload already gone is not an error. */
  abort(key: string, uploadId: string): Promise<void>;
}

/** An object's description, as {@link BlobStore.head} reads it. */
export interface BlobHead {
  readonly size: number;
  readonly contentType?: string;
  /** Names the bytes: a second write to the same key gets another. */
  readonly etag?: string;
}

/**
 * A stream of bytes, typed structurally so no platform type crosses the port: a web
 * `ReadableStream` is one (it is async-iterable on workerd and Node).
 */
export type ByteStream = AsyncIterable<Uint8Array>;

/** An object's bytes as a stream, with what the store recorded about it. */
export interface BlobObject {
  readonly body: ByteStream;
  readonly size: number;
  readonly contentType?: string;
}

/** What an image's bytes say about it, read without decoding it fully. */
export interface ImageInfo {
  readonly width: number;
  readonly height: number;
  /** A content type (`image/png`). */
  readonly format: string;
  readonly size?: number;
}

/**
 * Reads an image's dimensions and format from its bytes (the Cloudflare Images binding's `info`
 * on edge). `null` when the bytes are not an image it can read, or carry no dimensions (SVG).
 */
export interface ImageProbe {
  info(body: ByteStream): Promise<ImageInfo | null>;
  /**
   * The image's placeholder (ThumbHash and dominant colour), from a thumbnail of its pixels.
   * `null` when the bytes are not a raster image it can decode. Optional: a probe without it
   * leaves assets without placeholders.
   */
  placeholder?(body: ByteStream): Promise<AssetPlaceholder | null>;
}

/**
 * A file to read text out of: its bytes as the stream gave them (already capped by the caller),
 * never joined into one copy here, since the extractor builds what it sends from the chunks.
 */
export interface ExtractableFile {
  readonly fileName: string;
  readonly contentType: string;
  readonly chunks: readonly Uint8Array[];
  /** The chunks' total length. */
  readonly size: number;
}

/**
 * Turns a document (PDF, office formats) into Markdown, or speech in an audio file into text
 * (Workers AI `toMarkdown` and Whisper on edge). What comes back is the file's own text: untrusted,
 * stored and indexed as data, never followed as instructions.
 */
export interface TextExtractor {
  /** Whether it can read this content type at all. */
  supports(contentType: string): boolean;
  /** The text, or '' when the file holds none. */
  extract(file: ExtractableFile): Promise<string>;
}

/** How an image is fit into the requested box (provider-neutral names). */
export type ImageFit = 'clip' | 'crop' | 'fill' | 'max' | 'scale';

/**
 * Output encoding. `auto` asks the transformer to negotiate from the client's
 * `Accept` header (AVIF, then WebP, then the source format).
 */
export type ImageFormat = 'auto' | 'jpg' | 'png' | 'webp' | 'avif';

/** A requested image transformation. Validated by the application layer. */
export interface ImageTransformSpec {
  readonly width?: number;
  readonly height?: number;
  readonly fit?: ImageFit;
  readonly format?: ImageFormat;
  /** Output quality, 1..100 (lossy formats). */
  readonly quality?: number;
}

/**
 * Turns a stored image URL plus a transform into a URL that serves the
 * transformed image. A port so the application never learns which image
 * service (Cloudflare Images, an imgix-style CDN) does the work; the
 * focal point, when known, anchors crops (the service's "gravity").
 */
export interface ImageTransformer {
  transformUrl(
    sourceUrl: string,
    transform: ImageTransformSpec,
    focalPoint?: FocalPoint,
    /** A transform of a short-lived URL expires with it (Preview's drafts). */
    opts?: { readonly expiresInSeconds?: number },
  ): Promise<string>;
}

/** A one-time, direct-from-client upload target issued by a {@link VideoHost}. */
export interface VideoUpload {
  /** The host's id for the video the upload will create. */
  readonly videoId: string;
  /** The client POSTs the file here as multipart form field {@link fileField}. */
  readonly uploadUrl: string;
  readonly method: 'POST';
  readonly fileField: string;
}

/** What a video host currently reports about a video. */
export interface HostedVideo {
  readonly videoId: string;
  readonly status: AssetVideoStatus;
  readonly hlsUrl?: string;
  readonly dashUrl?: string;
  readonly thumbnailUrl?: string;
  readonly durationSeconds?: number;
  readonly width?: number;
  readonly height?: number;
  readonly errorReason?: string;
}

/**
 * Hosts video: encoding, adaptive playback, posters. Uploads go straight from
 * the client to the host (the bytes never transit the API), mirroring the
 * BlobStore's presigned-upload contract.
 */
export interface VideoHost {
  /** Provider name stamped onto assets, e.g. `stream`. */
  readonly provider: string;
  createUpload(opts: {
    readonly maxDurationSeconds: number;
    /** Opaque metadata echoed back on status webhooks (asset id, scope). */
    readonly meta?: Readonly<Record<string, string>>;
  }): Promise<VideoUpload>;
  /** `null` when the host has no such video. */
  getVideo(videoId: string): Promise<HostedVideo | null>;
  delete(videoId: string): Promise<void>;
}

/** Read-through cache for the Delivery API, with tag-based invalidation. */
export interface Cache {
  get(key: string): Promise<string | null>;
  /** Stores `value` under `key`, associated with the given invalidation tags. */
  set(
    key: string,
    value: string,
    opts?: { ttlSeconds?: number; tags?: readonly string[] },
  ): Promise<void>;
  /** Evicts every cached entry associated with `tag`. */
  invalidateTag(tag: string): Promise<void>;
  /**
   * Batch {@link invalidateTag}: adapters dedupe and use their cheapest bulk
   * form (e.g. parallel KV writes). Idempotent — safe to re-run on
   * a redelivered event.
   */
  invalidateTags(tags: readonly string[]): Promise<void>;
}

export interface WebhookSendResult {
  readonly delivered: boolean;
  readonly statusCode?: number;
  readonly error?: string;
}

/**
 * Fetches a remote document on an operator's behalf.
 *
 * Narrow on purpose: GET only, size-bounded, and never follows redirects — a
 * 3xx to an internal host is the classic way an SSRF guard on the *requested*
 * URL gets walked around. Callers screen the URL before handing it over; this
 * is the second line, not the first.
 */
export interface RemoteFetcher {
  get(
    url: string,
    options: { readonly maxBytes: number; readonly timeoutMs?: number },
  ): Promise<RemoteDocument>;
  /**
   * The same request for a binary body (an asset file an import copies), under the same rules:
   * no redirects, the size cap enforced on what arrives.
   */
  getBytes(
    url: string,
    options: { readonly maxBytes: number; readonly timeoutMs?: number },
  ): Promise<RemoteFile>;
}

export interface RemoteDocument {
  readonly status: number;
  readonly contentType?: string;
  /** Response body as text. Empty when the status is not 2xx. */
  readonly body: string;
}

export interface RemoteFile {
  readonly status: number;
  readonly contentType?: string;
  /** Response body. Empty when the status is not 2xx. */
  readonly bytes: Uint8Array;
}

/** One outbound email. */
export interface EmailMessage {
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  /**
   * Stable per logical send (a workflow node's effect key): an adapter that supports it passes it
   * on so a retried step never mails twice.
   */
  readonly idempotencyKey?: string;
}

export interface EmailSendResult {
  readonly delivered: boolean;
  readonly id?: string;
  readonly error?: string;
}

/**
 * Sends email (workflow notifications, approver digests). Cloudflare Email Sending implements it
 * on edge; test-kit records messages.
 */
export interface EmailSender {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/** Signs and POSTs a webhook payload. Implemented by the worker (HMAC + fetch). */
export interface WebhookSender {
  /**
   * `timestamp` is what the signature covers and the timestamp header carries: the event's
   * `occurredAt` unless given (a resend gives the time it is sent, so a receiver's freshness
   * window accepts it). `resendOf` names the logged delivery a resend repeats, sent as a header.
   */
  send(
    webhook: Webhook,
    payload: DomainEvent,
    opts?: WebhookSendOptions,
  ): Promise<WebhookSendResult>;
}

export interface WebhookSendOptions {
  readonly timestamp?: string;
  readonly resendOf?: number;
}

export interface FunctionInvokeResult {
  readonly ok: boolean;
  readonly statusCode?: number;
  readonly error?: string;
}

/** Invokes a user-defined function on an event (HTTP by default; sandbox swappable). */
export interface FunctionInvoker {
  invoke(url: string, event: DomainEvent): Promise<FunctionInvokeResult>;
}

// ---- AI layer seams -------------------------------------------------------

export type ModelTier = 'flagship' | 'balanced' | 'fast';

/** A tool call the model asked for (or, in history, made earlier). */
export interface ToolCall {
  /** Provider-assigned id; a `tool` message answers it by this id. */
  id: string;
  name: string;
  /** Parsed arguments (an object matching the tool's `inputSchema`). */
  input: unknown;
}

/** A tool the model may call. */
export interface ToolSpec {
  name: string;
  description?: string;
  /** JSON Schema of the tool's input object. */
  inputSchema: Record<string, unknown>;
}

/**
 * One turn of a multi-turn conversation. `system` stays on
 * {@link GenerateRequest.system}; tool results answer a prior assistant
 * tool call by its id.
 */
export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface GenerateRequest {
  system?: string;
  /**
   * The user turn. With {@link messages}, it is appended as the final user
   * turn when non-empty (pass `''` to send `messages` alone).
   */
  prompt: string;
  /** Earlier turns of a conversation, oldest first (tool calling, assistants). */
  messages?: ChatMessage[];
  /** Tools the model may call; any calls come back in {@link GenerateResult.toolCalls}. */
  tools?: ToolSpec[];
  tier?: ModelTier;
  maxTokens: number;
  /** When set, the provider must return JSON matching this JSON Schema. */
  outputSchema?: Record<string, unknown>;
}

export interface GenerateResult {
  text: string;
  /** Parsed object when `outputSchema` was supplied. */
  object?: unknown;
  /** Tool calls the model made this turn (only when `tools` were offered). */
  toolCalls?: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}

/** Chat/generation provider. Workers AI by default; swappable. */
export interface AIProvider {
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

/**
 * A question for a {@link DecisionModel}. Decision models don't write text: they read a state
 * and answer each question with a probability for every allowed answer.
 * - `noul`: yes or no; answered with the probability of yes.
 * - `choice`: one of `options` (id → description); answered with the most probable option,
 *   the probability of each, and a confidence.
 * - `score`: a level on an ordered rubric (`levels`, lowest first); answered with a
 *   probability-weighted score (0 = the lowest level) and the probability of each level.
 */
export type DecisionQuestion =
  | {
      readonly type: 'noul';
      readonly instructions: string;
      /** What yes and no mean, when the instructions alone leave it open. */
      readonly criteria?: { readonly true: string; readonly false: string };
    }
  | {
      readonly type: 'choice';
      readonly instructions: string;
      readonly options: Readonly<Record<string, string>>;
    }
  | { readonly type: 'score'; readonly instructions: string; readonly levels: readonly string[] };

export interface DecisionRequest {
  /** What to decide about: text, or structured data. Untrusted content is fine here: the model
   *  can only answer the questions, from the options they define. */
  readonly state: string | Readonly<Record<string, unknown>> | readonly unknown[];
  /** 1 to 64 questions, by id (letters, digits, `_`, `.`, `-`). Answers come back by the same ids. */
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
  /** `flagship` for the most precise decisions, `fast` for the hot path. */
  readonly tier?: ModelTier;
}

export type DecisionAnswer =
  | { readonly type: 'noul'; readonly probability: number }
  | {
      readonly type: 'choice';
      readonly choice: string;
      readonly confidence: number;
      readonly probabilities: Readonly<Record<string, number>>;
    }
  | { readonly type: 'score'; readonly score: number; readonly probabilities: readonly number[] };

export interface DecisionResult {
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  /** The model that answered. */
  readonly model: string;
  /** Decision models bill input only. */
  readonly usage: { readonly inputTokens: number };
}

/** Decision provider: typed questions in, probabilities out. Workers AI (Clef) by default. */
export interface DecisionModel {
  decide(req: DecisionRequest): Promise<DecisionResult>;
}

/** Verdict from a {@link CostGuard} on whether a scope may make an AI call now. */
export interface AiBudgetDecision {
  readonly allowed: boolean;
  /** Which ceiling was hit, when `allowed` is false. */
  readonly reason?: 'requests' | 'tokens';
  /** Seconds until the rolling window frees up (best-effort hint for Retry-After). */
  readonly retryAfterSeconds?: number;
}

/**
 * Per-space AI usage governor. The application layer calls {@link consume}
 * before every AI generation and {@link settle} with the observed token usage
 * after — enforcing per-`Scope` request and token ceilings over a rolling
 * window so a single space (or a leaked key) cannot drive unbounded provider
 * spend. Backed by a Durable Object when shared state across isolates is needed,
 * or an in-process window for dev/tests.
 */
export interface CostGuard {
  /** Registers one AI request for the scope and reports whether it is within budget. */
  consume(scope: Scope): Promise<AiBudgetDecision>;
  /** Records observed token usage after a call (counts toward the token ceiling). */
  settle(scope: Scope, tokens: number): Promise<void>;
}

/** Embeddings provider (a separate port: embedding and generation models are chosen apart). */
export interface EmbeddingsProvider {
  readonly modelId: string;
  readonly dimensions: number;
  embed(texts: string[], opts?: { taskType?: 'document' | 'query' }): Promise<number[][]>;
}

export interface VectorRow {
  readonly scope: Scope;
  readonly entryId: string;
  readonly locale: string;
  readonly chunkIndex: number;
  readonly chunkText: string;
  readonly embedding: number[];
  readonly entryVersion: number;
}

export interface VectorMatch {
  readonly entryId: string;
  /** The locale the chunk's text is in (absent from a store that never recorded it). */
  readonly locale?: string;
  readonly chunkText: string;
  readonly score: number;
}

/** One indexed lexical document per published entry. */
export interface SearchDoc {
  readonly entryId: string;
  readonly contentTypeApiId: string;
  /** Human-readable text per locale (extracted from the entry's fields). */
  readonly textByLocale: Record<string, string>;
  readonly entryVersion: number;
}

/** What an index knows about its own contents, for one scope. */
export interface SearchIndexStats {
  /** Documents held for this scope — one per published entry when in sync. */
  readonly documents: number;
  /** Engine identifier, for an operator staring at a drift number. */
  readonly engine?: string;
}

/** One ranked lexical match (engine-relative score, ordering-only). */
export interface LexicalSearchHit {
  readonly entryId: string;
  readonly score: number;
}

/**
 * Lexical full-text index over published entries: the SearchShard Durable Objects (FTS5) in a
 * deployment. When bound, publishes (and the reindex job) write into it and hybrid search reads
 * its ranking; absent, the lexical leg falls back to `EntryRepo.searchPublished` (a bounded
 * substring scan, fine for dev and small spaces).
 */
export interface SearchIndex {
  /**
   * `refresh: false` defers making the doc searchable until the engine's own
   * refresh cycle — bulk callers (reindex) set it; publish-time indexing
   * defaults to immediate visibility.
   */
  index(scope: Scope, doc: SearchDoc, opts?: { refresh?: boolean }): Promise<void>;
  remove(scope: Scope, entryId: string): Promise<void>;
  search(scope: Scope, query: string, opts: { topK: number }): Promise<LexicalSearchHit[]>;
  /**
   * Removes every document of the scope (a deleted environment). Optional: an engine without it
   * leaves them, unreachable once the environment is gone.
   */
  clear?(scope: Scope): Promise<void>;
  /**
   * How many documents the engine holds for this scope.
   *
   * Optional: an engine that cannot count cheaply should omit it rather than
   * estimate, so a health report can say the number is unavailable instead of
   * reporting drift that may not exist.
   */
  stats?(scope: Scope): Promise<SearchIndexStats>;
}

/** Vector store for semantic search / RAG (Vectorize by default). */
export interface VectorStore {
  /**
   * Largest `topK` a single query honors, when the backend caps it (e.g.
   * Vectorize: 50 with metadata). Callers clamp their over-fetch to this so a
   * backend limit is an explicit contract, not a silent truncation.
   */
  readonly maxTopK?: number;
  upsert(rows: VectorRow[]): Promise<void>;
  deleteByEntry(scope: Scope, entryId: string): Promise<void>;
  query(
    scope: Scope,
    embedding: number[],
    opts: { topK: number; minScore?: number },
  ): Promise<VectorMatch[]>;
  /**
   * Asset vectors, one per asset and corpus, kept apart from entries' (on Vectorize, a namespace
   * of their own per corpus), so entry search, related entries and RAG answers never see an
   * asset's text, and Delivery's search never ranks a draft.
   */
  upsertAsset(scope: Scope, row: AssetVectorRow): Promise<void>;
  deleteAsset(scope: Scope, assetId: string, corpus: AssetSearchCorpus): Promise<void>;
  queryAssets(
    scope: Scope,
    embedding: number[],
    opts: { topK: number; minScore?: number; corpus: AssetSearchCorpus },
  ): Promise<AssetVectorMatch[]>;
}

/**
 * Which asset index: `library`, every asset as the library has it now (Management's search);
 * `published`, only published assets, from their published snapshots (Delivery's search).
 */
export type AssetSearchCorpus = 'library' | 'published';

/** One asset's embedding: its caption, title, alt text, tags and an excerpt of its text. */
export interface AssetVectorRow {
  readonly corpus: AssetSearchCorpus;
  readonly assetId: string;
  readonly embedding: number[];
  /** The asset's kind (`image`, `document`, …), kept as metadata. */
  readonly assetKind: string;
  readonly version: number;
}

export interface AssetVectorMatch {
  readonly assetId: string;
  readonly score: number;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * The interception points a hook can register for.
 *
 * Deliberately few and named for the exact moment they fire. Every one sits on
 * a write path, so each addition costs latency on an operation an editor is
 * waiting for — this is not a general event bus. Anything that can happen
 * *after* a commit belongs on the outbox instead, where it is retried,
 * observable, and cannot fail the request.
 */
export const HOOK_NAMES = [
  /** After defaults are applied, before slug normalization and validation. */
  'entry:beforeSave',
  /** Inside the publish transaction — a veto rolls the whole publish back. */
  'entry:beforePublish',
  'entry:beforeTrash',
  'entry:beforePurge',
  /** Before an upload URL is minted, so a refusal costs no storage. */
  'asset:beforeCreate',
] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/** A hook declined the operation. */
export interface HookVeto {
  /** Which hook refused, so the message can say whose rule this was. */
  readonly hook: string;
  readonly reason: string;
  /**
   * Field-level objections. When present on `entry:beforeSave` the caller
   * raises a ValidationError, so a hook's complaint about a field reaches the
   * editor the same way a built-in validation would.
   */
  readonly issues?: readonly FieldIssue[];
}

/**
 * The outcome of dispatching one hook: either the (possibly rewritten) payload,
 * or a refusal.
 */
export type HookResult<T> =
  | {
      readonly payload: T;
      /** Handlers left out by {@link HookDispatchOptions.pureOnly}, by id. */
      readonly skipped?: readonly string[];
    }
  | { readonly veto: HookVeto };

export interface HookDispatchOptions {
  /**
   * Run only the handlers that can have no effect beyond their answer, and skip the rest (named in
   * the result's `skipped`). A dry run (validating an entry without saving it) asks for this: it
   * must not write, so it cannot run a handler holding authority to write or to reach out, even
   * though that handler might rewrite or refuse the payload on a real save. A plugin is pure when
   * its effective grant is empty: ambient `fetch` is severed, so with no capability object it can
   * only compute.
   */
  readonly pureOnly?: boolean;
}

/**
 * Runs registered handlers for a hook.
 *
 * Implementations MUST: run handlers sequentially in registration order, each
 * seeing the previous one's mutations, so the result is deterministic; bound
 * every handler with a timeout; and never expose the store — a handler
 * receives a payload, not a database.
 *
 * A handler that throws or times out is governed by that handler's own error
 * policy, not the dispatcher's: an optional enrichment must not make the CMS
 * unwritable, while a compliance rule must be able to insist that failure means
 * refusal.
 */
export interface HookDispatcher {
  dispatch<T>(
    hook: HookName,
    payload: T,
    scope: Scope,
    options?: HookDispatchOptions,
  ): Promise<HookResult<T>>;
}

// ---------------------------------------------------------------------------
// Plugin execution
// ---------------------------------------------------------------------------

/** One call into a plugin: the code, the hook, and the payload. */
export interface PluginInvocation {
  readonly pluginId: string;
  /** Module source. The caller has already verified it against its checksum. */
  readonly bundle: string;
  /** Module path the bundle registers itself under. */
  readonly entrypoint: string;
  /** Distinguishes cached isolates — a changed bundle must not reuse an old one. */
  readonly checksum: string;
  readonly hook: HookName;
  readonly payload: unknown;
  /**
   * The effective grant (declared ∩ approved). A runtime MUST hand the plugin
   * no capability method outside this list.
   */
  readonly capabilities: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly timeoutMs?: number;
  /** Where the hook fired — carried so a refused capability call can be audited. */
  readonly scope?: Scope;
  /**
   * A dry run ({@link HookDispatchOptions.pureOnly}): a capability call is refused as ever, but
   * the refusal is not reported, because reporting it writes an audit row and a dry run writes
   * nothing.
   */
  readonly dryRun?: boolean;
}

/**
 * Host-side capability objects, keyed by the name a plugin sees.
 *
 * Passed *per invocation* rather than baked into the isolate: a warm, cached
 * sandbox must not retain authority granted for an earlier call. The
 * implementations live outside the sandbox, so a plugin holds a reference, never
 * the code or the authority behind it.
 *
 * A capability that was not granted carries no authority: the application
 * builds no method for it, and the sandbox runtime hands the plugin at most an
 * inert stand-in that refuses with a `capability_denied` error.
 */
export type PluginCapabilities = Record<string, unknown>;

/**
 * Runs plugin code in isolation.
 *
 * Implementations MUST: refuse to run anything they cannot sandbox; bound every
 * invocation with a timeout; and never hand a plugin a capability that was not
 * passed in.
 */
export interface PluginRuntime {
  invoke(
    invocation: PluginInvocation,
    capabilities: PluginCapabilities,
  ): Promise<HookResult<unknown>>;
}

/**
 * What the media origin needs to serve one published asset, kept where it can read it on a cache
 * miss without the database: the version its URLs carry, where the bytes are, and the focal point
 * crops gravitate to. Written and removed only by the engine, from the asset's events.
 */
export interface AssetGateEntry {
  readonly v: number;
  readonly r2Key: string;
  readonly contentType: string;
  readonly fileName: string;
  readonly focal?: FocalPoint;
  /** When delivery must stop (the asset's rights); past it the media origin answers 410. */
  readonly expiresAt?: string;
}

/** The published-asset gate the media origin checks before serving bytes (KV on the edge). */
export interface AssetGate {
  get(scope: Scope, assetId: string): Promise<AssetGateEntry | null>;
  put(scope: Scope, assetId: string, entry: AssetGateEntry): Promise<void>;
  delete(scope: Scope, assetId: string): Promise<void>;
  /** Removes every entry of the scope (a deleted environment). Idempotent. */
  deleteScope(scope: Scope): Promise<void>;
}

/**
 * The unguessable segment of a published asset's media URL: a keyed MAC over the scope, the asset
 * and the version, so a URL can't be had by editing another one (another environment's copy of
 * the same asset id, another version). Synchronous, so projecting an asset stays a pure function.
 */
export interface MediaPathSigner {
  token(scope: Scope, assetId: string, version: number): string;
  /** Whether `token` is the one {@link token} gives; constant-time. */
  verify(scope: Scope, assetId: string, version: number, token: string): boolean;
  /**
   * The token in a share link's URL (`/s/<space>/<env>/<linkId>/<token>`): a MAC over the scope
   * and the link id under another label, so a link's URL can't be guessed from its id, and no
   * asset path's token is ever a link's.
   */
  linkToken(scope: Scope, linkId: string): string;
  verifyLink(scope: Scope, linkId: string, token: string): boolean;
}

/** What the media origin uses of an active share link (read from a D1 replica per request). */
export interface ShareLinkGateEntry {
  readonly targetType: AssetShareTargetType;
  readonly targetId: string;
  readonly expiresAt: string;
  readonly allowDownload: boolean;
  /** PBKDF2 hash of the link's password, when it has one. */
  readonly passwordHash?: string;
}

/** Hashes and checks passwords (PBKDF2-SHA256, the admin's scheme), for share links. */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, stored: string): Promise<boolean>;
}

/** What one zip build is about. Plain JSON: a Workflow instance's payload. */
export interface AssetZipParams {
  readonly scope: Scope;
  readonly jobId: string;
}

/** Starts the durable build of a zip (one Workflow instance per job id). */
export interface AssetZipStarter {
  /** `true` when this call started the build; `false` when one under that id already existed. */
  start(params: AssetZipParams): Promise<boolean>;
}

/** Ingest of one asset's file, as the queue carries it (see {@link AssetIngestQueue}). */
export interface AssetIngestRequest {
  readonly scope: Scope;
  readonly assetId: string;
  readonly version: number;
  /**
   * Set to run ingest again on a file already ingested (a person's retry, the reindex job): a
   * fresh run, where without it a repeat request for the same file is the same run.
   */
  readonly rerun?: string;
}

/**
 * Hands asset files to ingest, through the engine's asset-events queue (which R2's object-create
 * notifications also feed). At least once: ingest dedupes by file, so a repeat costs nothing.
 */
export interface AssetIngestQueue {
  /**
   * An object was written under `key` (a completed upload). `etag` names the bytes written, so a
   * second write to the same key (the same signed URL used again) is ingested again.
   */
  objectCreated(key: string, etag?: string): Promise<void>;
  request(requests: readonly AssetIngestRequest[]): Promise<void>;
}

/** What one ingest run is about. Plain JSON: it is a Workflow instance's payload. */
export interface AssetIngestParams {
  readonly scope: Scope;
  readonly assetId: string;
  readonly version: number;
}

/**
 * Starts an ingest run (an `AssetIngestWorkflow` instance on edge). Idempotent on `instanceId`: a
 * run already started under that id is not started again, which is what makes a redelivered
 * notification free.
 */
export interface AssetIngestStarter {
  /** `true` when this call started the run; `false` when a run under that id already existed. */
  start(instanceId: string, params: AssetIngestParams): Promise<boolean>;
}
