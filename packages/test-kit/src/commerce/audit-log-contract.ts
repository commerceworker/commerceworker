/**
 * The behaviour every `AuditLog` keeps: the in-memory log runs it in node and the D1 store in
 * workerd (packages/db). The chain is the log's own, so a case reads it from the events it appended.
 */
import { auditRow, sealAuditRow } from '@commerceworker/core';
import type { AuditLog } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

export function describeAuditLogContract(name: string, make: () => Promise<AuditLog>) {
  describe(`${name}: the audit log contract`, () => {
    const event = (id: string, action = 'flow.saved', at?: number) =>
      auditRow(id, action, { actor: { kind: 'operator', name: 'test' } as never, target: id }, at);

    it('chains each event onto the one before, even when writers race', async () => {
      const log = await make();
      const first = await log.append((head) => sealAuditRow(event('al_1'), head));
      const raced = await Promise.all(
        ['al_2', 'al_3', 'al_4'].map((id) => log.append((head) => sealAuditRow(event(id), head))),
      );
      const seqs = [first, ...raced].map((e) => e.seq).sort((a, b) => a - b);
      expect(new Set(seqs).size).toBe(4);
      expect(seqs.at(-1)! - seqs[0]!).toBe(3);
      const byId = new Map([first, ...raced].map((e) => [e.seq, e]));
      for (const e of raced) expect(e.prevHash).toBe(byId.get(e.seq - 1)!.hash);
    });

    it('lists newest first by group and time, pages sealed events after a seq, and reads a link', async () => {
      const log = await make();
      const T = 9_000_000_000_000;
      const a = await log.append((h) => sealAuditRow(event('al_a', 'flow.saved', T + 1), h));
      const b = await log.append((h) => sealAuditRow(event('al_b', 'team.user_added', T + 2), h));
      const c = await log.append((h) => sealAuditRow(event('al_c', 'flow.published', T + 3), h));
      const mine = <E extends { id: string }>(xs: E[]) => xs.filter((x) => x.id.startsWith('al_'));
      expect(
        mine(await log.list({ limit: 500 }))
          .map((e) => e.id)
          .slice(0, 3),
      ).toEqual(['al_c', 'al_b', 'al_a']);
      expect(mine(await log.list({ group: 'flow', limit: 500 })).map((e) => e.id)).toEqual(
        expect.arrayContaining(['al_c', 'al_a']),
      );
      expect(mine(await log.list({ group: 'flow', limit: 500 })).some((e) => e.id === 'al_b')).toBe(
        false,
      );
      expect(mine(await log.list({ before: T + 3, limit: 500 }))[0]?.id).toBe('al_b');
      const after = await log.list({ after: a.seq, limit: 500 });
      expect(after.map((e) => e.seq)).toEqual([b.seq, c.seq]);
      expect((await log.sealedAfter(a.seq, 1)).map((e) => e.id)).toEqual(['al_b']);
      expect((await log.sealedAfter(b.seq, 10)).map((e) => e.id)).toEqual(['al_c']);
      expect(await log.link(b.seq)).toEqual({ seq: b.seq, hash: b.hash });
      expect(await log.link(c.seq + 100)).toBeUndefined();
    });
  });
}
