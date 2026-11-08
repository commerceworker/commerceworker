import { env } from 'cloudflare:workers';
import {
  type AppContext,
  consumeEvent,
  createContentType,
  createEntry,
  createSpace,
  deleteContentTypeWithEntries,
  getBulkJob,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import type { DomainEvent, FieldDefinition } from '@commerceworker/domain';
import { deliveryScopeTag } from '@commerceworker/platform/messages';
import { createD1Store } from '@commerceworker/store';
import { RecordingWebhookSender } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { newPurgePlan, planPurges } from '../src/purges';

/**
 * A content type deleted with its entries, as the engine runs it on D1: `bulk.chunk_due` events
 * trash and purge each chunk's entries, the job's `bulk.job_completed` deletes the type, and its
 * `content_type.deleted` purges the environment's delivery responses. Every event is delivered
 * twice, as a queue may: a redelivered chunk loses its claim, a redelivered completion finds the
 * type gone, and nothing is done twice.
 */
const store = createD1Store(env.DB);

async function eventsOf(spaceId: string): Promise<{ rowid: number; event: DomainEvent }[]> {
  const rows = await env.DB.prepare(
    "select rowid, payload from outbox where json_extract(payload, '$.scope.spaceId') = ? order by rowid",
  )
    .bind(spaceId)
    .all<{ rowid: number; payload: string }>();
  return rows.results.map((r) => ({ rowid: r.rowid, event: JSON.parse(r.payload) as DomainEvent }));
}

describe('a content type delete job in the engine', () => {
  // 55 creates, 28 publishes and every event consumed twice are hundreds of D1 round trips: 0.3 to
  // 1 s locally, but past vitest's default 5 s on a loaded CI runner (PR #119), so it gets twenty.
  it('trashes and purges every entry, then deletes the type and purges delivery, once', {
    timeout: 20_000,
  }, async () => {
    const ctx: AppContext = {
      store,
      clock: { now: () => new Date() },
      ids: { newId: () => crypto.randomUUID() },
    };
    const spaceId = `engine-ct-delete-${crypto.randomUUID()}`;
    await createSpace(ctx, { spaceId, name: 'Delete', defaultLocale: 'en-US' });
    const scope = { spaceId, environmentId: 'main' };
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: false,
          required: false,
          position: 0,
        },
        {
          apiId: 'prev',
          name: 'Previous',
          type: 'Link',
          linkType: 'Entry',
          localized: false,
          required: false,
          position: 1,
        },
      ] as FieldDefinition[],
    });
    await publishContentType(ctx, scope, 'note');
    const ids: string[] = [];
    // Past one chunk (50), each linking the one before it.
    for (let i = 0; i < 55; i++) {
      const { entry } = await createEntry(ctx, scope, {
        contentTypeApiId: 'note',
        fields: {
          title: { 'en-US': `n${i}` },
          ...(i > 0 ? { prev: { 'en-US': { id: ids[i - 1], linkType: 'Entry' } } } : {}),
        },
      });
      if (i % 2 === 0) await publishEntry(ctx, scope, entry.id);
      ids.push(entry.id);
    }

    const started = await deleteContentTypeWithEntries(ctx, scope, 'note');
    if (started.deleted) throw new Error('expected a job');

    const sender = new RecordingWebhookSender();
    const plan = newPurgePlan();
    let seen = 0;
    for (let round = 0; round < 10; round++) {
      const fresh = (await eventsOf(spaceId)).filter((r) => r.rowid > seen);
      if (fresh.length === 0) break;
      seen = fresh[fresh.length - 1]?.rowid ?? seen;
      for (const { event } of fresh) {
        for (let run = 0; run < 2; run++) {
          await consumeEvent(ctx, { sender }, event);
          await planPurges(ctx, plan, event);
        }
      }
    }

    const job = await getBulkJob(ctx, scope, started.job.id);
    expect(job).toMatchObject({ status: 'completed', succeeded: ids.length, failed: 0 });
    expect(await store.entries.getMany(scope, ids)).toEqual([]);
    expect(await store.contentTypes.get(scope, 'note')).toBeNull();
    const deleted = (await eventsOf(spaceId)).filter(
      (r) => r.event.type === 'content_type.deleted',
    );
    expect(deleted).toHaveLength(1);
    expect([...plan.delivery]).toEqual([deliveryScopeTag(spaceId, 'main')]);
  });
});
