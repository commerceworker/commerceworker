/*
 * Publish gating (`gatesPublish`): an entry a gated workflow covers publishes only from a run of
 * that workflow. Every publish path loads a `PublishGuard` once and asks it about each entry.
 *
 * The one way past a gate is a `PublishGrant`, and only this package's own code can make one: a
 * grant is an object this module minted (held in a WeakSet), so an options object parsed from an
 * HTTP body or MCP arguments, whatever its shape, never counts as one. This module is deliberately
 * not exported from the package index.
 */

import {
  type GatedEntry,
  gatesCovering,
  type PublishGate,
  PublishGatedError,
  type ReleaseItem,
  type Scope,
} from '@commerceworker/domain';
import type { ContentStoreTx, WorkflowGraphRepo } from '@commerceworker/ports';

/** Why a publish may pass a gate. Opaque: see {@link grantWorkflowRunPublish}. */
export interface PublishGrant {
  readonly kind: 'workflow_run' | 'snapshot_import';
  readonly workflowId?: string;
  readonly runId?: string;
}

const minted = new WeakSet<PublishGrant>();

function mint(grant: PublishGrant): PublishGrant {
  const frozen = Object.freeze({ ...grant });
  minted.add(frozen);
  return frozen;
}

/**
 * A run of `workflowId` publishing: passes the gates of that workflow only, so a run of one gated
 * workflow cannot publish an entry another gated workflow alone covers. Minted by the
 * `content.publish` and `content.publish_release` node executors, from the interpreter's run.
 */
export function grantWorkflowRunPublish(workflowId: string, runId: string): PublishGrant {
  return mint({ kind: 'workflow_run', workflowId, runId });
}

/**
 * A snapshot import republishing what was published in its source (`publishSnapshotEntry`, the one
 * exempt path): a copy of published state, not an editorial publish. It passes every gate in the
 * target, those the import wrote from the snapshot and any the target already held
 * (`prepareSnapshotImport` requires the target to have no content types, not no workflows).
 */
export function grantSnapshotImport(): PublishGrant {
  return mint({ kind: 'snapshot_import' });
}

/** Answers, for each entry a publish touches, whether a gate refuses it. */
export interface PublishGuard {
  /** The refusal for an entry of `contentTypeApiId`, or null when it may publish. */
  refusal(entryId: string, contentTypeApiId: string): GatedEntry | null;
  /** Throws {@link PublishGatedError} when a gate refuses the entry. */
  assert(entryId: string, contentTypeApiId: string): void;
}

/** Guards {@link loadPublishGuard} built; any other object of the same shape is not one. */
const loaded = new WeakSet<PublishGuard>();

function register(guard: PublishGuard): PublishGuard {
  const frozen = Object.freeze(guard);
  loaded.add(frozen);
  return frozen;
}

/** `guard` when this module built it; otherwise null, and the caller loads a real one. */
export function trustedGuard(guard: PublishGuard | undefined): PublishGuard | null {
  return guard && loaded.has(guard) ? guard : null;
}

/** No gate covers anything, or the grant passes them all. */
const OPEN: PublishGuard = register({ refusal: () => null, assert: () => {} });

/**
 * Reads the scope's gates (one query) and returns the guard for a publish made with `grant`. A
 * `grant` this module did not mint is ignored, as if absent.
 */
export async function loadPublishGuard(
  reader: Pick<WorkflowGraphRepo, 'listPublishGates'>,
  scope: Scope,
  grant?: PublishGrant,
): Promise<PublishGuard> {
  const trusted = grant && minted.has(grant) ? grant : undefined;
  if (trusted?.kind === 'snapshot_import') return OPEN;
  const gates: readonly PublishGate[] = await reader.listPublishGates(scope);
  if (gates.length === 0) return OPEN;
  const refusal = (entryId: string, contentTypeApiId: string): GatedEntry | null => {
    const covering = gatesCovering(gates, contentTypeApiId);
    if (covering.length === 0) return null;
    if (
      trusted?.kind === 'workflow_run' &&
      covering.some((g) => g.workflowId === trusted.workflowId)
    )
      return null;
    return { entryId, workflows: covering.map((g) => ({ id: g.workflowId, name: g.name })) };
  };
  return register({
    refusal,
    assert(entryId, contentTypeApiId) {
      const refused = refusal(entryId, contentTypeApiId);
      if (refused) throw new PublishGatedError([refused]);
    },
  });
}

/**
 * Refuses a release whose `publish` members a gate covers, naming all of them at once (one batch
 * read), rather than failing on the first member the publish loop reaches. Unpublish members are
 * never gated. A member that no longer exists is left to the publish loop's NotFoundError.
 */
export async function assertReleaseUngated(
  reader: Pick<ContentStoreTx, 'entries'>,
  scope: Scope,
  releaseId: string,
  items: readonly ReleaseItem[],
  guard: PublishGuard,
): Promise<void> {
  const ids = items.filter((i) => i.action === 'publish').map((i) => i.entityId);
  if (ids.length === 0) return;
  const refused = (await reader.entries.getMany(scope, ids))
    .map((f) => guard.refusal(f.entry.id, f.entry.contentTypeApiId))
    .filter((r): r is GatedEntry => r !== null);
  if (refused.length > 0) throw new PublishGatedError(refused, { releaseId });
}
