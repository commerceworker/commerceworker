/**
 * The order board port over D1: the admin's reads of the orders index and each order's records.
 * Every page that reads several things reads them in one D1 batch. The contract
 * (`describeOrderBoardContract` in @commerceworker/test-kit) holds it to the in-memory store.
 */
import { TERMINAL_ORDER_STATUSES } from '@commerceworker/core';
import type {
  ApprovalCursor,
  ApprovalFilter,
  ApprovalScope,
  BoardFilter,
  OrderBoard,
} from '@commerceworker/ports/commerce';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  not,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from 'drizzle-orm';
import { createDb } from './index';
import { contains } from './match';
import { approvalRecord } from './order-records';
import {
  approvals,
  approvalVotes,
  companyMembers,
  customers,
  documents,
  entitlements,
  inboundEmails,
  invoices,
  locations,
  messages,
  nodeRuns,
  orders,
  payments,
  payouts,
  reservations,
  sellerOrders,
  sellers,
  shipments,
  users,
} from './schema';

/** An order the engine runs: it names its Workflow instance in the index when it starts. */
const hasRun = isNotNull(orders.instanceId);

/** Open statuses: an order in one is live work only while it has a run. */
const OPEN_STATUSES = ['queued', 'running', 'waiting'];

const DAY = 86_400_000;

/** Ids in runs that fit one statement's 100 bound parameters, with room for the rest. */
function chunks<T>(ids: readonly T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

const declinedWhere = and(
  inArray(approvals.status, ['escalated', 'rejected']),
  eq(orders.status, 'cancelled'),
);

export function d1OrderBoard(d1: D1Database): OrderBoard {
  const d = createDb(d1);

  /** The ids of cancelled orders declined by policy, as a subquery. */
  const declinedIds = () =>
    d
      .select({ id: approvals.orderId })
      .from(approvals)
      .innerJoin(orders, eq(orders.id, approvals.orderId))
      .where(declinedWhere);

  /** What a filter picks; `q` also matches the customer's name, so the query joins customers. */
  function ordersWhere(f: BoardFilter) {
    // "#idz7qp" is how the app writes an order's reference; search its id without the #.
    const q = f.q?.trim().replace(/^#/, '');
    return and(
      f.after
        ? or(
            lt(orders.createdAt, f.after.createdAt),
            and(eq(orders.createdAt, f.after.createdAt), lt(orders.id, f.after.id)),
          )
        : undefined,
      f.model ? eq(orders.model, f.model) : undefined,
      f.channel ? eq(orders.channel, f.channel) : undefined,
      f.flow ? eq(orders.flowId, f.flow) : undefined,
      f.customer ? eq(orders.customerId, f.customer) : undefined,
      // A step's label as the index stores it: one label, or several joined with " · ".
      f.step
        ? or(
            eq(orders.waitingAt, f.step),
            eq(orders.stoppedAt, f.step),
            contains(orders.waitingAt, f.step),
            contains(orders.stoppedAt, f.step),
          )
        : undefined,
      f.updatedSince !== undefined ? gte(orders.updatedAt, f.updatedSince) : undefined,
      f.status === 'declined'
        ? // Orders declined before `declined` existed were stored as cancelled.
          or(eq(orders.status, 'declined'), inArray(orders.id, declinedIds()))
        : f.status
          ? and(eq(orders.status, f.status), OPEN_STATUSES.includes(f.status) ? hasRun : undefined)
          : undefined,
      f.attention
        ? or(
            inArray(orders.status, ['failed', 'rolled_back']),
            and(
              hasRun,
              inArray(
                orders.id,
                d
                  .select({ id: approvals.orderId })
                  .from(approvals)
                  .where(eq(approvals.status, 'pending')),
              ),
            ),
          )
        : undefined,
      q
        ? or(
            contains(orders.id, q),
            contains(orders.title, q),
            contains(orders.customerId, q),
            contains(customers.name, q),
            contains(orders.contactEmail, q),
            contains(orders.externalId, q),
          )
        : undefined,
    );
  }

  /** The orders a filter picks, as a query to run alone or in a batch. */
  function ordersQuery(f: BoardFilter, limit: number) {
    const order =
      f.sort === 'oldest'
        ? [asc(orders.createdAt), asc(orders.id)]
        : f.sort === 'total'
          ? [desc(sql`${orders.total} / ${orders.fxRate}`), desc(orders.id)]
          : f.sort === 'updated'
            ? [desc(orders.updatedAt), desc(orders.id)]
            : f.sort === 'waiting'
              ? [sql`${orders.waitingSince} is null`, asc(orders.waitingSince), desc(orders.id)]
              : [desc(orders.createdAt), desc(orders.id)];
    return d
      .select(getTableColumns(orders))
      .from(orders)
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(ordersWhere(f))
      .orderBy(...order)
      .limit(limit);
  }

  /** The approvals a scope picks, over a query that left-joins `orders`. */
  const inScope = (scope?: ApprovalScope) =>
    scope === 'live' ? hasRun : scope === 'recorded' ? isNull(orders.instanceId) : undefined;

  /** The approvals a company or an approver picks: the voters resolved when the wait opened. */
  const forFilter = (f?: ApprovalFilter) =>
    and(
      f?.companyId ? eq(approvals.companyId, f.companyId) : undefined,
      f?.approver
        ? sql`exists (select 1 from json_each(${approvals.eligible}) where value = ${f.approver})`
        : undefined,
    );

  function approvalsQuery(
    status: string,
    {
      where,
      scope,
      limit,
      filter,
    }: { where?: SQL; scope?: ApprovalScope; limit: number; filter?: ApprovalFilter },
  ) {
    const matching = status === 'all' ? sql`1` : sql`q.status = ${status}`;
    const narrowed = sql`${filter?.companyId ? sql` and q.company_id = ${filter.companyId}` : sql``}${filter?.approver ? sql` and exists (select 1 from json_each(q.eligible) where value = ${filter.approver})` : sql``}`;
    const scoped =
      scope === 'live'
        ? sql` and o.instance_id is not null`
        : scope === 'recorded'
          ? sql` and o.instance_id is null`
          : sql``;
    return d
      .select({
        id: approvals.id,
        orderId: approvals.orderId,
        nodeId: approvals.nodeId,
        title: approvals.title,
        assignee: approvals.assignee,
        amount: approvals.amount,
        status: approvals.status,
        note: approvals.note,
        requestedAt: approvals.requestedAt,
        decidedAt: approvals.decidedAt,
        decidedBy: approvals.decidedBy,
        orderModel: orders.model,
        // Aliased: D1's batch returns rows keyed by column name, so a second `title` would
        // overwrite the approval's and shift every later column.
        orderTitle: sql<string | null>`${orders.title}`.as('order_title'),
        // The step's label from the flow version the order pinned, so a row still names its step
        // when the order's live state can't be read.
        stepLabel: sql<
          string | null
        >`(select json_extract(n.value, '$.label') from flow_versions fv, json_each(fv.flow_json, '$.nodes') n where fv.flow_id = orders.flow_id and fv.version = orders.flow_version and json_extract(n.value, '$.id') = approvals.node_id limit 1)`.as(
          'step_label',
        ),
        flowId: orders.flowId,
        // Aliased like the order's title: `customers.name` is selected too.
        flowName: sql<string | null>`(select f.name from flows f where f.id = orders.flow_id)`.as(
          'flow_name',
        ),
        currency: orders.currency,
        customerId: orders.customerId,
        customerName: customers.name,
        fxRate: orders.fxRate,
        startedBy: orders.startedBy,
        companyId: approvals.companyId,
        companyName: sql<
          string | null
        >`(select c.name from customers c where c.id = approvals.company_id)`.as('company_name'),
        approvers: approvals.approvers,
        mode: approvals.mode,
        required: approvals.required,
        approved:
          sql<number>`(select count(*) from approval_votes v where v.approval_id = approvals.id and v.decision = 'approved')`.as(
            'approved',
          ),
        rejected:
          sql<number>`(select count(*) from approval_votes v where v.approval_id = approvals.id and v.decision = 'rejected')`.as(
            'rejected',
          ),
        // How many approvals have this status in this scope. Uncorrelated, so SQLite counts once
        // from the status index; a window count would read every matching row.
        total: (scope || filter?.companyId || filter?.approver
          ? sql<number>`(select count(*) from approvals q left join orders o on o.id = q.order_id where ${matching}${scoped}${narrowed})`
          : status === 'all'
            ? sql<number>`(select count(*) from approvals)`
            : sql<number>`(select count(*) from approvals q where q.status = ${status})`
        ).as('total'),
      })
      .from(approvals)
      .leftJoin(orders, eq(orders.id, approvals.orderId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(
        and(
          status === 'all' ? undefined : eq(approvals.status, status),
          inScope(scope),
          forFilter(filter),
          where,
        ),
      )
      .orderBy(
        ...(status === 'pending'
          ? [asc(approvals.requestedAt), asc(approvals.id)]
          : [desc(approvals.requestedAt), desc(approvals.id)]),
      )
      .limit(limit);
  }

  /** Counts what the compensations left on one order's records, in one round trip. */
  async function undoneOn(orderId: string) {
    const n = sql<number>`count(*)`.mapWith(Number);
    const [res, pays, parts, outs, ships, bills, codes] = await d.batch([
      d
        .select({ n })
        .from(reservations)
        .where(and(eq(reservations.orderId, orderId), eq(reservations.status, 'released'))),
      d
        .select({ n })
        .from(payments)
        .where(and(eq(payments.orderId, orderId), eq(payments.status, 'voided'))),
      d
        .select({ n })
        .from(sellerOrders)
        .where(and(eq(sellerOrders.orderId, orderId), eq(sellerOrders.status, 'cancelled'))),
      d
        .select({ n })
        .from(payouts)
        .where(and(eq(payouts.orderId, orderId), eq(payouts.status, 'reversed'))),
      d
        .select({ n })
        .from(shipments)
        .where(and(eq(shipments.orderId, orderId), eq(shipments.status, 'cancelled'))),
      d
        .select({ n })
        .from(invoices)
        .where(and(eq(invoices.orderId, orderId), eq(invoices.status, 'void'))),
      d
        .select({ n })
        .from(entitlements)
        .where(and(eq(entitlements.orderId, orderId), eq(entitlements.status, 'revoked'))),
    ]);
    return {
      reservationsReleased: res[0]?.n ?? 0,
      authorizationsVoided: pays[0]?.n ?? 0,
      sellerOrdersCancelled: parts[0]?.n ?? 0,
      payoutsReversed: outs[0]?.n ?? 0,
      shipmentsCancelled: ships[0]?.n ?? 0,
      invoicesVoided: bills[0]?.n ?? 0,
      codesRevoked: codes[0]?.n ?? 0,
    };
  }

  return {
    list: (f, limit) => ordersQuery(f, limit),

    async count(f, cap) {
      const { after: _, ...filters } = f;
      const picked = d
        .select({ one: sql<number>`1`.as('one') })
        .from(orders)
        .leftJoin(customers, eq(customers.id, orders.customerId))
        .where(ordersWhere(filters))
        .limit(cap + 1)
        .as('picked');
      const row = await d.select({ n: sql<number>`count(*)` }).from(picked).get();
      const n = Number(row?.n ?? 0);
      return { n: Math.min(n, cap), more: n > cap };
    },

    async overview(now) {
      const stopped = inArray(orders.status, ['failed', 'rolled_back']);
      const dayAgo = now - DAY;
      const weekAgo = now - 7 * DAY;
      const [open, recent, approvalRows, ended24h, declined24h, waitsByFlow, stoppedWeek] =
        await d.batch([
          d
            .select({ status: orders.status, n: sql<number>`count(*)` })
            .from(orders)
            .where(and(inArray(orders.status, OPEN_STATUSES), hasRun))
            .groupBy(orders.status),
          ordersQuery({ sort: 'updated' }, 8),
          // The longest-waiting few that can be decided; the queue's size comes with them.
          approvalsQuery('pending', { scope: 'live', limit: 5 }),
          // An ended order's last update is its end.
          d
            .select({
              status: orders.status,
              n: sql<number>`count(*)`,
              total: sql<number>`coalesce(sum(${orders.total} / ${orders.fxRate}), 0)`,
            })
            .from(orders)
            .where(
              and(inArray(orders.status, TERMINAL_ORDER_STATUSES), gte(orders.updatedAt, dayAgo)),
            )
            .groupBy(orders.status),
          d
            .select({ n: sql<number>`count(distinct ${approvals.orderId})` })
            .from(approvals)
            .innerJoin(orders, eq(orders.id, approvals.orderId))
            .where(and(declinedWhere, gte(orders.updatedAt, dayAgo))),
          d
            .select({
              flowId: orders.flowId,
              at: orders.waitingAt,
              for: orders.waitingFor,
              n: sql<number>`count(*)`,
              oldest: sql<number | null>`min(${orders.waitingSince})`,
              // A null deadline (a timer) compares as null, which the sum skips: never overdue.
              overdue: sql<number>`coalesce(sum(${orders.waitingDue} <= ${now}), 0)`,
            })
            .from(orders)
            .where(and(eq(orders.status, 'waiting'), hasRun))
            .groupBy(orders.flowId, orders.waitingAt, orders.waitingFor),
          // The reason is the newest order's in each group. The outer columns are written
          // `orders.…` by hand: drizzle prints them unqualified, which inside the subquery would
          // mean o2's own and give every group the week's newest reason.
          d
            .select({
              flowId: orders.flowId,
              at: orders.stoppedAt,
              n: sql<number>`count(*)`,
              rolledBack: sql<number>`sum(${orders.status} = 'rolled_back')`,
              latest: sql<number>`max(${orders.updatedAt})`,
              reason: sql<
                string | null
              >`(select o2.reason from orders o2 where o2.flow_id = orders.flow_id and coalesce(o2.stopped_at, '') = coalesce(orders.stopped_at, '') and o2.status in ('failed', 'rolled_back') and o2.updated_at >= ${weekAgo} order by o2.updated_at desc limit 1)`,
            })
            .from(orders)
            .where(and(stopped, gte(orders.updatedAt, weekAgo)))
            .groupBy(orders.flowId, orders.stoppedAt)
            .orderBy(sql`count(*) desc`),
        ]);
      return {
        open,
        recent,
        approvals: approvalRows,
        pendingApprovals: approvalRows[0]?.total ?? 0,
        ended24h,
        declined24h: declined24h[0]?.n ?? 0,
        waitsByFlow,
        stoppedWeek,
      };
    },

    async approvals(status, after, limit, scope, filter) {
      const later = status === 'pending' ? gt : lt;
      const past = after
        ? or(
            later(approvals.requestedAt, after.requestedAt),
            and(eq(approvals.requestedAt, after.requestedAt), later(approvals.id, after.id)),
          )
        : undefined;
      const page = approvalsQuery(status, { where: past, scope, limit: limit + 1, filter });
      // How many rows the pages before this one held, so the page can say where it starts.
      const [rows, before] = past
        ? await d.batch([
            page,
            d
              .select({ n: sql<number>`count(*)` })
              .from(approvals)
              .leftJoin(orders, eq(orders.id, approvals.orderId))
              .where(
                and(
                  status === 'all' ? undefined : eq(approvals.status, status),
                  inScope(scope),
                  forFilter(filter),
                  not(past),
                ),
              ),
          ])
        : [await page, [{ n: 0 }]];
      const shown = rows.slice(0, limit);
      const last = shown.at(-1);
      const from = before[0]?.n ?? 0;
      const next: ApprovalCursor | null =
        rows.length > limit && last ? { requestedAt: last.requestedAt, id: last.id } : null;
      return { rows: shown, from, total: rows[0]?.total ?? from, next };
    },

    async votes(orderId) {
      const rows = await d
        .select({
          approvalId: approvalVotes.approvalId,
          nodeId: approvals.nodeId,
          voterId: approvalVotes.voterId,
          voterKind: approvalVotes.voterKind,
          voterName: sql<string | null>`coalesce(${companyMembers.name}, ${users.name})`.as(
            'voter_name',
          ),
          onBehalfBy: approvalVotes.onBehalfBy,
          onBehalfName: sql<
            string | null
          >`(select u.name from users u where u.id = ${approvalVotes.onBehalfBy})`.as(
            'on_behalf_name',
          ),
          decision: approvalVotes.decision,
          note: approvalVotes.note,
          at: approvalVotes.at,
        })
        .from(approvalVotes)
        .innerJoin(approvals, eq(approvals.id, approvalVotes.approvalId))
        .leftJoin(
          companyMembers,
          and(eq(approvalVotes.voterKind, 'member'), eq(companyMembers.id, approvalVotes.voterId)),
        )
        .leftJoin(
          users,
          and(eq(approvalVotes.voterKind, 'staff'), eq(users.id, approvalVotes.voterId)),
        )
        .where(eq(approvals.orderId, orderId))
        .orderBy(asc(approvalVotes.at), asc(approvalVotes.voterId));
      return rows.map((r) => ({
        ...r,
        voterKind: r.voterKind as 'staff' | 'member',
        decision: r.decision as 'approved' | 'rejected',
      }));
    },

    async voters(orderId) {
      return d
        .select({
          approvalId: approvals.id,
          nodeId: approvals.nodeId,
          memberId: companyMembers.id,
          name: companyMembers.name,
        })
        .from(approvals)
        .innerJoin(sql`json_each(${approvals.eligible}) e`, sql`${approvals.eligible} is not null`)
        .innerJoin(companyMembers, sql`${companyMembers.id} = e.value`)
        .where(and(eq(approvals.orderId, orderId), eq(approvals.status, 'pending')))
        .orderBy(asc(companyMembers.name), asc(companyMembers.id));
    },

    async pendingApprovalCounts() {
      const row = await d
        .select({
          live: sql<number>`coalesce(sum(${orders.instanceId} is not null), 0)`,
          recorded: sql<number>`coalesce(sum(${orders.instanceId} is null), 0)`,
        })
        .from(approvals)
        .leftJoin(orders, eq(orders.id, approvals.orderId))
        .where(eq(approvals.status, 'pending'))
        .get();
      return { live: Number(row?.live ?? 0), recorded: Number(row?.recorded ?? 0) };
    },

    async records(orderId) {
      const [docs, msgs, pays, ships, parts, outs, bills] = await d.batch([
        d
          .select()
          .from(documents)
          .where(eq(documents.orderId, orderId))
          .orderBy(desc(documents.createdAt)),
        d
          .select()
          .from(messages)
          .where(eq(messages.orderId, orderId))
          .orderBy(desc(messages.createdAt)),
        d
          .select()
          .from(payments)
          .where(eq(payments.orderId, orderId))
          .orderBy(desc(payments.createdAt)),
        d
          .select()
          .from(shipments)
          .where(eq(shipments.orderId, orderId))
          .orderBy(desc(shipments.createdAt)),
        d
          .select({
            sellerId: sellerOrders.sellerId,
            name: sellers.name,
            status: sellerOrders.status,
            subtotal: sellerOrders.subtotal,
            reason: sellerOrders.reason,
          })
          .from(sellerOrders)
          .leftJoin(sellers, eq(sellers.id, sellerOrders.sellerId))
          .where(eq(sellerOrders.orderId, orderId))
          .orderBy(sellerOrders.sellerId),
        d
          .select({
            sellerId: payouts.sellerId,
            name: sellers.name,
            status: payouts.status,
            net: payouts.net,
            commission: payouts.commission,
          })
          .from(payouts)
          .leftJoin(sellers, eq(sellers.id, payouts.sellerId))
          .where(eq(payouts.orderId, orderId))
          .orderBy(payouts.sellerId),
        d
          .select({
            id: invoices.id,
            status: invoices.status,
            number: invoices.number,
            hostedUrl: invoices.hostedUrl,
            amount: invoices.amount,
            currency: invoices.currency,
            dueAt: invoices.dueAt,
          })
          .from(invoices)
          .where(eq(invoices.orderId, orderId))
          .orderBy(desc(invoices.createdAt)),
      ]);
      return {
        documents: docs,
        messages: msgs,
        payments: pays,
        shipments: ships,
        sellers: parts.map((p) => ({ ...p, name: p.name ?? 'Marketplace' })),
        payouts: outs,
        invoices: bills,
      };
    },

    async recorded(orderId) {
      const order = await d.select().from(orders).where(eq(orders.id, orderId)).get();
      if (!order) return undefined;
      const [runs, asks, undone] = await Promise.all([
        d
          .select()
          .from(nodeRuns)
          .where(and(eq(nodeRuns.orderId, orderId), eq(nodeRuns.generation, order.generation ?? 1)))
          .orderBy(asc(nodeRuns.startedAt)),
        d
          .select()
          .from(approvals)
          .where(eq(approvals.orderId, orderId))
          .orderBy(asc(approvals.requestedAt)),
        order.status === 'rolled_back' ? undoneOn(orderId) : null,
      ]);
      return { order, runs, approvals: asks.map(approvalRecord), undone };
    },

    async performance(since) {
      const dayOf = (ms: unknown) => sql<string>`date(${ms} / 1000, 'unixepoch')`;
      const ended = and(
        inArray(orders.status, TERMINAL_ORDER_STATUSES),
        gte(orders.updatedAt, since),
      );
      const [[completion, revenue, money, endings], nodes] = await Promise.all([
        d.batch([
          d
            .select({
              model: orders.model,
              finished: sql<number>`count(*)`.mapWith(Number),
              completed: sql<number>`sum(${orders.status} = 'completed')`.mapWith(Number),
            })
            .from(orders)
            .where(ended)
            .groupBy(orders.model)
            .orderBy(sql`count(*) desc`),
          d
            .select({
              day: dayOf(orders.updatedAt).as('day'),
              total: sql<number>`sum(${orders.total} / ${orders.fxRate})`.mapWith(Number),
            })
            .from(orders)
            .where(and(eq(orders.status, 'completed'), gte(orders.updatedAt, since)))
            .groupBy(sql`1`),
          // Payments are in their order's currency; convert at the order's rate. Collected is
          // money taken: captures, charges and paid invoices.
          d
            .select({
              day: dayOf(payments.createdAt).as('day'),
              collected:
                sql<number>`coalesce(sum(case when ${payments.kind} in ('capture', 'charge', 'invoice_payment') then ${payments.amount} / coalesce(${orders.fxRate}, 1) end), 0)`.mapWith(
                  Number,
                ),
              refunded:
                sql<number>`coalesce(sum(case when ${payments.kind} = 'refund' then ${payments.amount} / coalesce(${orders.fxRate}, 1) end), 0)`.mapWith(
                  Number,
                ),
            })
            .from(payments)
            .leftJoin(orders, eq(orders.id, payments.orderId))
            .where(and(eq(payments.status, 'succeeded'), gte(payments.createdAt, since)))
            .groupBy(sql`1`),
          d
            .select({
              day: dayOf(orders.updatedAt).as('day'),
              status: orders.status,
              n: sql<number>`count(*)`.mapWith(Number),
            })
            .from(orders)
            .where(ended)
            .groupBy(sql`1`, orders.status),
        ]),
        // Nearest-rank percentiles: the row at ceil(p × n) in each node type's sorted durations.
        // A window query drizzle can't batch, so it runs beside the batch.
        d.all<{ type: string; n: number; p50: number; p95: number }>(sql`
          with ranked as (
            select ${nodeRuns.nodeType} as type, ${nodeRuns.durationMs} as ms,
              row_number() over (partition by ${nodeRuns.nodeType} order by ${nodeRuns.durationMs}) as rn,
              count(*) over (partition by ${nodeRuns.nodeType}) as n
            from ${nodeRuns}
            where ${nodeRuns.endedAt} >= ${since}
          )
          select type, n,
            max(case when rn = (n * 50 + 99) / 100 then ms end) as p50,
            max(case when rn = (n * 95 + 99) / 100 then ms end) as p95
          from ranked
          group by type
          order by p95 desc`),
      ]);
      return { completion, nodes, revenue, money, endings };
    },

    async recentRecords(rawQ, perKind) {
      const term = rawQ.trim().replace(/^#/, '');
      const match = (...own: SQLWrapper[]): SQL | undefined =>
        term
          ? or(
              contains(orders.id, term),
              contains(orders.title, term),
              contains(orders.contactEmail, term),
              contains(customers.name, term),
              ...own.map((c) => contains(c, term)),
            )
          : undefined;
      // Each joins its order and customer; every name another table shares is aliased, since
      // D1's batch keys a row by column name.
      const order = {
        orderId: sql<string>`${orders.id}`.as('rec_order_id'),
        orderTitle: sql<string>`${orders.title}`.as('rec_order_title'),
        customerName: sql<string | null>`${customers.name}`.as('rec_customer_name'),
        contactEmail: orders.contactEmail,
      };
      const seller = sql<string | null>`${sellers.name}`.as('rec_seller');
      const [pays, bills, outs, ships, holds, parts, msgs, docs] = await d.batch([
        d
          .select({
            ...order,
            id: payments.id,
            kind: payments.kind,
            amount: payments.amount,
            status: payments.status,
            ref: payments.ref,
            provider: payments.provider,
            externalId: payments.externalId,
            currency: payments.currency,
            createdAt: payments.createdAt,
          })
          .from(payments)
          .innerJoin(orders, eq(orders.id, payments.orderId))
          .leftJoin(customers, eq(customers.id, orders.customerId))
          .where(match(payments.ref, payments.externalId))
          .orderBy(desc(payments.createdAt))
          .limit(perKind),
        d
          .select({
            ...order,
            id: invoices.id,
            number: invoices.number,
            provider: invoices.provider,
            terms: invoices.terms,
            amount: invoices.amount,
            currency: invoices.currency,
            status: invoices.status,
            createdAt: invoices.createdAt,
          })
          .from(invoices)
          .innerJoin(orders, eq(orders.id, invoices.orderId))
          .leftJoin(customers, eq(customers.id, orders.customerId))
          .where(match(invoices.number))
          .orderBy(desc(invoices.createdAt))
          .limit(perKind),
        d
          .select({
            ...order,
            id: payouts.id,
            sellerId: payouts.sellerId,
            seller,
            gross: payouts.gross,
            commission: payouts.commission,
            net: payouts.net,
            status: payouts.status,
            createdAt: payouts.createdAt,
          })
          .from(payouts)
          .innerJoin(orders, eq(orders.id, payouts.orderId))
          .leftJoin(customers, eq(customers.id, orders.customerId))
          .leftJoin(sellers, eq(sellers.id, payouts.sellerId))
          .where(match(sellers.name))
          .orderBy(desc(payouts.createdAt))
          .limit(perKind),
        d
          .select({
            ...order,
            id: shipments.id,
            carrier: shipments.carrier,
            tracking: shipments.tracking,
            status: shipments.status,
            createdAt: shipments.createdAt,
          })
          .from(shipments)
          .innerJoin(orders, eq(orders.id, shipments.orderId))
          .leftJoin(customers, eq(customers.id, orders.customerId))
          .where(match(shipments.tracking, shipments.carrier))
          .orderBy(desc(shipments.createdAt))
          .limit(perKind),
        d
          .select({
            ...order,
            id: reservations.id,
            sku: reservations.sku,
            qty: reservations.qty,
            location: sql<string | null>`${locations.name}`.as('rec_location'),
            status: reservations.status,
            createdAt: reservations.createdAt,
          })
          .from(reservations)
          .innerJoin(orders, eq(orders.id, reservations.orderId))
          .leftJoin(customers, eq(customers.id, orders.customerId))
          .leftJoin(locations, eq(locations.id, reservations.locationId))
          .where(match(reservations.sku))
          .orderBy(desc(reservations.createdAt))
          .limit(perKind),
        d
          .select({
            ...order,
            id: sellerOrders.id,
            sellerId: sellerOrders.sellerId,
            seller,
            subtotal: sellerOrders.subtotal,
            reason: sellerOrders.reason,
            status: sellerOrders.status,
            createdAt: sellerOrders.createdAt,
          })
          .from(sellerOrders)
          .innerJoin(orders, eq(orders.id, sellerOrders.orderId))
          .leftJoin(customers, eq(customers.id, orders.customerId))
          .leftJoin(sellers, eq(sellers.id, sellerOrders.sellerId))
          .where(match(sellers.name))
          .orderBy(desc(sellerOrders.createdAt))
          .limit(perKind),
        d
          .select({
            ...order,
            id: messages.id,
            recipient: messages.recipient,
            subject: messages.subject,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .innerJoin(orders, eq(orders.id, messages.orderId))
          .leftJoin(customers, eq(customers.id, orders.customerId))
          .where(match(messages.recipient, messages.subject))
          .orderBy(desc(messages.createdAt))
          .limit(perKind),
        d
          .select({
            ...order,
            id: documents.id,
            kind: documents.kind,
            contentType: documents.contentType,
            createdAt: documents.createdAt,
          })
          .from(documents)
          .innerJoin(orders, eq(orders.id, documents.orderId))
          .leftJoin(customers, eq(customers.id, orders.customerId))
          .where(match(documents.kind))
          .orderBy(desc(documents.createdAt))
          .limit(perKind),
      ]);
      return {
        payments: pays,
        invoices: bills,
        payouts: outs,
        shipments: ships,
        holds,
        sellerOrders: parts,
        messages: msgs,
        documents: docs,
      };
    },

    async waitingOnEvents(limit, now) {
      // Only orders with a run: the list reads each one's live waits, and a recorded order has none.
      const where = and(
        inArray(orders.status, ['waiting', 'running']),
        contains(orders.waitingFor, 'event:'),
        hasRun,
      );
      const [rows, all] = await d.batch([
        d.select().from(orders).where(where).orderBy(desc(orders.updatedAt)).limit(limit),
        d
          .select({
            n: sql<number>`count(*)`,
            overdue: sql<number>`coalesce(sum(${orders.waitingDue} <= ${now}), 0)`,
          })
          .from(orders)
          .where(where),
      ]);
      return {
        orders: rows,
        total: Number(all[0]?.n ?? rows.length),
        overdue: Number(all[0]?.overdue ?? 0),
      };
    },

    async runningByFlow() {
      return d
        .select({ flowId: orders.flowId, version: orders.flowVersion, n: sql<number>`count(*)` })
        .from(orders)
        .where(and(inArray(orders.status, OPEN_STATUSES), hasRun))
        .groupBy(orders.flowId, orders.flowVersion);
    },

    async declinedOrderIds(ids) {
      const wanted = [...new Set(ids)];
      if (!wanted.length) return [];
      const rows = await Promise.all(
        chunks(wanted).map((b) =>
          d
            .selectDistinct({ id: approvals.orderId })
            .from(approvals)
            .innerJoin(orders, eq(orders.id, approvals.orderId))
            .where(and(declinedWhere, inArray(approvals.orderId, b))),
        ),
      );
      return rows.flat().map((r) => r.id);
    },

    inboundEmails: (limit) =>
      d.select().from(inboundEmails).orderBy(desc(inboundEmails.receivedAt)).limit(limit),
  };
}
