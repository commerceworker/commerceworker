import type { DomainEvent, Principal } from '@commerceworker/domain';
import { describe, expect, it } from 'vitest';
import { LIVE_EVENT_TYPES, liveEventFor } from '../src/delivery';

const scope = { spaceId: 's1', environmentId: 'main' };
const base = { occurredAt: '2026-01-01T00:00:00.000Z', scope };
const ev = (e: Record<string, unknown>) => ({ id: 'e1', ...base, ...e }) as unknown as DomainEvent;

const open: Pick<Principal, 'contentGrants'> = {};
const postsOnly: Pick<Principal, 'contentGrants'> = {
  contentGrants: [{ contentTypeApiId: 'post', actions: ['read'], deniedFields: ['internalNotes'] }],
};

const published = (contentTypeApiId: string) =>
  ev({
    type: 'entry.published',
    entryId: 'x',
    contentTypeApiId,
    version: 1,
    fields: { title: { 'en-US': 'T' }, internalNotes: { 'en-US': 'secret' } },
  });

describe('liveEventFor', () => {
  it('carries published-content facts only, never editorial or internal events', () => {
    for (const type of [
      'workflow.task_opened',
      'workflow_run.completed',
      'bulk.chunk_due',
      'bulk.job_completed',
      'search.reindex_requested',
    ]) {
      expect(liveEventFor(open, ev({ type })), type).toBeNull();
    }
    expect(LIVE_EVENT_TYPES.has('entry.published')).toBe(true);
    expect(liveEventFor(open, published('page'))).toEqual(published('page'));
  });

  it('shows a restricted key its granted types, masked, and nothing else', () => {
    expect(liveEventFor(postsOnly, published('page'))).toBeNull();
    const post = liveEventFor(postsOnly, published('post')) as { fields: Record<string, unknown> };
    expect(post.fields.title).toEqual({ 'en-US': 'T' });
    expect(post.fields.internalNotes).toBeUndefined();

    const unpublished = (t: string) =>
      ev({ type: 'entry.unpublished', entryId: 'x', contentTypeApiId: t });
    expect(liveEventFor(postsOnly, unpublished('post'))).not.toBeNull();
    expect(liveEventFor(postsOnly, unpublished('page'))).toBeNull();

    const typePublished = (t: string) =>
      ev({ type: 'content_type.published', contentTypeApiId: t, version: 2 });
    expect(liveEventFor(postsOnly, typePublished('post'))).not.toBeNull();
    expect(liveEventFor(postsOnly, typePublished('page'))).toBeNull();

    // A deleted type names itself: only a key that may read it hears of it.
    const typeDeleted = (t: string) =>
      ev({ type: 'content_type.deleted', contentTypeApiId: t, version: 3 });
    expect(liveEventFor(postsOnly, typeDeleted('post'))).not.toBeNull();
    expect(liveEventFor(postsOnly, typeDeleted('page'))).toBeNull();
    expect(liveEventFor(open, typeDeleted('page'))).not.toBeNull();

    expect(
      liveEventFor(postsOnly, ev({ type: 'environment_alias.changed', targetEnvironmentId: 'b' })),
    ).not.toBeNull();
  });

  it('withholds asset, bulk and release facts from a restricted key', () => {
    for (const e of [
      ev({ type: 'asset.published', assetId: 'a' }),
      ev({ type: 'asset.unpublished', assetId: 'a' }),
      ev({
        type: 'entries.published_bulk',
        jobId: 'j',
        chunkId: 'c',
        action: 'publish',
        entryIds: ['x'],
      }),
      ev({ type: 'release.published', releaseId: 'r', entryIds: ['x'] }),
    ]) {
      expect(liveEventFor(postsOnly, e), e.type).toBeNull();
      expect(liveEventFor(open, e), e.type).not.toBeNull();
    }
  });
});
