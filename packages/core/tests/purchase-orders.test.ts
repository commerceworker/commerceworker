import { describe, expect, it } from 'vitest';
import {
  createPoDraftInput,
  decodePoCursor,
  encodePoCursor,
  ORDER_STATUSES,
  PO_LIFECYCLE,
  PO_STATUSES,
  type PoOrderProgress,
  type PoStatus,
  poDraftProblem,
  poEditable,
  poIdForOrder,
  poOrderMeta,
  poPath,
  poProgressOf,
  poTransitionFor,
  updatePoDraftInput,
} from '../src';

describe('the purchase order lifecycle', () => {
  it('moves along the lifecycle the plan names, and no other way', () => {
    expect(PO_LIFECYCLE.states).toEqual(PO_STATUSES);
    expect(PO_LIFECYCLE.next('draft')).toEqual(['submitted', 'cancelled']);
    expect(PO_LIFECYCLE.next('submitted')).toEqual([
      'pending_approval',
      'approved',
      'rejected',
      'cancelled',
    ]);
    expect(PO_LIFECYCLE.next('pending_approval')).toEqual(['approved', 'rejected', 'cancelled']);
    expect(PO_LIFECYCLE.next('approved')).toEqual(['ordered']);
    expect(PO_LIFECYCLE.next('ordered')).toEqual(['fulfilled', 'cancelled']);
    for (const end of ['rejected', 'fulfilled', 'cancelled'] as const)
      expect(PO_LIFECYCLE.terminal(end)).toBe(true);
    // An approved PO is cancelled only through its order, and nothing goes back to a draft.
    expect(PO_LIFECYCLE.can('approved', 'cancelled')).toBe(false);
    for (const s of PO_STATUSES) expect(PO_LIFECYCLE.can(s, 'draft')).toBe(false);
  });

  it('edits only a draft', () => {
    expect(PO_STATUSES.filter(poEditable)).toEqual(['draft']);
  });
});

describe('poTransitionFor', () => {
  const to = (p: PoOrderProgress, from: PoStatus) => poTransitionFor(p, from);

  it('says nothing for an order that is only starting or running', () => {
    for (const p of ['queued', 'running', 'waiting'] as const)
      for (const s of PO_STATUSES) expect(to(p, s)).toBeNull();
  });

  it('follows an approval wait, a cleared gate and the order finishing', () => {
    expect(to('awaiting_approval', 'submitted')).toBe('pending_approval');
    expect(to('proceeding', 'pending_approval')).toBe('ordered');
    expect(to('proceeding', 'submitted')).toBe('ordered');
    expect(to('completed', 'ordered')).toBe('fulfilled');
    expect(to('completed', 'submitted')).toBe('fulfilled');
  });

  it('turns a declined order into a rejection while the PO waits, and a cancellation after', () => {
    expect(to('declined', 'submitted')).toBe('rejected');
    expect(to('declined', 'pending_approval')).toBe('rejected');
    expect(to('declined', 'ordered')).toBe('cancelled');
    expect(to('declined', 'approved')).toBe('cancelled');
  });

  it('cancels the PO when its order is cancelled, fails or rolls back', () => {
    for (const p of ['cancelled', 'failed', 'rolled_back'] as const) {
      expect(to(p, 'ordered')).toBe('cancelled');
      expect(to(p, 'pending_approval')).toBe('cancelled');
      expect(to(p, 'submitted')).toBe('cancelled');
    }
  });

  it('never moves a PO backwards, off an end, or a draft', () => {
    expect(to('awaiting_approval', 'ordered')).toBeNull();
    expect(to('awaiting_approval', 'pending_approval')).toBeNull();
    expect(to('proceeding', 'ordered')).toBeNull();
    expect(to('proceeding', 'fulfilled')).toBeNull();
    expect(to('cancelled', 'fulfilled')).toBeNull();
    expect(to('completed', 'cancelled')).toBeNull();
    expect(to('declined', 'rejected')).toBeNull();
    for (const p of [...ORDER_STATUSES, 'awaiting_approval', 'proceeding'] as const)
      expect(to(p, 'draft')).toBeNull();
  });

  it('only ever heads where the lifecycle can reach', () => {
    for (const p of [...ORDER_STATUSES, 'awaiting_approval', 'proceeding'] as const)
      for (const s of PO_STATUSES) {
        const t = to(p, s);
        if (t) expect(PO_LIFECYCLE.reachable(s).has(t)).toBe(true);
      }
  });
});

describe('poPath', () => {
  it('walks every state in between, never skipping one', () => {
    expect(poPath('submitted', 'ordered')).toEqual(['approved', 'ordered']);
    expect(poPath('submitted', 'fulfilled')).toEqual(['approved', 'ordered', 'fulfilled']);
    expect(poPath('pending_approval', 'ordered')).toEqual(['approved', 'ordered']);
    expect(poPath('approved', 'cancelled')).toEqual(['ordered', 'cancelled']);
    expect(poPath('draft', 'cancelled')).toEqual(['cancelled']);
  });

  it('is empty at the target and where there is no way', () => {
    expect(poPath('ordered', 'ordered')).toEqual([]);
    expect(poPath('fulfilled', 'cancelled')).toEqual([]);
    expect(poPath('ordered', 'approved')).toEqual([]);
    expect(poPath('cancelled', 'draft')).toEqual([]);
  });
});

describe('poDraftProblem', () => {
  const draft = { companyId: 'acme', buyerId: 'm1' as string | null, lines: [{}] };
  const ok = {
    company: { status: 'active' as const },
    buyer: { companyId: 'acme', status: 'active' as const },
    duplicate: false,
  };

  it('passes a draft with lines, an active company and an active buyer of it', () => {
    expect(poDraftProblem(draft, ok)).toBeNull();
    // A PO that names no buyer needs none.
    expect(poDraftProblem({ ...draft, buyerId: null }, { ...ok, buyer: undefined })).toBeNull();
  });

  it('refuses a draft with no lines before anything else', () => {
    expect(poDraftProblem({ ...draft, lines: [] }, { ...ok, duplicate: true })).toMatch(
      /at least one line/,
    );
  });

  it('refuses a number the company already has', () => {
    expect(poDraftProblem(draft, { ...ok, duplicate: true })).toMatch(/has that number/);
  });

  it('refuses a company that is missing or not active', () => {
    expect(poDraftProblem(draft, { ...ok, company: undefined })).toMatch(/isn't a company/);
    for (const status of ['pending', 'suspended', 'rejected', 'closed'] as const)
      expect(poDraftProblem(draft, { ...ok, company: { status } })).toMatch(
        new RegExp(`isn't active \\(${status}\\)`),
      );
  });

  it('refuses a buyer who is missing, inactive or another company’s', () => {
    expect(poDraftProblem(draft, { ...ok, buyer: undefined })).toMatch(/isn't an active member/);
    for (const status of ['invited', 'inactive', 'removed'] as const)
      expect(poDraftProblem(draft, { ...ok, buyer: { companyId: 'acme', status } })).toMatch(
        /isn't an active member/,
      );
    expect(
      poDraftProblem(draft, { ...ok, buyer: { companyId: 'globex', status: 'active' } }),
    ).toMatch(/isn't an active member/);
  });
});

describe('the inputs and helpers', () => {
  const line = { sku: 'W-1', qty: 2 };

  it('reads a draft and trims its number', () => {
    const parsed = createPoDraftInput.parse({
      companyId: 'acme',
      poNumber: '  PO-9 ',
      lines: [line],
    });
    expect(parsed.poNumber).toBe('PO-9');
    expect(
      createPoDraftInput.safeParse({ companyId: 'acme', poNumber: 'x', lines: [] }).success,
    ).toBe(false);
    expect(
      createPoDraftInput.safeParse({ companyId: 'acme', poNumber: '', lines: [line] }).success,
    ).toBe(false);
    expect(
      createPoDraftInput.safeParse({
        companyId: 'acme',
        poNumber: 'x',
        lines: [{ sku: 'a', qty: 0 }],
      }).success,
    ).toBe(false);
  });

  it('takes any subset of a draft’s fields on update, and a whole new line list', () => {
    expect(updatePoDraftInput.safeParse({ poId: 'po_1' }).success).toBe(true);
    expect(updatePoDraftInput.safeParse({ poId: 'po_1', lines: [] }).success).toBe(false);
    expect(updatePoDraftInput.safeParse({ poId: 'po_1', notes: null, shipTo: null }).success).toBe(
      true,
    );
  });

  it('round-trips its cursor and rejects anything else', () => {
    const c = { at: 1_700_000_000_000, id: 'po_1' };
    expect(decodePoCursor(encodePoCursor(c))).toEqual(c);
    expect(decodePoCursor('not a cursor')).toBeUndefined();
    expect(decodePoCursor(btoa(JSON.stringify(['x', 1])))).toBeUndefined();
  });

  it('names an order’s PO from its id, and carries the number into its meta', () => {
    expect(poIdForOrder('ord_abc123')).toBe('po_abc123');
    expect(
      poOrderMeta({
        poNumber: 'PO-9',
        buyerId: 'm1',
        shipTo: null,
        notes: 'Rush',
      }),
    ).toEqual({ poNumber: 'PO-9', buyerId: 'm1', notes: 'Rush' });
    expect(poOrderMeta({ poNumber: 'PO-9', buyerId: null, shipTo: null, notes: null })).toEqual({
      poNumber: 'PO-9',
    });
  });
});

describe('poProgressOf', () => {
  const state = (
    status: (typeof ORDER_STATUSES)[number],
    nodes: Record<string, 'pending' | 'succeeded' | 'skipped' | 'waiting' | 'failed'> = {},
    approval = false,
    branch = 'approved',
  ) => ({
    status,
    waits: approval ? [{ kind: 'approval' as const }] : [],
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([id, s]) => [id, { status: s, branches: [branch] }]),
    ),
  });

  it('is the order’s status once it has finished', () => {
    for (const s of ['completed', 'declined', 'cancelled', 'failed', 'rolled_back'] as const)
      expect(poProgressOf(state(s), ['gate'])).toBe(s);
  });

  it('is awaiting_approval while an approval wait is open', () => {
    expect(poProgressOf(state('waiting', { gate: 'waiting' }, true), ['gate'])).toBe(
      'awaiting_approval',
    );
  });

  it('is proceeding once every approval node is decided or skipped, and not before', () => {
    expect(poProgressOf(state('running', { gate: 'pending' }), ['gate'])).toBeNull();
    expect(poProgressOf(state('running', {}), ['gate'])).toBeNull();
    expect(poProgressOf(state('running', { gate: 'succeeded' }), ['gate'])).toBe('proceeding');
    expect(poProgressOf(state('running', { gate: 'skipped' }), ['gate'])).toBe('proceeding');
    expect(poProgressOf(state('running', { a: 'succeeded', b: 'pending' }), ['a', 'b'])).toBeNull();
    // A wait on something else (an event) after the gates are decided is still going ahead.
    expect(poProgressOf(state('waiting', { gate: 'succeeded' }), ['gate'])).toBe('proceeding');
  });

  it('is not proceeding past a gate that was rejected or timed out', () => {
    for (const branch of ['rejected', 'escalated'])
      expect(
        poProgressOf(state('running', { gate: 'succeeded' }, false, branch), ['gate']),
      ).toBeNull();
  });

  it('is proceeding at once for a flow with no approval, and nothing while queued', () => {
    expect(poProgressOf(state('running'), [])).toBe('proceeding');
    expect(poProgressOf(state('queued'), [])).toBeNull();
  });
});
