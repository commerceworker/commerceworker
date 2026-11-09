/**
 * The behaviour every `OrderBoard` keeps: the in-memory store runs it in node and the D1 store in
 * workerd (packages/db). `make` seeds a fresh store holding only the fixture's rows. Ids start
 * `ob_`.
 */
import type { OrderBoard } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { BoardOrder, OrderBoardFixture } from './order-board';

const DAY = 86_400_000;
const NOW = 100 * DAY;

const FLOW = { id: 'ob_flow', name: 'Buy' };
const VERSION = {
  flowId: 'ob_flow',
  version: 1,
  nodes: [
    { id: 'mgr', label: 'Manager approval' },
    { id: 'fin', label: 'Finance approval' },
  ],
};

/**
 * An order on version `version` of the flow, waiting at its manager's approval since `at` (due
 * 10ms later), with one approval at `node`. A recorded order (`run` false) has no Workflow.
 */
function asked(
  id: string,
  at: number,
  { status = 'pending', node = 'mgr', version = 1, run = true } = {},
): OrderBoardFixture {
  return {
    orders: [
      {
        id: `ob_${id}`,
        model: 'procurement',
        status: 'waiting',
        flowVersion: version,
        instanceId: run ? `ob_${id}-g1` : null,
        waitingAt: 'Manager approval',
        waitingFor: 'person:manager',
        waitingSince: at,
        waitingDue: at + 10,
        createdAt: at,
        updatedAt: at,
      },
    ],
    approvals: [
      {
        id: `apr_ob_${id}`,
        orderId: `ob_${id}`,
        nodeId: node,
        title: `Approve ob_${id}`,
        status,
        requestedAt: at,
      },
    ],
  };
}

/** Fixtures merged, with the flow and its version. */
function fixture(...parts: OrderBoardFixture[]): OrderBoardFixture {
  const out: Record<string, unknown[]> = { flows: [FLOW], flowVersions: [VERSION] };
  for (const p of parts)
    for (const [k, v] of Object.entries(p)) out[k] = [...(out[k] ?? []), ...(v as unknown[])];
  return out as OrderBoardFixture;
}

const order = (id: string, over: Partial<BoardOrder> = {}): OrderBoardFixture => ({
  orders: [{ id: `ob_${id}`, status: 'completed', createdAt: 1_000, ...over }],
});

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

export function describeOrderBoardContract(
  name: string,
  make: (fixture: OrderBoardFixture) => Promise<OrderBoard>,
) {
  describe(`${name}: the order board contract`, () => {
    describe('the orders list', () => {
      it('filters by what the list offers, and finds text in the order and its customer', async () => {
        const s = await make(
          fixture(
            { customers: [{ id: 'ob_cust', name: 'Northwind Traders' }] },
            order('a', { model: 'b2c', channel: 'email', createdAt: 1 }),
            order('b', { customerId: 'ob_cust', title: 'Desks', createdAt: 2 }),
            order('c', {
              status: 'failed',
              stoppedAt: 'Charge card · Notify',
              externalId: 'PO-77',
              createdAt: 3,
            }),
            order('d', { contactEmail: 'Guest@Example.com', flowId: 'ob_other', createdAt: 4 }),
          ),
        );
        expect(ids(await s.list({ model: 'b2c' }, 10))).toEqual(['ob_a']);
        expect(ids(await s.list({ channel: 'email' }, 10))).toEqual(['ob_a']);
        expect(ids(await s.list({ customer: 'ob_cust' }, 10))).toEqual(['ob_b']);
        expect(ids(await s.list({ flow: 'ob_other' }, 10))).toEqual(['ob_d']);
        expect(ids(await s.list({ step: 'Notify' }, 10))).toEqual(['ob_c']);
        // Case-insensitive, in the customer's name, the email, the external id; `#` dropped.
        expect(ids(await s.list({ q: 'northwind' }, 10))).toEqual(['ob_b']);
        expect(ids(await s.list({ q: 'guest@example' }, 10))).toEqual(['ob_d']);
        expect(ids(await s.list({ q: 'po-77' }, 10))).toEqual(['ob_c']);
        expect(ids(await s.list({ q: '#ob_a' }, 10))).toEqual(['ob_a']);
        // A LIKE wildcard in the text is matched literally.
        expect(await s.list({ q: 'ob_%' }, 10)).toEqual([]);
      });

      it('sorts by created, oldest, updated, total in the base currency and wait', async () => {
        const s = await make(
          fixture(
            order('a', { createdAt: 1, updatedAt: 30, total: 100, fxRate: 1 }),
            order('b', { createdAt: 2, updatedAt: 10, total: 150, fxRate: 2, waitingSince: 5 }),
            order('c', { createdAt: 3, updatedAt: 20, total: 90, fxRate: 1, waitingSince: 1 }),
          ),
        );
        expect(ids(await s.list({}, 10))).toEqual(['ob_c', 'ob_b', 'ob_a']);
        expect(ids(await s.list({ sort: 'oldest' }, 10))).toEqual(['ob_a', 'ob_b', 'ob_c']);
        expect(ids(await s.list({ sort: 'updated' }, 10))).toEqual(['ob_a', 'ob_c', 'ob_b']);
        expect(ids(await s.list({ sort: 'total' }, 10))).toEqual(['ob_a', 'ob_c', 'ob_b']);
        // Not waiting last.
        expect(ids(await s.list({ sort: 'waiting' }, 10))).toEqual(['ob_c', 'ob_b', 'ob_a']);
        expect(ids(await s.list({}, 2))).toEqual(['ob_c', 'ob_b']);
      });

      it('pages newest first after a row, ids breaking ties, and counts every page', async () => {
        const s = await make(
          fixture(
            order('a', { createdAt: 5 }),
            order('b', { createdAt: 5 }),
            order('c', { createdAt: 6 }),
            order('d', { createdAt: 1, status: 'failed' }),
          ),
        );
        const after = { createdAt: 5, id: 'ob_b' };
        expect(ids(await s.list({ after }, 10))).toEqual(['ob_a', 'ob_d']);
        // The count ignores the cursor, and stops one past its cap.
        expect(await s.count({ after }, 10)).toEqual({ n: 4, more: false });
        expect(await s.count({}, 3)).toEqual({ n: 3, more: true });
        expect(await s.count({ status: 'failed' }, 3)).toEqual({ n: 1, more: false });
      });

      it('keeps recorded orders out of open statuses and attention, and in the full list', async () => {
        const s = await make(fixture(asked('live', 100), asked('rec', 50, { run: false })));
        expect(ids(await s.list({ status: 'waiting' }, 10))).toEqual(['ob_live']);
        expect(ids(await s.list({ attention: true }, 10))).toEqual(['ob_live']);
        expect(ids(await s.list({}, 10))).toEqual(['ob_live', 'ob_rec']);
      });

      it('treats failed and rolled-back orders as needing attention, and finds declined ones', async () => {
        const s = await make(
          fixture(
            order('f', { status: 'failed', createdAt: 1 }),
            order('r', { status: 'rolled_back', createdAt: 2 }),
            order('new', { status: 'declined', createdAt: 3 }),
            order('old', { status: 'cancelled', createdAt: 4 }),
            order('mine', { status: 'cancelled', createdAt: 5 }),
            {
              approvals: [
                {
                  id: 'apr_ob_old',
                  orderId: 'ob_old',
                  nodeId: 'mgr',
                  title: 'x',
                  status: 'rejected',
                  requestedAt: 1,
                },
              ],
            },
          ),
        );
        expect(ids(await s.list({ attention: true }, 10))).toEqual(['ob_r', 'ob_f']);
        // Declined before `declined` existed: cancelled, with an approval rejected.
        expect(ids(await s.list({ status: 'declined' }, 10))).toEqual(['ob_old', 'ob_new']);
        expect(await s.declinedOrderIds(['ob_old', 'ob_mine', 'ob_new'])).toEqual(['ob_old']);
      });

      it('reads only orders updated since a time', async () => {
        const s = await make(
          fixture(order('a', { updatedAt: 10 }), order('b', { updatedAt: 20, createdAt: 2 })),
        );
        expect(ids(await s.list({ updatedSince: 20 }, 10))).toEqual(['ob_b']);
      });

      it('answers more declined ids than one D1 statement can bind', async () => {
        const many = Array.from({ length: 150 }, (_, i) => `ob_none_${i}`);
        const s = await make(
          fixture(order('old', { status: 'cancelled' }), {
            approvals: [
              {
                id: 'apr_ob_old',
                orderId: 'ob_old',
                nodeId: 'mgr',
                title: 'x',
                status: 'escalated',
                requestedAt: 1,
              },
            ],
          }),
        );
        expect(await s.declinedOrderIds([...many, 'ob_old', 'ob_old'])).toEqual(['ob_old']);
        expect(await s.declinedOrderIds([])).toEqual([]);
      });
    });

    describe('the approvals inbox', () => {
      it('pages pending approvals oldest first, with where each page starts', async () => {
        const s = await make(
          fixture(
            asked('a', 100),
            asked('b', 200),
            asked('c', 200),
            asked('d', 300),
            asked('e', 400),
            asked('x', 50, { status: 'approved' }),
          ),
        );
        const one = await s.approvals('pending', null, 2);
        expect(ids(one.rows)).toEqual(['apr_ob_a', 'apr_ob_b']);
        expect(one).toMatchObject({
          from: 0,
          total: 5,
          next: { requestedAt: 200, id: 'apr_ob_b' },
        });
        const two = await s.approvals('pending', one.next, 2);
        expect(ids(two.rows)).toEqual(['apr_ob_c', 'apr_ob_d']);
        expect(two).toMatchObject({ from: 2, total: 5 });
        const three = await s.approvals('pending', two.next, 2);
        expect(ids(three.rows)).toEqual(['apr_ob_e']);
        expect(three).toMatchObject({ from: 4, total: 5, next: null });
      });

      it('reads history newest first, and starts past the end counting what came before', async () => {
        const s = await make(
          fixture(
            asked('a', 100, { status: 'approved' }),
            asked('b', 200, { status: 'rejected' }),
            asked('c', 300),
          ),
        );
        const all = await s.approvals('all', null, 2);
        expect(ids(all.rows)).toEqual(['apr_ob_c', 'apr_ob_b']);
        const rest = await s.approvals('all', all.next, 2);
        expect(ids(rest.rows)).toEqual(['apr_ob_a']);
        expect(rest).toMatchObject({ from: 2, total: 3, next: null });
        const end = await s.approvals('pending', { requestedAt: 300, id: 'apr_ob_c' }, 2);
        expect(end).toMatchObject({ rows: [], from: 1, total: 1, next: null });
      });

      it("names each approval's step and flow from the version its order pinned", async () => {
        const s = await make(
          fixture(
            { customers: [{ id: 'ob_cust', name: 'Northwind' }] },
            asked('a', 100, { node: 'fin' }),
            // A version that isn't stored leaves the label empty, not wrong.
            asked('b', 200, { version: 9 }),
          ),
        );
        const { rows } = await s.approvals('pending', null, 10);
        expect(rows.map((r) => r.stepLabel)).toEqual(['Finance approval', null]);
        expect(rows[0]).toMatchObject({
          title: 'Approve ob_a',
          orderTitle: '',
          orderModel: 'procurement',
          flowId: 'ob_flow',
          flowName: 'Buy',
          currency: 'USD',
          fxRate: 1,
          total: 2,
        });
      });

      it('keeps approvals on recorded orders out of the live queue, and lists them on their own', async () => {
        const s = await make(
          fixture(
            asked('r1', 10, { run: false }),
            asked('r2', 20, { run: false }),
            asked('r3', 30, { run: false }),
            asked('a', 100),
            asked('b', 200),
            asked('c', 300),
          ),
        );
        const live = await s.approvals('pending', null, 2, 'live');
        expect(ids(live.rows)).toEqual(['apr_ob_a', 'apr_ob_b']);
        expect(live).toMatchObject({ from: 0, total: 3 });
        const rest = await s.approvals('pending', live.next, 2, 'live');
        expect(ids(rest.rows)).toEqual(['apr_ob_c']);
        expect(rest).toMatchObject({ from: 2, total: 3, next: null });
        const recorded = await s.approvals('pending', null, 2, 'recorded');
        expect(ids(recorded.rows)).toEqual(['apr_ob_r1', 'apr_ob_r2']);
        const more = await s.approvals('pending', recorded.next, 2, 'recorded');
        expect(more).toMatchObject({ from: 2, total: 3, next: null });
        expect(await s.pendingApprovalCounts()).toEqual({ live: 3, recorded: 3 });
      });

      it('counts an approval whose order is gone as recorded', async () => {
        const gone = asked('gone', 200);
        const s = await make(
          fixture(
            asked('a', 100),
            { approvals: gone.approvals },
            asked('old', 50, { status: 'approved', run: false }),
          ),
        );
        expect(await s.pendingApprovalCounts()).toEqual({ live: 1, recorded: 1 });
        expect(ids((await s.approvals('all', null, 10)).rows)).toEqual([
          'apr_ob_gone',
          'apr_ob_a',
          'apr_ob_old',
        ]);
        expect((await s.approvals('all', null, 10)).rows[0]).toMatchObject({
          orderModel: null,
          flowId: null,
          stepLabel: null,
        });
      });
    });

    describe('the overview', () => {
      it('reads the five longest-waiting live approvals and counts the whole queue', async () => {
        const s = await make(
          fixture(
            ...Array.from({ length: 8 }, (_, i) => asked(`p${i}`, 1000 - i * 10)),
            asked('done', 1, { status: 'approved' }),
            asked('rec', 2, { run: false }),
          ),
        );
        const o = await s.overview(NOW);
        expect(ids(o.approvals)).toEqual([
          'apr_ob_p7',
          'apr_ob_p6',
          'apr_ob_p5',
          'apr_ob_p4',
          'apr_ob_p3',
        ]);
        expect(o.pendingApprovals).toBe(8);
        // Open work and waits leave the recorded order out.
        expect(o.open).toEqual([{ status: 'waiting', n: 9 }]);
        expect(o.waitsByFlow).toEqual([
          {
            flowId: 'ob_flow',
            at: 'Manager approval',
            for: 'person:manager',
            n: 9,
            oldest: 1,
            overdue: 9,
          },
        ]);
        expect(o.recent).toHaveLength(8);
      });

      it('counts a wait as overdue only from its deadline, and a timer never', async () => {
        const s = await make(
          fixture(
            asked('late', 100),
            asked('due', 200),
            order('timer', {
              status: 'waiting',
              waitingAt: 'Manager approval',
              waitingFor: 'person:manager',
              waitingSince: 300,
            }),
          ),
        );
        expect((await s.overview(210)).waitsByFlow[0]).toMatchObject({ n: 3, overdue: 2 });
        expect((await s.overview(50)).waitsByFlow[0]).toMatchObject({ n: 3, overdue: 0 });
      });

      it('sums what ended in the last day in the base currency, and what was declined', async () => {
        const s = await make(
          fixture(
            order('a', { status: 'completed', total: 100, fxRate: 1, updatedAt: NOW - 1000 }),
            order('b', { status: 'completed', total: 50, fxRate: 2, updatedAt: NOW - 2000 }),
            order('old', { status: 'completed', total: 999, updatedAt: NOW - 2 * DAY }),
            order('no', { status: 'cancelled', updatedAt: NOW - 1000 }),
            {
              approvals: [
                {
                  id: 'apr_ob_no',
                  orderId: 'ob_no',
                  nodeId: 'mgr',
                  title: 'x',
                  status: 'rejected',
                  requestedAt: 1,
                },
              ],
            },
          ),
        );
        const o = await s.overview(NOW);
        expect(o.ended24h.find((e) => e.status === 'completed')).toEqual({
          status: 'completed',
          n: 2,
          total: 125,
        });
        expect(o.declined24h).toBe(1);
      });

      it("groups this week's failures by flow and step, most first, with each group's latest reason", async () => {
        const at = (n: number) => NOW - n * 1000;
        const s = await make(
          fixture(
            order('a', {
              status: 'failed',
              stoppedAt: 'Charge',
              reason: 'card declined',
              updatedAt: at(3),
            }),
            order('b', {
              status: 'rolled_back',
              stoppedAt: 'Charge',
              reason: 'insufficient funds',
              updatedAt: at(2),
            }),
            order('c', { status: 'failed', stoppedAt: null, reason: 'timeout', updatedAt: at(1) }),
            order('d', {
              status: 'failed',
              stoppedAt: 'Charge',
              reason: 'ancient',
              updatedAt: NOW - 8 * DAY,
            }),
          ),
        );
        expect((await s.overview(NOW)).stoppedWeek).toEqual([
          {
            flowId: 'ob_flow',
            at: 'Charge',
            n: 2,
            rolledBack: 1,
            latest: at(2),
            reason: 'insufficient funds',
          },
          { flowId: 'ob_flow', at: null, n: 1, rolledBack: 0, latest: at(1), reason: 'timeout' },
        ]);
      });
    });

    describe("an order's records", () => {
      it('reads each list newest first, naming a seller no longer on file as the marketplace', async () => {
        const s = await make(
          fixture(order('a'), {
            documents: [
              {
                id: 'ob_doc1',
                orderId: 'ob_a',
                kind: 'inbound',
                r2Key: 'k1',
                contentType: 'text/plain',
                createdAt: 1,
              },
              {
                id: 'ob_doc2',
                orderId: 'ob_a',
                kind: 'invoice',
                r2Key: 'k2',
                contentType: 'application/pdf',
                createdAt: 2,
              },
              {
                id: 'ob_doc3',
                orderId: 'ob_other',
                kind: 'inbound',
                r2Key: 'k3',
                contentType: 'text/plain',
                createdAt: 3,
              },
            ],
            sellers: [{ id: 'ob_s1', name: 'Acme' }],
            sellerOrders: [
              { orderId: 'ob_a', sellerId: 'ob_s2', status: 'accepted', subtotal: 5, createdAt: 1 },
              { orderId: 'ob_a', sellerId: 'ob_s1', status: 'accepted', subtotal: 9, createdAt: 1 },
            ],
            payouts: [
              {
                orderId: 'ob_a',
                sellerId: 'ob_s1',
                status: 'scheduled',
                net: 8,
                commission: 1,
                createdAt: 1,
              },
            ],
            invoices: [
              {
                id: 'ob_inv',
                orderId: 'ob_a',
                status: 'open',
                number: 'INV-1',
                hostedUrl: null,
                amount: 9,
                currency: 'USD',
                dueAt: 5,
                createdAt: 1,
              },
            ],
          }),
        );
        const r = await s.records('ob_a');
        expect(ids(r.documents)).toEqual(['ob_doc2', 'ob_doc1']);
        expect(r.sellers).toEqual([
          { sellerId: 'ob_s1', name: 'Acme', status: 'accepted', subtotal: 9, reason: null },
          { sellerId: 'ob_s2', name: 'Marketplace', status: 'accepted', subtotal: 5, reason: null },
        ]);
        expect(r.payouts).toEqual([
          { sellerId: 'ob_s1', name: 'Acme', status: 'scheduled', net: 8, commission: 1 },
        ]);
        expect(r.invoices).toEqual([
          {
            id: 'ob_inv',
            status: 'open',
            number: 'INV-1',
            hostedUrl: null,
            amount: 9,
            currency: 'USD',
            dueAt: 5,
          },
        ]);
        expect(r.messages).toEqual([]);
        expect(r.payments).toEqual([]);
        expect(r.shipments).toEqual([]);
      });

      it("reads a recorded order's runs of its generation, approvals, and what a rollback undid", async () => {
        const run = (nodeId: string, startedAt: number, generation = 2) => ({
          orderId: 'ob_rb',
          generation,
          nodeId,
          run: 1,
          nodeType: 'commerce.reserve_inventory',
          model: 'b2b',
          status: 'succeeded',
          startedAt,
          endedAt: startedAt + 5,
          durationMs: 5,
        });
        const s = await make(
          fixture(
            order('rb', { status: 'rolled_back', generation: 2, instanceId: null }),
            order('ok', { status: 'completed' }),
            {
              runs: [run('b', 20), run('a', 10), run('old', 1, 1)],
              approvals: [
                {
                  id: 'apr_ob_rb2',
                  orderId: 'ob_rb',
                  nodeId: 'fin',
                  title: 'y',
                  requestedAt: 9,
                },
                {
                  id: 'apr_ob_rb1',
                  orderId: 'ob_rb',
                  nodeId: 'mgr',
                  title: 'x',
                  requestedAt: 3,
                },
              ],
              reservations: [
                { orderId: 'ob_rb', status: 'released' },
                { orderId: 'ob_rb', status: 'released' },
                { orderId: 'ob_rb', status: 'held' },
              ],
              entitlements: [{ orderId: 'ob_rb', status: 'revoked' }],
            },
          ),
        );
        const rb = await s.recorded('ob_rb');
        expect(rb?.order).toMatchObject({ id: 'ob_rb', generation: 2, instanceId: null });
        expect(rb?.runs.map((r) => r.nodeId)).toEqual(['a', 'b']);
        expect(rb?.runs[0]).toMatchObject({
          durationMs: 5,
          nodeType: 'commerce.reserve_inventory',
        });
        expect(ids(rb?.approvals ?? [])).toEqual(['apr_ob_rb1', 'apr_ob_rb2']);
        expect(rb?.undone).toEqual({
          reservationsReleased: 2,
          authorizationsVoided: 0,
          sellerOrdersCancelled: 0,
          payoutsReversed: 0,
          shipmentsCancelled: 0,
          invoicesVoided: 0,
          codesRevoked: 1,
        });
        expect((await s.recorded('ob_ok'))?.undone).toBeNull();
        expect(await s.recorded('ob_nobody')).toBeUndefined();
      });
    });

    describe('the Performance page', () => {
      const D = (day: number, hour = 12) => Date.UTC(2026, 9, day, hour);
      const run = (orderId: string, nodeType: string, durationMs: number, endedAt = D(20)) => ({
        orderId,
        generation: 1,
        nodeId: `${nodeType}-${durationMs}`,
        run: 1,
        nodeType,
        model: 'b2b',
        status: 'succeeded',
        startedAt: endedAt - durationMs,
        endedAt,
        durationMs,
      });
      const pay = (
        id: string,
        orderId: string,
        kind: string,
        amount: number,
        at: number,
        status = 'succeeded',
      ) => ({
        id,
        orderId,
        kind,
        amount,
        status,
        ref: null,
        provider: 'mock',
        externalId: null,
        currency: null,
        createdAt: at,
      });
      const PERF = () =>
        fixture(
          order('c1', {
            model: 'b2b',
            status: 'completed',
            total: 100,
            fxRate: 1,
            updatedAt: D(20, 1),
          }),
          order('c2', {
            model: 'b2b',
            status: 'completed',
            total: 50,
            fxRate: 2,
            updatedAt: D(20, 23),
          }),
          order('c3', {
            model: 'b2c',
            status: 'completed',
            total: 30,
            fxRate: 1,
            updatedAt: D(21),
          }),
          order('f1', { model: 'b2b', status: 'failed', updatedAt: D(21) }),
          order('x1', { model: 'b2b', status: 'cancelled', updatedAt: D(21) }),
          order('old', { model: 'b2b', status: 'completed', total: 999, updatedAt: D(1) }),
          order('open', { model: 'b2b', status: 'waiting', updatedAt: D(21) }),
          {
            payments: [
              pay('ob_p1', 'ob_c1', 'capture', 100, D(20)),
              pay('ob_p2', 'ob_c2', 'charge', 50, D(20)),
              pay('ob_p3', 'ob_c1', 'refund', 10, D(21)),
              pay('ob_p4', 'ob_c1', 'capture', 999, D(21), 'failed'),
              pay('ob_p5', 'ob_c1', 'authorization:card', 100, D(21)),
              pay('ob_p6', 'ob_gone', 'capture', 7, D(21)),
              pay('ob_p7', 'ob_gone', 'invoice_payment', 20, D(21)),
            ],
            runs: [
              ...[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((ms) =>
                run('ob_c1', 'commerce.price', ms),
              ),
              run('ob_c1', 'ai.extract', 500),
              run('ob_c1', 'ai.extract', 5000, D(1)),
            ],
          },
        );
      const byDay = <T extends { day: string }>(xs: T[]) =>
        [...xs].sort((a, b) => a.day.localeCompare(b.day));

      it('rates completion by order type over what ended since the start', async () => {
        const s = await make(PERF());
        expect((await s.performance(D(15))).completion).toEqual([
          { model: 'b2b', finished: 4, completed: 2 },
          { model: 'b2c', finished: 1, completed: 1 },
        ]);
      });

      it("sums each UTC day's revenue and money in the base currency", async () => {
        const s = await make(PERF());
        const p = await s.performance(D(15));
        expect(byDay(p.revenue)).toEqual([
          { day: '2026-10-20', total: 125 },
          { day: '2026-10-21', total: 30 },
        ]);
        // A payment without its order counts at rate 1; a paid invoice counts as collected; a
        // failed payment and an authorization not at all.
        expect(byDay(p.money)).toEqual([
          { day: '2026-10-20', collected: 125, refunded: 0 },
          { day: '2026-10-21', collected: 27, refunded: 10 },
        ]);
        expect(
          byDay(p.endings)
            .map((e) => `${e.day} ${e.status} ${e.n}`)
            .sort(),
        ).toEqual([
          '2026-10-20 completed 2',
          '2026-10-21 cancelled 1',
          '2026-10-21 completed 1',
          '2026-10-21 failed 1',
        ]);
      });

      it('gives nearest-rank p50 and p95 per node type, slowest first', async () => {
        const s = await make(PERF());
        expect((await s.performance(D(15))).nodes).toEqual([
          { type: 'ai.extract', n: 1, p50: 500, p95: 500 },
          { type: 'commerce.price', n: 10, p50: 50, p95: 100 },
        ]);
        // From the start of the window: the old run counts once it's in it.
        expect((await s.performance(D(1, 0))).nodes[0]).toEqual({
          type: 'ai.extract',
          n: 2,
          p50: 500,
          p95: 5000,
        });
      });
    });

    describe('the records page', () => {
      const RECORDS = () =>
        fixture(
          { customers: [{ id: 'ob_cust', name: 'Northwind' }] },
          order('a', { title: 'Desks', customerId: 'ob_cust' }),
          order('b', { contactEmail: 'guest@example.com' }),
          {
            payments: [
              {
                id: 'ob_pay1',
                orderId: 'ob_a',
                kind: 'authorization:card',
                amount: 10,
                status: 'authorized',
                ref: null,
                provider: 'stripe',
                externalId: 'pi_123',
                currency: 'USD',
                createdAt: 5,
              },
              {
                id: 'ob_pay2',
                orderId: 'ob_b',
                kind: 'capture',
                amount: 4,
                status: 'captured',
                ref: null,
                provider: 'mock',
                externalId: null,
                currency: null,
                createdAt: 7,
              },
              // Its order is gone: left out.
              {
                id: 'ob_pay3',
                orderId: 'ob_gone',
                kind: 'charge',
                amount: 1,
                status: 'captured',
                ref: null,
                provider: 'mock',
                externalId: null,
                currency: null,
                createdAt: 9,
              },
            ],
            invoices: [
              {
                id: 'ob_inv',
                orderId: 'ob_a',
                status: 'open',
                number: 'INV-77',
                hostedUrl: null,
                amount: 10,
                currency: 'USD',
                dueAt: null,
                createdAt: 6,
              },
            ],
            sellers: [{ id: 'ob_s1', name: 'Oak & Co' }],
            payouts: [
              {
                id: 'ob_po',
                orderId: 'ob_a',
                sellerId: 'ob_s1',
                status: 'scheduled',
                net: 8,
                commission: 2,
                createdAt: 4,
              },
            ],
            sellerOrders: [
              {
                id: 'ob_so',
                orderId: 'ob_a',
                sellerId: 'ob_gone_seller',
                status: 'accepted',
                subtotal: 5,
                createdAt: 3,
              },
            ],
            shipments: [
              {
                id: 'ob_ship',
                orderId: 'ob_b',
                carrier: 'UPS',
                tracking: '1Z999',
                status: 'label_created',
                provider: null,
                externalId: null,
                createdAt: 8,
              },
            ],
            locations: [{ id: 'ob_loc', name: 'Downtown' }],
            reservations: [
              {
                id: 'ob_hold1',
                orderId: 'ob_a',
                sku: 'DESK-1',
                qty: 2,
                locationId: 'ob_loc',
                status: 'held',
                createdAt: 2,
              },
              {
                id: 'ob_hold2',
                orderId: 'ob_b',
                sku: 'CHAIR-1',
                qty: 1,
                locationId: null,
                status: 'released',
                createdAt: 1,
              },
            ],
            messages: [
              {
                id: 'ob_msg',
                orderId: 'ob_b',
                recipient: 'guest@example.com',
                subject: 'Your order shipped',
                body: '…',
                createdAt: 9,
              },
            ],
            documents: [
              {
                id: 'ob_doc',
                orderId: 'ob_a',
                kind: 'invoice',
                r2Key: 'k',
                contentType: 'application/pdf',
                createdAt: 10,
              },
            ],
          },
        );

      it('reads the latest of each kind with its order, newest first, leaving out orphans', async () => {
        const s = await make(RECORDS());
        const r = await s.recentRecords('', 30);
        expect(ids(r.payments)).toEqual(['ob_pay2', 'ob_pay1']);
        expect(r.payments[1]).toMatchObject({
          orderId: 'ob_a',
          orderTitle: 'Desks',
          customerName: 'Northwind',
          contactEmail: null,
          kind: 'authorization:card',
          provider: 'stripe',
          externalId: 'pi_123',
          amount: 10,
        });
        expect(r.payments[0]).toMatchObject({
          customerName: null,
          contactEmail: 'guest@example.com',
        });
        expect(r.invoices).toEqual([
          expect.objectContaining({
            id: 'ob_inv',
            number: 'INV-77',
            provider: 'mock',
            terms: 'net_30',
            amount: 10,
          }),
        ]);
        expect(r.payouts).toEqual([
          expect.objectContaining({ seller: 'Oak & Co', gross: 10, commission: 2, net: 8 }),
        ]);
        expect(r.sellerOrders).toEqual([
          expect.objectContaining({ id: 'ob_so', seller: null, sellerId: 'ob_gone_seller' }),
        ]);
        expect(r.holds.map((h) => [h.id, h.location])).toEqual([
          ['ob_hold1', 'Downtown'],
          ['ob_hold2', null],
        ]);
        expect(r.shipments).toEqual([
          expect.objectContaining({ carrier: 'UPS', tracking: '1Z999', orderId: 'ob_b' }),
        ]);
        expect(r.messages[0]).toMatchObject({ subject: 'Your order shipped' });
        expect(r.documents[0]).toMatchObject({ kind: 'invoice', contentType: 'application/pdf' });
        expect(ids((await s.recentRecords('', 1)).payments)).toEqual(['ob_pay2']);
      });

      it("finds records by their order's fields and their own, case-insensitively", async () => {
        const s = await make(RECORDS());
        const find = async (q: string) => {
          const r = await s.recentRecords(q, 30);
          return Object.values(r)
            .flat()
            .map((x) => x.id)
            .sort();
        };
        // By the customer: everything on order a.
        expect(await find('northwind')).toEqual(
          ['ob_doc', 'ob_hold1', 'ob_inv', 'ob_pay1', 'ob_po', 'ob_so'].sort(),
        );
        expect(await find('#OB_B')).toEqual(['ob_hold2', 'ob_msg', 'ob_pay2', 'ob_ship']);
        expect(await find('pi_123')).toEqual(['ob_pay1']);
        expect(await find('inv-77')).toEqual(['ob_inv']);
        expect(await find('oak')).toEqual(['ob_po']);
        expect(await find('1z999')).toEqual(['ob_ship']);
        expect(await find('chair')).toEqual(['ob_hold2']);
        expect(await find('shipped')).toEqual(['ob_msg']);
        expect(await find('ob%')).toEqual([]);
      });
    });

    describe('the lists beside the orders', () => {
      it('lists orders with a run waiting on an outside event, and counts the overdue', async () => {
        const event = { waitingFor: 'event:payment.received' };
        const s = await make(
          fixture(
            { orders: asked('late', 100).orders!.map((o) => ({ ...o, ...event })) },
            { orders: asked('due', 200).orders!.map((o) => ({ ...o, ...event })) },
            { orders: asked('rec', 150, { run: false }).orders!.map((o) => ({ ...o, ...event })) },
            order('timer', { status: 'running', ...event, updatedAt: 300, createdAt: 300 }),
            asked('person', 50),
          ),
        );
        const w = await s.waitingOnEvents(2, 210);
        expect(ids(w.orders)).toEqual(['ob_timer', 'ob_due']);
        expect(w).toMatchObject({ total: 3, overdue: 2 });
        expect(await s.waitingOnEvents(10, 50)).toMatchObject({ total: 3, overdue: 0 });
      });

      it('counts open orders with a run per flow and version', async () => {
        const s = await make(
          fixture(
            asked('a', 1),
            asked('b', 2),
            asked('c', 3, { version: 2 }),
            asked('rec', 4, { run: false }),
            order('done'),
          ),
        );
        const counts = await s.runningByFlow();
        expect([...counts].sort((a, b) => a.version - b.version)).toEqual([
          { flowId: 'ob_flow', version: 1, n: 2 },
          { flowId: 'ob_flow', version: 2, n: 1 },
        ]);
      });

      it('reads the email intake log newest first', async () => {
        const mail = (id: string, receivedAt: number) => ({
          id,
          messageId: `<${id}@example.com>`,
          mailbox: 'orders@example.com',
          sender: 'buyer@example.com',
          subject: 'PO',
          status: 'accepted',
          reason: null,
          orderId: null,
          r2Key: null,
          attachments: 0,
          receivedAt,
        });
        const s = await make(
          fixture({ inboundEmails: [mail('ob_m1', 1), mail('ob_m2', 3), mail('ob_m3', 2)] }),
        );
        expect(ids(await s.inboundEmails(2))).toEqual(['ob_m2', 'ob_m3']);
      });
    });
  });
}
