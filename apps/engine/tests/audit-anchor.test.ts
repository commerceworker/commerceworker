import { env } from 'cloudflare:workers';
import { auditRow, sealAuditRow } from '@commerceworker/core';
import { describe, expect, it } from 'vitest';
import { anchorAuditChain, copyAuditEvents, sweep } from '../src/retention';
import { auditAnchors, auditLog } from '../src/wire';

const T = Date.UTC(2031, 0, 2, 7, 15);

async function seal(id: string) {
  const row = auditRow(id, 'flow.saved', { target: id }, T);
  return auditLog(env).append((h) => sealAuditRow(row, h));
}

describe('audit anchors and copies in R2', () => {
  it('anchors the chain head once an hour under the locked audit/ prefix', async () => {
    const head = await seal('aud_anchor_1');
    const anchor = await anchorAuditChain(env, T);
    expect(anchor).toMatchObject({ seq: head.seq, hash: head.hash, eventId: 'aud_anchor_1' });
    const stored = await env.DOCS.get('audit/anchors/2031-01-02/07.json');
    expect(await stored?.json()).toEqual(anchor);

    // Write-once: a newer head in the same hour leaves the first anchor as it was.
    await seal('aud_anchor_2');
    expect(await anchorAuditChain(env, T + 60_000)).toBeNull();
    expect(await (await env.DOCS.get('audit/anchors/2031-01-02/07.json'))?.json()).toEqual(anchor);
    expect(await auditAnchors(env).latest(T + 60_000)).toEqual(anchor);

    // The next hour's anchor names the newer head.
    expect(await anchorAuditChain(env, T + 3_600_000)).toMatchObject({ eventId: 'aud_anchor_2' });
  });

  it('copies new events daily, ahead of their retention, and does not copy them twice', async () => {
    const first = await seal('aud_copy_1');
    const copied = await copyAuditEvents(env);
    expect(copied).toBeGreaterThanOrEqual(1);
    const listed = await env.DOCS.list({ prefix: 'audit/chain/' });
    const last = listed.objects.at(-1)!;
    const lines = (await (await env.DOCS.get(last.key))!.text()).trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).id)).toContain('aud_copy_1');
    expect(JSON.parse(lines.at(-1)!).seq).toBeGreaterThanOrEqual(first.seq);
    expect(await copyAuditEvents(env)).toBe(0);
    // The sweep reports it, and the events are still in the database.
    expect((await sweep(env)).auditCopied).toBe(0);
    expect(await auditLog(env).link(first.seq)).toEqual({ seq: first.seq, hash: first.hash });
  });
});
