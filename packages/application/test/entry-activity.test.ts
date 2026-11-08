import { type AuditDetail, type EntryChange, ValidationError } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  listEntryActivity,
  type RecordAuditInput,
  recordAudit,
} from '../src/index';

/**
 * An entry's activity: the audit rows about it, newest first, through the audit log's own paging.
 * About it means targeting it, or naming it in `detail` while targeting something else; once
 * each, in its own environment and space only.
 */

const scope = { spaceId: 'blog', environmentId: 'main' };
const ENTRY = 'entry-1';

const change = (entryId: string, over: Partial<EntryChange> = {}): EntryChange => ({
  entryId,
  contentType: 'article',
  kind: 'updated',
  version: 2,
  paths: ['fields.title'],
  locales: [],
  ...over,
});
const detailOf = (...entries: EntryChange[]): AuditDetail => ({ entries });

describe('an entry’s activity', () => {
  let ctx: AppContext;
  let clock: FixedClock;
  const record = async (over: Partial<RecordAuditInput>) => {
    clock.advance(1000);
    return recordAudit(ctx, {
      spaceId: 'blog',
      environmentId: 'main',
      actor: 'usr_ada',
      action: 'PUT /spaces/:space/environments/:env/entries/:id',
      status: 200,
      ...over,
    });
  };

  beforeEach(() => {
    const store = new InMemoryContentStore();
    clock = new FixedClock();
    ctx = { store, clock, ids: new SequenceIdGenerator('a') };
  });

  it('lists the rows that target it and the rows that saved it, newest first', async () => {
    const created = await record({
      action: 'POST /spaces/:space/environments/:env/entries',
      targetType: 'entry',
      targetId: ENTRY,
      detail: detailOf(change(ENTRY, { kind: 'created', version: 1 })),
    });
    const approved = await record({
      action: 'POST /spaces/:space/environments/:env/agent-reviews/:id/approve',
      targetType: 'agent_review',
      targetId: 'review-1',
      detail: detailOf(change('entry-2'), change(ENTRY, { version: 3 })),
    });
    const published = await record({
      action: 'POST /spaces/:space/environments/:env/entries/:id/published',
      targetType: 'entry',
      targetId: ENTRY,
    });
    // Not about it: another entry, and a row that names its id as something other than an entry.
    await record({ targetType: 'entry', targetId: 'entry-2', detail: detailOf(change('entry-2')) });
    await record({ targetType: 'release', targetId: ENTRY });

    const page = await listEntryActivity(ctx, scope, ENTRY);

    expect(page.items.map((e) => e.id)).toEqual([published.id, approved.id, created.id]);
    expect(page.nextCursor).toBeUndefined();
    // Served as recorded: the review's row still names both entries it saved.
    expect(page.items[1]?.detail?.entries.map((e) => e.entryId)).toEqual(['entry-2', ENTRY]);
  });

  it('lists a row once when it both targets the entry and names it in detail', async () => {
    await record({ targetType: 'entry', targetId: ENTRY, detail: detailOf(change(ENTRY)) });
    expect((await listEntryActivity(ctx, scope, ENTRY)).items).toHaveLength(1);
  });

  it('keeps a row from before field paths were recorded, with no detail rather than an empty one', async () => {
    await record({ targetType: 'entry', targetId: ENTRY });
    const [row] = (await listEntryActivity(ctx, scope, ENTRY)).items;
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('detail');
  });

  it('reads only its own environment and space: an entry id is unique only within one', async () => {
    await record({ targetType: 'entry', targetId: ENTRY });
    await record({ environmentId: 'staging', targetType: 'entry', targetId: ENTRY });
    await record({ spaceId: 'other', targetType: 'entry', targetId: ENTRY });
    // A row that names no environment (a promotion's) belongs to none of them.
    await record({
      environmentId: undefined,
      targetType: 'promotion',
      targetId: 'p-1',
      detail: detailOf(change(ENTRY)),
    });

    expect((await listEntryActivity(ctx, scope, ENTRY)).items).toHaveLength(1);
    const staging = await listEntryActivity(ctx, { ...scope, environmentId: 'staging' }, ENTRY);
    expect(staging.items.map((e) => e.environmentId)).toEqual(['staging']);
    const other = await listEntryActivity(ctx, { ...scope, spaceId: 'other' }, ENTRY);
    expect(other.items.map((e) => e.spaceId)).toEqual(['other']);
  });

  it('pages by the audit log’s keyset, through rows sharing a millisecond', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 7; n++) {
      // Rows 2 to 5 share one millisecond, so the page edges fall inside the tie.
      if (n < 2 || n > 5) clock.advance(1000);
      const row = await recordAudit(ctx, {
        spaceId: 'blog',
        environmentId: 'main',
        actor: 'usr_ada',
        action: 'a',
        status: 200,
        targetType: n % 2 ? 'entry' : 'agent_review',
        targetId: n % 2 ? ENTRY : `review-${n}`,
        ...(n % 2 ? {} : { detail: detailOf(change(ENTRY)) }),
      });
      ids.push(row.id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listEntryActivity(ctx, scope, ENTRY, { limit: 2, cursor });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen[0]).toBe(ids[6]);
    expect(seen[6]).toBe(ids[0]);
  });

  it('still serves an entry that no longer exists: its history outlives it', async () => {
    await record({
      action: 'DELETE /spaces/:space/environments/:env/entries/:id/permanent',
      targetType: 'entry',
      targetId: ENTRY,
    });
    expect((await listEntryActivity(ctx, scope, ENTRY)).items).toHaveLength(1);
  });

  it('is an empty page for an entry with no rows', async () => {
    expect(await listEntryActivity(ctx, scope, 'entry-none')).toEqual({ items: [] });
  });

  it('refuses an id that cannot be an entry id, and a cursor it cannot read', async () => {
    await expect(listEntryActivity(ctx, scope, 'not an id')).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(listEntryActivity(ctx, scope, '')).rejects.toBeInstanceOf(ValidationError);
    // No environment would be every environment's rows for that id: refused, not widened.
    await expect(
      listEntryActivity(ctx, { ...scope, environmentId: '' }, ENTRY),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      listEntryActivity(ctx, scope, ENTRY, { cursor: 'garbage!' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
