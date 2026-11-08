/**
 * A release groups several entries so they can be published together in a single
 * atomic transaction. Each item names an entry and the action to apply when the
 * release ships.
 */

import { InvalidStateError } from '../errors';

export type ReleaseStatus = 'open' | 'published' | 'archived';

/** What a release does to one of its members when it ships. */
export type ReleaseAction = 'publish' | 'unpublish';

/** A single member of a release. Entries only for now (assets follow later). */
export interface ReleaseItem {
  readonly entityType: 'Entry';
  readonly entityId: string;
  readonly action: ReleaseAction;
}

export interface Release {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly status: ReleaseStatus;
  readonly createdAt: string;
  readonly publishedAt?: string;
}

/** A release together with its members. */
export interface ReleaseWithItems {
  readonly release: Release;
  readonly items: readonly ReleaseItem[];
}

/** Marks a release published at `at`. Only an open release may ship. */
export function publishRelease(release: Release, at: string): Release {
  if (release.status !== 'open') {
    throw new InvalidStateError(`Cannot publish a ${release.status} release`);
  }
  return { ...release, status: 'published', publishedAt: at };
}

/** Archives an open release (it can no longer ship). */
export function archiveRelease(release: Release): Release {
  if (release.status === 'published') {
    throw new InvalidStateError('Cannot archive a published release');
  }
  return { ...release, status: 'archived' };
}
