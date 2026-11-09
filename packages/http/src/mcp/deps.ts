import type {
  AccessPolicy,
  AgentRunner,
  AppContext,
  AssetSearchDeps,
  RagDeps,
  WorkflowNodeDeps,
} from '@commerceworker/application';
import type { AgentReview } from '@commerceworker/domain';
import type {
  AIProvider,
  AssetIngestQueue,
  BlobStore,
  Hasher,
  ImportSource,
  RemoteFetcher,
  SpaceExportReader,
  WorkflowEngine,
} from '@commerceworker/ports';

/**
 * Everything the MCP tool server needs. Built per request by the composition
 * root (`main.ts`) from the same wiring the HTTP API uses, so MCP tools are
 * just another caller of the application use-cases.
 */
export interface McpDeps {
  readonly ctx: AppContext;
  readonly ai: AIProvider;
  readonly rag: RagDeps;
  /** Asset search's indexes (as AuthDeps' `assetSearch`); absent, the RAG wiring's. */
  readonly assetSearch?: AssetSearchDeps;
  /** Delivers review decisions to a durable HITL watcher (optional). */
  readonly signalReview?: (
    review: AgentReview,
    decision: 'approved' | 'rejected',
  ) => Promise<boolean>;
  /** Agent-workflow runtime for on-demand agent actions (moderation). */
  readonly agents: AgentRunner;
  readonly hasher: Hasher;
  /** Root token granting all scopes across all spaces. */
  readonly adminToken: string;
  /** When true, publish runs moderation first and blocks flagged content. */
  readonly moderateBeforePublish?: boolean;
  /**
   * Readers for external content formats, by source id. Required: a caller that left it out once
   * shipped an api Worker whose `import_*` tools answered "no import sources".
   */
  readonly importSources: Readonly<Record<string, ImportSource>>;
  /** Reads the JSON space export format. */
  readonly spaceExportReader: SpaceExportReader;
  /** Starts/signals/cancels editorial workflow runs; absent → run tools refuse (not configured). */
  readonly workflowEngine?: WorkflowEngine;
  /** AI, email and webhook ports for workflow node compensations (cancel). */
  readonly workflowNodes?: WorkflowNodeDeps;
  /** Object storage, where environment import and clone jobs stage their work. Absent: those
   *  tools run synchronously (local fakes, tests). */
  readonly blob?: BlobStore;
  /** Hands asset files to ingest; absent, asset_reingest refuses (not configured). */
  readonly assetIngest?: AssetIngestQueue;
  /** Bounded, redirect-refusing outbound GETs (embed metadata). */
  readonly remoteFetcher: RemoteFetcher;
  /** Whether people sign in through SSO (for the last-administrator rule). Absent: no SSO. */
  readonly accessPolicy?: AccessPolicy;
  /** The admin's origin, where invitation links open (as AuthDeps' `inviteOrigin`). */
  readonly inviteOrigin?: string;
  /** Whether space_create offers the demo starters (as AuthDeps' `demoStarters`). */
  readonly demoStarters?: boolean;
}
