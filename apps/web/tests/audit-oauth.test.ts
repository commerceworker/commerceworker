import { describe, expect, it, vi } from 'vitest';

type Row = { actor: string | null; detail: string | null };
const detailOf = (r: Row) => JSON.parse(r.detail ?? 'null');
const rows: Row[] = [];
vi.mock('~/lib/wire.server', () => ({
  auditLog: () => ({
    append: async (seal: (head: null) => Promise<Row>) => {
      const row = await seal(null);
      rows.push(row);
      return row;
    },
  }),
}));

const { audit } = await import('~/lib/audit.server');
const request = new Request('https://app.test/api/v1/orders');
const ann = { kind: 'user', id: 'usr_1', name: 'Ann', email: 'ann@example.com', role: 'operator' };

describe('the audit trail of a REST call', () => {
  it('names the grant and client of an OAuth app, and only of one', async () => {
    rows.length = 0;
    await audit(request, 'order.started', {
      actor: { ...ann, grant: 'grant_1', client: 'client_1' },
      detail: { flowId: 'f1', via: 'api' },
    });
    await audit(request, 'order.started', { actor: ann, detail: { flowId: 'f1', via: 'api' } });
    expect(rows[0]!.actor).toBe('ann@example.com');
    expect(detailOf(rows[0]!)).toEqual({
      flowId: 'f1',
      via: 'api',
      grant: 'grant_1',
      client: 'client_1',
    });
    expect(detailOf(rows[1]!)).toEqual({ flowId: 'f1', via: 'api' });
  });

  it('names a grant even when the event had no detail', async () => {
    rows.length = 0;
    await audit(request, 'cart.canceled', { actor: { ...ann, grant: 'grant_1' } });
    expect(detailOf(rows[0]!)).toEqual({ grant: 'grant_1' });
  });
});
