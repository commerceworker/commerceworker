import { auditRow, sealAuditRow, verifyAuditChain } from '@commerceworker/core';
import type { AdminAuditLog } from '@commerceworker/ports';
import type { AuditEvent } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

const event = (id: string, action = 'auth.sign_in', at = 1000) => auditRow(id, action, {}, at);
export function describeAdminAuditLogContract(
  name: string,
  make: (seed?: AuditEvent[]) => Promise<AdminAuditLog>,
) {
  describe(`${name}: Studio audit storage`, () => {
    it('retries racing appends into one chain and refuses duplicate ids', async () => {
      const log = await make();
      await Promise.all(
        ['a', 'b', 'c', 'd'].map((id) => log.append((head) => sealAuditRow(event(id), head))),
      );
      const rows = await log.sealedAfter(undefined, 10);
      expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
      expect(await verifyAuditChain(rows)).toMatchObject({ ok: true, checked: 4 });
      await expect(log.append((head) => sealAuditRow(event('a'), head))).rejects.toThrow();
      expect(await log.link(4)).toEqual({ seq: 4, hash: rows[3]!.hash });
      expect(await log.link(999)).toBeUndefined();
    });
    it('pages tied timestamps by id without repeats and keeps group filters', async () => {
      const log = await make();
      for (const id of ['a', 'b', 'c', 'd', 'e'])
        await log.append((head) =>
          sealAuditRow(event(id, id === 'c' ? 'team.user_added' : 'auth.sign_in'), head),
        );
      const seen: string[] = [];
      let cursor: { before: number; beforeId: string } | undefined;
      for (;;) {
        const rows = await log.list({ ...cursor, group: 'auth', limit: 2 });
        seen.push(...rows.map((r) => r.id));
        const last = rows.at(-1);
        if (rows.length < 2 || !last) break;
        cursor = { before: last.at, beforeId: last.id };
      }
      expect(seen).toEqual(['e', 'd', 'b', 'a']);
      expect(await log.list({ before: 1000, limit: 10 })).toEqual([]);
    });
    it('pages forward by sequence rather than event time', async () => {
      const log = await make();
      for (const [id, at] of [
        ['a', 3000],
        ['b', 2000],
        ['c', 1000],
      ] as const)
        await log.append((head) => sealAuditRow(event(id, 'auth.sign_in', at), head));
      expect((await log.list({ after: 1, limit: 10 })).map((r) => r.id)).toEqual(['b', 'c']);
      expect((await log.sealedAfter(1, 1)).map((r) => r.id)).toEqual(['b']);
    });
    it('keeps legacy rows readable and malformed sealed rows visible to verification', async () => {
      const legacy = { ...event('legacy'), seq: null, prevHash: null, hash: null };
      const malformed = { ...event('malformed'), seq: 1, prevHash: 'genesis', hash: null };
      const log = await make([legacy, malformed]);
      expect(await log.list({ limit: 10 })).toHaveLength(2);
      expect(await log.sealedAfter(undefined, 10)).toEqual([malformed]);
      expect(await log.link(1)).toBeUndefined();
    });
    it('matches action group prefixes literally, including SQL wildcard characters', async () => {
      const log = await make();
      await log.append((head) => sealAuditRow(event('literal', 'auth%key.saved'), head));
      await log.append((head) => sealAuditRow(event('other', 'authXkey.saved'), head));
      expect((await log.list({ group: 'auth%key', limit: 10 })).map((r) => r.id)).toEqual([
        'literal',
      ]);
    });
  });
}
