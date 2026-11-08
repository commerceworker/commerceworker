import { adminAudit } from '@commerceworker/store/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authTestDb } from './auth-db';

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('~/lib/env.server', () => ({ db: () => state.db }));

const { listAudit } = await import('~/lib/audit.server');

const event = (id: string, at: number, action = 'auth.sign_in') => ({ id, at, action });

/** Follows the same cursor the route's Older link carries, until a page comes back short. */
async function walk(limit: number, group?: 'auth' | 'team') {
  const seen: string[] = [];
  let cursor: { before: number; beforeId: string } | undefined;
  for (;;) {
    const page = await listAudit({ group, limit, ...cursor });
    seen.push(...page.map((row) => row.id));
    const last = page.at(-1);
    if (page.length < limit || !last) return seen;
    cursor = { before: last.at, beforeId: last.id };
  }
}

describe('paging the admin audit log', () => {
  let db: ReturnType<typeof authTestDb>['db'];

  beforeEach(() => {
    ({ db } = authTestDb());
    state.db = db;
  });

  it('keeps every row when a millisecond spans a page edge', async () => {
    await db
      .insert(adminAudit)
      .values([
        event('aud_a', 2000),
        event('aud_b', 1000),
        event('aud_c', 1000),
        event('aud_d', 1000),
        event('aud_e', 1000),
        event('aud_f', 500),
      ]);

    expect(await walk(2)).toEqual(['aud_a', 'aud_e', 'aud_d', 'aud_c', 'aud_b', 'aud_f']);
  });

  it('pages through a millisecond larger than a page, without repeats', async () => {
    await db
      .insert(adminAudit)
      .values(['aud_a', 'aud_b', 'aud_c', 'aud_d', 'aud_e'].map((id) => event(id, 1000)));

    expect(await walk(2)).toEqual(['aud_e', 'aud_d', 'aud_c', 'aud_b', 'aud_a']);
  });

  it('keeps the cursor inside a group', async () => {
    await db
      .insert(adminAudit)
      .values([
        event('aud_a', 1000, 'team.user_added'),
        event('aud_b', 1000, 'auth.sign_in'),
        event('aud_c', 1000, 'team.user_added'),
        event('aud_d', 1000, 'team.role_changed'),
      ]);

    expect(await walk(2, 'team')).toEqual(['aud_d', 'aud_c', 'aud_a']);
  });

  it('still reads a link that carries only a time', async () => {
    await db
      .insert(adminAudit)
      .values([event('aud_a', 2000), event('aud_b', 1000), event('aud_c', 500)]);

    const page = await listAudit({ before: 2000 });

    expect(page.map((row) => row.id)).toEqual(['aud_b', 'aud_c']);
  });

  it('leaves the sealed-event cursor oldest first', async () => {
    await db.insert(adminAudit).values([
      { ...event('aud_a', 3000), seq: 1, prevHash: 'genesis', hash: 'h1' },
      { ...event('aud_b', 2000), seq: 2, prevHash: 'h1', hash: 'h2' },
      { ...event('aud_c', 1000), seq: 3, prevHash: 'h2', hash: 'h3' },
    ]);

    const page = await listAudit({ after: 1 });

    expect(page.map((row) => row.id)).toEqual(['aud_b', 'aud_c']);
  });
});
