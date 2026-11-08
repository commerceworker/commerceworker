import {
  type AppContext,
  createChangeLog,
  createContentType,
  createEntry,
  createSpace,
  listAuditLog,
  publishContentType,
  recordAudit,
  SYSTEM_CALLER,
  updateEntry,
  withChanges,
} from '@commerceworker/application';
import { type AuditDetail, MAX_AUDIT_DETAIL_SIZE } from '@commerceworker/domain';
import type { AuditEntry } from '@commerceworker/ports';
import { countingD1 } from '@commerceworker/test-kit/d1';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * `audit_log.detail` against D1: what a save notes reaches the row and comes back as it went in, a
 * row without any reads as it always did, nothing a writer typed reaches the column, and working
 * it out costs a save no statement.
 */

const SENTINEL = 'SENTINEL_d41d8c';
const ids = { newId: () => crypto.randomUUID() };
const clock = { now: () => new Date('2026-03-01T00:00:00.000Z') };

const field = (apiId: string, type: string, position: number, extra: object = {}) => ({
  apiId,
  name: apiId,
  type: type as 'Symbol',
  localized: false,
  required: false,
  position,
  ...extra,
});

describe('audit row detail on D1', { timeout: 60_000 }, () => {
  const spaceId = `audit-detail-${crypto.randomUUID()}`;
  const scope = { spaceId, environmentId: 'main' };
  const ctx: AppContext = { store: createD1Store(testDb), clock, ids };
  const newEntry = async () =>
    (
      await createEntry(ctx, scope, {
        contentTypeApiId: 'article',
        fields: { title: { 'en-US': 'Hello' } },
      })
    ).entry.id;
  const row = (over: Partial<AuditEntry> = {}): AuditEntry => ({
    id: crypto.randomUUID(),
    spaceId,
    actor: 'usr_ada',
    action: 'PUT /entries/:id',
    status: 200,
    at: clock.now().toISOString(),
    ...over,
  });

  beforeAll(async () => {
    await createSpace(ctx, {
      spaceId,
      name: 'Audit detail',
      defaultLocale: 'en-US',
      locales: ['en-US', 'de'],
    });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'article',
      name: 'Article',
      displayField: 'title',
      fields: [
        field('title', 'Symbol', 0, { localized: true }),
        field('hero', 'Component', 1, { fields: [field('alt', 'Symbol', 0)] }),
        field('data', 'JSON', 2),
      ],
    });
    await publishContentType(ctx, scope, 'article');
  });

  it('keeps what a save noted on its row, and reads it back as it went in', async () => {
    const id = await newEntry();
    const log = createChangeLog();
    await updateEntry(withChanges(ctx, log), scope, id, {
      title: { 'en-US': 'Hello', de: 'Hallo' },
      hero: { 'en-US': { alt: 'A boat' } },
    });
    const detail = log.detail();
    await recordAudit(ctx, {
      spaceId,
      actor: 'usr_ada',
      action: 'PUT',
      targetId: id,
      status: 200,
      detail,
    });
    const { items } = await listAuditLog(ctx, spaceId, { targetId: id });
    expect(items[0]?.detail).toEqual({
      entries: [
        {
          entryId: id,
          contentType: 'article',
          kind: 'updated',
          version: 2,
          paths: ['fields.title', 'fields.hero'],
          locales: ['de'],
        },
      ],
    } satisfies AuditDetail);
  });

  it('reads a row without detail, an older one, with no such key', async () => {
    const id = crypto.randomUUID();
    await ctx.store.audit.append(row({ id }));
    await testDb
      .prepare(
        'INSERT INTO audit_log (id, space_id, actor, action, status, at) VALUES (?,?,?,?,?,?)',
      )
      .bind(`${id}-old`, spaceId, 'usr_ada', 'PUT', 200, Date.parse(clock.now().toISOString()))
      .run();
    const { items } = await listAuditLog(ctx, spaceId, { limit: 100 });
    for (const stored of items.filter((r) => r.id === id || r.id === `${id}-old`)) {
      expect(stored).not.toHaveProperty('detail');
    }
    const raw = await testDb
      .prepare('SELECT detail FROM audit_log WHERE id = ?')
      .bind(id)
      .first<{ detail: string | null }>();
    expect(raw?.detail).toBeNull();
  });

  it('keeps a sentinel in a field out of the column itself', async () => {
    const id = await newEntry();
    const log = createChangeLog();
    await updateEntry(withChanges(ctx, log), scope, id, {
      title: { 'en-US': SENTINEL, [`x-${SENTINEL}`]: SENTINEL },
      hero: { 'en-US': { alt: SENTINEL } },
      data: { 'en-US': { [SENTINEL]: { token: SENTINEL } } },
    });
    const stored = await recordAudit(ctx, {
      spaceId,
      actor: 'usr_ada',
      action: 'PUT',
      targetId: id,
      status: 200,
      detail: log.detail(),
    });
    const raw = await testDb
      .prepare('SELECT detail FROM audit_log WHERE id = ?')
      .bind(stored.id)
      .first<{ detail: string }>();
    expect(raw?.detail).toContain('fields.data');
    expect(raw?.detail).not.toContain(SENTINEL);
  });

  it('stores a capped detail whole, and a row’s statement stays one', async () => {
    const paths = Array.from({ length: 2000 }, (_, i) => `fields.field${i}`);
    const counting = countingD1(testDb);
    const counted: AppContext = { store: createD1Store(counting.d1), clock, ids };
    let id = '';
    const log = await counting.measure(async () => {
      id = (
        await recordAudit(counted, {
          spaceId,
          actor: 'usr_ada',
          action: 'POST',
          status: 200,
          detail: {
            entries: [
              {
                entryId: 'e',
                contentType: 'article',
                kind: 'updated',
                version: 2,
                paths,
                locales: [],
              },
            ],
          },
        })
      ).id;
    });
    expect(log.statements).toBe(1);
    const raw = await testDb
      .prepare('SELECT detail FROM audit_log WHERE id = ?')
      .bind(id)
      .first<{ detail: string }>();
    expect(raw?.detail.length).toBeLessThanOrEqual(MAX_AUDIT_DETAIL_SIZE);
    expect(JSON.parse(raw?.detail ?? '{}')).toMatchObject({ truncated: true });
  });

  it('costs a save no statement: the diff reads nothing it hadn’t read', async () => {
    const counting = countingD1(testDb);
    const counted: AppContext = { store: createD1Store(counting.d1), clock, ids };
    const save = (c: AppContext, id: string) =>
      counting.measure(() =>
        updateEntry(c, scope, id, { title: { 'en-US': 'Again' } }).then(() => undefined),
      );
    const without = await save(counted, await newEntry());
    const withLog = await save(withChanges(counted, createChangeLog()), await newEntry());
    expect(withLog.statements).toBe(without.statements);
    expect(withLog.roundTrips).toBe(without.roundTrips);
  });
});
