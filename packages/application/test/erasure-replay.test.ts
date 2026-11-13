import {
  auditCopyKey,
  auditRow,
  EMPTY_ORDER_STATE,
  eraseOrderState,
  type OrderState,
  sealAuditRow,
  subjectTarget,
} from '@commerceworker/core';
import {
  InMemoryAuditArchive,
  InMemoryAuditLog,
  InMemoryShopperAuth,
  InMemorySubjectStore,
  InMemoryUcpLinks,
  SUBJECT_FIXTURE,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  REPLAY_ORDERS_MAX,
  REPLAY_ROUNDS,
  type ReplayPorts,
  replayErasures,
  replayReminder,
} from '../src/commerce';

const now = Date.UTC(2026, 10, 12);
/** The restore point; Ada was erased after it, Grace before it. */
const SINCE = 1_000;
const ADA_AT = 2_000;

/** Ada's order that is running in SUBJECT_FIXTURE has ended, so she can be erased. */
const fixture = (orders?: { id: string; createdAt: number }[]) => ({
  ...SUBJECT_FIXTURE,
  orders: SUBJECT_FIXTURE.orders!.map((o) => ({
    ...o,
    status: o.id === 'sc2_o_mail' ? 'completed' : o.status,
    createdAt: orders?.find((x) => x.id === o.id)?.createdAt ?? 0,
  })),
});

const erasedEvent = async (email: string, at: number, id = `aud_${at}`) =>
  auditRow(id, 'personal_data.erased', { target: await subjectTarget(email) }, at);

async function setup(
  opts: {
    fixture?: ReturnType<typeof fixture>;
    running?: string[];
    /** What each order's agent holds, as a restore left it. */
    states?: Record<string, OrderState>;
  } = {},
) {
  const states = opts.states ?? {};
  const audit = new InMemoryAuditLog();
  const archive = new InMemoryAuditArchive();
  const deleted: string[] = [];
  const running = new Set(opts.running ?? []);
  const subjects = new InMemorySubjectStore(opts.fixture ?? fixture());
  const ports: ReplayPorts = {
    subjects,
    audit,
    archive,
    shoppers: new InMemoryShopperAuth(),
    links: new InMemoryUcpLinks(),
    files: {
      // As R2 does: a prefix with nothing under it deletes nothing.
      deletePrefix: async (prefix) => {
        if (deleted.includes(prefix)) return 0;
        deleted.push(prefix);
        return 1;
      },
    },
    orders: {
      snapshot: async (id) => states[id] ?? ({ ...EMPTY_ORDER_STATE } as OrderState),
      erasePersonalData: async (id) => {
        if (running.has(id)) return null;
        if (states[id]) states[id] = eraseOrderState(states[id], []);
        return { held: true, title: 'Erased' };
      },
    },
    carts: {
      subjectExport: async (id) => ({ id }),
      customerExport: async (id) => ({ id }),
      // The cart agent clears the buyer from its index row, so a second erasure doesn't find it.
      eraseSubject: async (id) => {
        const f = (
          subjects as unknown as { f: { carts: { id: string; buyerId: string | null }[] } }
        ).f;
        for (const c of f.carts) if (c.id === id) c.buyerId = '';
      },
      eraseShipTo: async () => true,
      eraseFromEvents: async () => undefined,
    },
  };
  const log = async (email: string, at: number) => {
    await audit.append(async (head) => sealAuditRow(await erasedEvent(email, at), head));
  };
  /** A daily copy of the chain, as `copyAudit` writes it. */
  const copy = async (rows: Awaited<ReturnType<typeof erasedEvent>>[]) => {
    const sealed = [];
    let head = null;
    for (const r of rows) {
      const s = await sealAuditRow(r, head);
      sealed.push(s);
      head = { seq: s.seq, hash: s.hash };
    }
    await archive.put(
      auditCopyKey(sealed[0]!.seq, sealed.at(-1)!.seq, sealed.at(-1)!.hash),
      sealed,
    );
  };
  return { ports, audit, archive, subjects, deleted, running, states, log, copy };
}

describe('replaying erasures after a restore', () => {
  it('erases again each person erased since the restore point, and not those before it', async () => {
    const { ports, log, deleted } = await setup();
    await log('ada@example.com', ADA_AT);
    await log('grace@example.com', 500);
    const r = await replayErasures(ports, { since: SINCE }, now);
    expect(r).toMatchObject({
      since: SINCE,
      dryRun: false,
      events: { total: 1, database: 1, archive: 0 },
      blocked: [],
      clean: [],
    });
    expect(r.erased).toEqual([
      expect.objectContaining({
        target: await subjectTarget('ada@example.com'),
        at: ADA_AT,
        recorded: true,
        done: true,
        orders: 3,
        customers: 1,
        taxCertificates: 1,
        addresses: 1,
      }),
    ]);
    // Her files went, and Grace (erased before the restore point) was left as she is.
    expect(deleted).toContain('orders/sc2_o_acct/');
    expect((await ports.subjects.subject('ada@example.com')).accounts).toEqual([]);
    expect((await ports.subjects.subject('grace@example.com')).accounts).toHaveLength(1);
    // Nothing in the result names an address.
    expect(JSON.stringify(r)).not.toMatch(/ada@|grace@|charles@/);
  });

  it('changes nothing the second time', async () => {
    const { ports, log, deleted } = await setup();
    await log('ada@example.com', ADA_AT);
    expect((await replayErasures(ports, { since: SINCE }, now)).erased).toHaveLength(1);
    const files = deleted.length;
    const again = await replayErasures(ports, { since: SINCE }, now);
    expect(again.erased).toEqual([]);
    // Nobody the stores hold is left: she is clean, and nothing was erased or deleted again.
    expect(again.clean).toEqual([await subjectTarget('ada@example.com')]);
    expect(deleted).toHaveLength(files);
  });

  it('reads the R2 copies when the database’s log lacks the events, as after a restore', async () => {
    const { ports, copy, deleted } = await setup();
    // The restore took Ada's erasure out of the database; the nightly copy still has it.
    await copy([await erasedEvent('ada@example.com', ADA_AT)]);
    const r = await replayErasures(ports, { since: SINCE }, now);
    expect(r.events).toEqual({ total: 1, database: 0, archive: 1 });
    expect(r.erased).toMatchObject([{ at: ADA_AT, recorded: false, orders: 3 }]);
    expect(deleted).toContain('orders/sc2_o_acct/');
  });

  it('counts a person once when both the database and a copy hold the event', async () => {
    const { ports, log, copy } = await setup();
    await log('ada@example.com', ADA_AT);
    await copy([await erasedEvent('ada@example.com', ADA_AT, 'aud_other')]);
    const r = await replayErasures(ports, { since: SINCE }, now);
    expect(r.events).toEqual({ total: 1, database: 1, archive: 0 });
    expect(r.erased).toMatchObject([{ recorded: true }]);
  });

  it('reads every page of the log, and ignores other personal data events', async () => {
    const { ports, audit } = await setup();
    // More newer events than a page, so Ada's is on the second.
    for (let i = 0; i < 520; i++)
      await audit.append(async (head) =>
        sealAuditRow(
          auditRow(
            `aud_x${i}`,
            'personal_data.exported',
            { target: `subject:${i}` },
            ADA_AT + 10 + i,
          ),
          head,
        ),
      );
    await audit.append(async (head) =>
      sealAuditRow(await erasedEvent('ada@example.com', ADA_AT), head),
    );
    const r = await replayErasures(ports, { since: SINCE }, now);
    expect(r.events.total).toBe(1);
    expect(r.erased).toHaveLength(1);
  });

  it('with dryRun reports who would be erased and erases nobody', async () => {
    const { ports, log, deleted } = await setup();
    await log('ada@example.com', ADA_AT);
    const dry = await replayErasures(ports, { since: SINCE, dryRun: true }, now);
    expect(dry.dryRun).toBe(true);
    expect(dry.erased).toMatchObject([{ orders: 3, customers: 1, done: true }]);
    expect(deleted).toEqual([]);
    expect((await ports.subjects.subject('ada@example.com')).accounts).toHaveLength(1);
    // Still there to erase for real.
    expect((await replayErasures(ports, { since: SINCE }, now)).erased).toMatchObject([
      { orders: 3 },
    ]);
  });

  it('names a person whose orders are still running and erases nothing of theirs', async () => {
    const { ports, log, deleted } = await setup({
      fixture: { ...fixture(), orders: SUBJECT_FIXTURE.orders },
    });
    await log('ada@example.com', ADA_AT);
    const r = await replayErasures(ports, { since: SINCE }, now);
    expect(r.erased).toEqual([]);
    expect(r.blocked).toEqual([
      {
        target: await subjectTarget('ada@example.com'),
        reason: 'active_orders',
        orders: ['sc2_o_mail'],
      },
    ]);
    expect(deleted).toEqual([]);
    expect((await ports.subjects.subject('ada@example.com')).accounts).toHaveLength(1);
  });

  it('leaves alone a person who ordered again after they were erased', async () => {
    const { ports, log, deleted } = await setup({
      fixture: fixture([{ id: 'sc2_o_guest', createdAt: ADA_AT + 1 }]),
    });
    await log('ada@example.com', ADA_AT);
    const r = await replayErasures(ports, { since: SINCE }, now);
    expect(r.erased).toEqual([]);
    expect(r.blocked).toEqual([
      {
        target: await subjectTarget('ada@example.com'),
        reason: 'ordered_since',
        orders: ['sc2_o_guest'],
      },
    ]);
    expect(deleted).toEqual([]);
  });

  it('calls a person the stores hold nothing about clean', async () => {
    const { ports, log } = await setup();
    await log('nobody@example.com', ADA_AT);
    const r = await replayErasures(ports, { since: SINCE }, now);
    expect(r.erased).toEqual([]);
    expect(r.clean).toEqual([await subjectTarget('nobody@example.com')]);
    expect(r.scanned).toBeGreaterThan(0);
  });

  it('reads nothing of the stores when nobody was erased since', async () => {
    const { ports, log } = await setup();
    await log('ada@example.com', ADA_AT);
    const r = await replayErasures(ports, { since: ADA_AT + 1 }, now);
    expect(r).toMatchObject({
      events: { total: 0 },
      scanned: 0,
      erased: [],
      blocked: [],
      clean: [],
    });
  });

  it('keeps going through a person’s orders up to its rounds, then says it is not done', async () => {
    const orders = Array.from({ length: 101 }, (_, i) => ({
      id: `sc2_bulk_${i}`,
      title: 'Bulk',
      status: 'completed',
      contactEmail: 'bulk@example.com',
      customerId: null,
    }));
    const { ports, log } = await setup({ fixture: { customers: [], orders } });
    await log('bulk@example.com', ADA_AT);
    const r = await replayErasures(ports, { since: SINCE }, now);
    // 100 an erasure, so two rounds finish 101 orders.
    expect(r.erased).toMatchObject([{ orders: 101, done: true }]);
    expect(REPLAY_ROUNDS).toBeGreaterThanOrEqual(2);
  });
});

describe('the reminder a restore leaves', () => {
  it('names the time and the command that finishes the restore', () => {
    expect(replayReminder('2026-11-12')).toBe(
      'People erased after 2026-11-12 are still in this copy: after restoring or promoting it, run `node scripts/fleet.ts replay-erasures <id> 2026-11-12`.',
    );
  });
});

/** An order's agent as a restore left it: the buyer's contact and ship-to are back. */
const restoredState = (id: string, status: OrderState['status'] = 'completed') =>
  ({
    ...EMPTY_ORDER_STATE,
    orderId: id,
    status,
    order: {
      id,
      title: 'Ada Lovelace’s order',
      contact: { name: 'Ada Lovelace', email: 'ada@example.com' },
      lines: [],
      meta: { shipTo: { name: 'Ada Lovelace', line1: '1 Dock Rd' } },
    },
  }) as unknown as OrderState;

describe('replaying the orders already marked erased', () => {
  const marked = async (ids: string[], states: Record<string, OrderState>, running?: string[]) => {
    const t = await setup({ states, running });
    for (const [i, id] of ids.entries())
      await t.subjects.markOrderErased(id, { title: 'Erased', clearReason: true }, ADA_AT + i);
    return t;
  };

  it('erases again an order whose agent and files a restore brought back, then leaves it be', async () => {
    const { ports, states, deleted } = await marked(['sc2_o_acct'], {
      sc2_o_acct: restoredState('sc2_o_acct'),
    });
    // No audit event at all: the retention sweep erases orders without one.
    const r = await replayErasures(ports, { since: SINCE }, now);
    expect(r.events.total).toBe(0);
    expect(r.orders).toEqual({ checked: 1, erased: 1, documents: 1, running: [] });
    expect(states.sc2_o_acct!.order?.contact).toBeUndefined();
    expect(JSON.stringify(states.sc2_o_acct)).not.toMatch(/Ada Lovelace|ada@/);
    expect(deleted).toEqual(['orders/sc2_o_acct/']);
    // The second time the agent holds nothing and the folder is empty.
    expect((await replayErasures(ports, { since: SINCE }, now)).orders).toEqual({
      checked: 1,
      erased: 0,
      documents: 0,
      running: [],
    });
  });

  it('skips orders erased before the restore point', async () => {
    const t = await setup({ states: { sc2_o_acct: restoredState('sc2_o_acct') } });
    await t.subjects.markOrderErased('sc2_o_acct', { title: 'Erased', clearReason: true }, 500);
    expect((await replayErasures(t.ports, { since: SINCE }, now)).orders.checked).toBe(0);
    expect(t.deleted).toEqual([]);
  });

  it('with dryRun counts what an agent still holds and touches nothing', async () => {
    const { ports, states, deleted } = await marked(['sc2_o_acct'], {
      sc2_o_acct: restoredState('sc2_o_acct'),
    });
    const r = await replayErasures(ports, { since: SINCE, dryRun: true }, now);
    expect(r.orders).toEqual({ checked: 1, erased: 1, documents: 0, running: [] });
    expect(states.sc2_o_acct!.order?.contact).toBeDefined();
    expect(deleted).toEqual([]);
  });

  it('names an order the restore left running, and leaves its files for when it ends', async () => {
    const { ports, deleted } = await marked(
      ['sc2_o_acct'],
      { sc2_o_acct: restoredState('sc2_o_acct', 'running') },
      ['sc2_o_acct'],
    );
    const r = await replayErasures(ports, { since: SINCE }, now);
    expect(r.orders).toEqual({ checked: 1, erased: 0, documents: 0, running: ['sc2_o_acct'] });
    expect(deleted).toEqual([]);
  });

  it('says where to go on when more orders were erased since than one replay checks', async () => {
    const orders = Array.from({ length: REPLAY_ORDERS_MAX + 1 }, (_, i) => ({
      id: `sc2_bulk_${i}`,
      title: 'Bulk',
      status: 'completed',
      contactEmail: null,
      customerId: null,
    }));
    const t = await setup({ fixture: { orders } });
    for (const [i, o] of orders.entries())
      await t.subjects.markOrderErased(o.id, { title: 'Erased', clearReason: true }, 10_000 + i);
    const r = await replayErasures(t.ports, { since: SINCE }, now);
    expect(r.orders.checked).toBe(REPLAY_ORDERS_MAX);
    // One past the last order checked: the next run starts with the one left.
    expect(r.orders.nextSince).toBe(10_000 + REPLAY_ORDERS_MAX - 1 + 1);
    const next = await replayErasures(t.ports, { since: r.orders.nextSince! }, now);
    expect(next.orders).toMatchObject({ checked: 1 });
    expect(next.orders.nextSince).toBeUndefined();
  });
});
