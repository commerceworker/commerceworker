/**
 * Flows: each flow's draft (what the editor saves) and its published versions (what orders run
 * on, pinned by number for the life of an order). A publish numbers and writes the version in one
 * statement, so two racing publishes get consecutive versions; a version is never changed once
 * written. `d1FlowStore` (packages/db) and `InMemoryFlowStore` (packages/test-kit) implement it,
 * held to one contract.
 */
import type { FlowVersion } from '@commerceworker/core';

/** A flow as the editor saves it: the graph JSON-able, its shape core's to check. */
export interface FlowDraft {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly model: string;
  readonly channels: string[];
  readonly nodes: unknown[];
  readonly edges: unknown[];
}

export interface FlowRecord extends FlowDraft {
  /** The version orders start on, or null while the flow has never been published. */
  readonly publishedVersion: number | null;
  readonly archivedAt: number | null;
  readonly updatedAt: number;
}

export interface FlowStore {
  /** The flow's draft and where it stands, or undefined for an unknown id. */
  flow(id: string): Promise<FlowRecord | undefined>;
  /** Every flow, by name. */
  list(): Promise<FlowRecord[]>;
  /** A published version: `version`, or the latest. */
  version(id: string, version?: number): Promise<FlowVersion | null>;
  /** Saves the draft, creating the flow on its first save. */
  saveDraft(flow: FlowDraft): Promise<void>;
  /**
   * Saves the draft and publishes it as the next version; returns the version. With
   * `unlessPublished`, content that already is a version publishes nothing and the latest is
   * returned.
   */
  publish(
    flow: FlowDraft,
    opts?: { unlessPublished?: boolean; publishedBy?: string | null },
  ): Promise<number>;
  /** Publishes each of these whose exact content was never published (the built-in templates). */
  seed(flows: readonly FlowDraft[]): Promise<void>;
  /**
   * Archives (or restores) a flow that was never published. Returns it, or undefined when it was
   * published or doesn't exist.
   */
  setArchived(id: string, archived: boolean): Promise<{ id: string; name: string } | undefined>;
  /** Every flow by name, with the graph and time of the version it publishes (null if none). */
  listWithPublished(): Promise<
    (FlowRecord & {
      published: { nodes: unknown[]; edges: unknown[]; publishedAt: number } | null;
    })[]
  >;
  /** A flow's published versions, newest first. */
  history(id: string): Promise<{ version: number; publishedAt: number }[]>;
  /** How many flows there are, archived ones included. */
  count(): Promise<number>;
  /** The version each flow that isn't archived currently publishes. */
  publishedVersions(): Promise<FlowVersion[]>;
}
