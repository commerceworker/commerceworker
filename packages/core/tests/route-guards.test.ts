import { describe, expect, it } from 'vitest';
import {
  B2B_AUTO_APPROVE,
  guardRoute,
  type RunContext,
  routeGuardErrors,
  TEMPLATES,
  truthy,
  validateConfig,
} from '../src';

const ROUTES = ['auto_approve', 'needs_approval', 'ask_customer'];
const ctx = (order: Record<string, unknown>): RunContext =>
  ({
    order: { id: 'o1', total: 500, currency: 'USD', lines: [], ...order },
    nodes: {},
    vars: {},
    input: {},
    now: 0,
    ref: 'o1',
  }) as unknown as RunContext;

const underLimit = { auto_approve: { '<': [{ var: 'order.total' }, 1000] } };

describe('route guards', () => {
  it('takes a guarded route only when its condition holds', () => {
    const config = { guards: underLimit };
    expect(guardRoute('auto_approve', config, ROUTES, ctx({ total: 500 }))).toEqual({
      route: 'auto_approve',
    });
    expect(guardRoute('auto_approve', config, ROUTES, ctx({ total: 5000 }))).toEqual({
      route: 'needs_approval',
      overridden: 'auto_approve',
    });
  });

  it('leaves unguarded routes, and routers with no guards, to the model', () => {
    expect(
      guardRoute('ask_customer', { guards: underLimit }, ROUTES, ctx({ total: 5000 })),
    ).toEqual({ route: 'ask_customer' });
    expect(guardRoute('auto_approve', {}, ROUTES, ctx({ total: 5000 }))).toEqual({
      route: 'auto_approve',
    });
  });

  it('falls back to the configured route, and counts a guard that throws as failing', () => {
    const config = { guards: underLimit, fallback: 'ask_customer' };
    expect(guardRoute('auto_approve', config, ROUTES, ctx({ total: 5000 })).route).toBe(
      'ask_customer',
    );
    const broken = { guards: { auto_approve: { nope_not_an_operator: [1] } } };
    expect(guardRoute('auto_approve', broken, ROUTES, ctx({}))).toEqual({
      route: 'needs_approval',
      overridden: 'auto_approve',
    });
  });

  it('fails closed on a guard that would otherwise always hold', () => {
    const take = (rule: unknown, order: Record<string, unknown> = { total: 5000 }) =>
      guardRoute('auto_approve', { guards: { auto_approve: rule } }, ROUTES, ctx(order)).route;
    // Not one operation: JSON Logic hands these back as values, and an object is truthy.
    expect(take({})).toBe('needs_approval');
    expect(take({ '<': [1, 0], and: [true] })).toBe('needs_approval');
    expect(take({ and: [{}, true] })).toBe('needs_approval');
    // A field that isn't there compares as null, and null < 1000 is true.
    expect(take({ '<': [{ var: 'order.totl' }, 1000] })).toBe('needs_approval');
    expect(take({ '<': [{ var: 'order.baseTotal' }, 1000] }, { total: 50 })).toBe('needs_approval');
    // JSON Logic's truthiness, not JavaScript's: an empty list doesn't hold.
    expect(take({ filter: [{ var: 'order.lines' }, true] }, { lines: [] })).toBe('needs_approval');
    // A field given a default may be missing.
    expect(take({ '!': [{ var: ['order.meta.flag', ''] }] }, {})).toBe('auto_approve');
  });

  it('guards every route when the stored guards are not an object of rules', () => {
    for (const guards of ['{"auto_approve":true}', [{ '==': [1, 1] }], 7])
      expect(guardRoute('auto_approve', { guards }, ROUTES, ctx({})).route).toBe('needs_approval');
    // A route named like an object's built-in property isn't guarded by accident.
    expect(
      guardRoute('constructor', { guards: underLimit }, [...ROUTES, 'constructor'], ctx({})),
    ).toEqual({ route: 'constructor' });
  });

  it('refuses to take a refused route when there is nowhere to fall back to', () => {
    const routes = ['auto_approve', 'escalate'];
    expect(() =>
      guardRoute('auto_approve', { guards: underLimit }, routes, ctx({ total: 5000 })),
    ).toThrow(/No fallback/);
  });

  it('validates guards against the routes and needs an unguarded fallback', () => {
    expect(routeGuardErrors({ guards: underLimit }, ROUTES)).toEqual([]);
    expect(routeGuardErrors({ guards: { approve_all: { '==': [1, 1] } } }, ROUTES)).toEqual([
      'Guards: “approve_all” is not one of the routes',
    ]);
    expect(routeGuardErrors({ guards: { auto_approve: 'yes' } }, ROUTES)).toEqual([
      'Guards: “auto_approve” needs a JSON Logic condition',
    ]);
    expect(routeGuardErrors({ guards: underLimit }, ['auto_approve', 'escalate'])).toEqual([
      'Fallback: name the route a guarded choice falls back to (or add needs_approval)',
    ]);
    expect(routeGuardErrors({ guards: underLimit, fallback: 'nowhere' }, ROUTES)).toEqual([
      'Fallback: “nowhere” is not one of the routes',
    ]);
    expect(
      routeGuardErrors({ guards: { ...underLimit, needs_approval: { '==': [1, 1] } } }, ROUTES),
    ).toEqual(["Fallback: “needs_approval” can't have a guard"]);
    expect(routeGuardErrors({ guards: { auto_approve: {} } }, ROUTES)).toEqual([
      'Guards: “auto_approve” each part needs exactly one operator',
    ]);
    expect(
      routeGuardErrors({ guards: { auto_approve: { '<': [1, 0], and: [true] } } }, ROUTES),
    ).toEqual(['Guards: “auto_approve” each part needs exactly one operator']);
    expect(routeGuardErrors({ guards: { auto_approve: { and: [{ yes: 1 }] } } }, ROUTES)).toEqual([
      'Guards: “auto_approve” “yes” is not a JSON Logic operator',
    ]);
    // Through the catalog, as the editor and publishing validate a node.
    expect(
      validateConfig('ai.router', { routes: ROUTES, guards: { approve_all: { '==': [1, 1] } } }),
    ).toEqual(['Guards: “approve_all” is not one of the routes']);
  });

  it('holds the B2B template to its own instructions: a known customer under $10,000', () => {
    const priced = (o: Record<string, unknown>) => ({ baseTotal: o.total, ...o });
    const flow = TEMPLATES['tpl-b2b-order']!();
    const router = flow.nodes.find((n) => n.type === 'ai.router')!;
    const config = router.config as Record<string, unknown>;
    expect(validateConfig('ai.router', config)).toEqual([]);
    const take = (order: Record<string, unknown>) =>
      guardRoute('auto_approve', config, ROUTES, ctx(order)).route;
    expect(take(priced({ customerId: 'cus_contoso', total: 9000 }))).toBe('auto_approve');
    expect(take(priced({ customerId: 'cus_contoso', total: 12000 }))).toBe('needs_approval');
    expect(take(priced({ total: 900 }))).toBe('needs_approval');
    // Not priced yet: the guard doesn't hold.
    expect(take({ customerId: 'cus_contoso', total: 900 })).toBe('needs_approval');
    // A customer guessed from what the sender typed isn't a known customer here.
    for (const by of ['name', 'unauthenticated_email', 'email'])
      expect(
        take(priced({ customerId: 'cus_contoso', total: 900, meta: { customerMatchedBy: by } })),
      ).toBe('needs_approval');
    // In the base currency when the order has one: €9,500 at 0.92 is over $10,000.
    expect(take({ customerId: 'cus_contoso', total: 9500, baseTotal: 10_326 })).toBe(
      'needs_approval',
    );
    expect(take({ customerId: 'cus_contoso', total: 9000, baseTotal: 9783 })).toBe('auto_approve');
  });

  it("sends the B2B template's Assess fast track through the same check", () => {
    const flow = TEMPLATES['tpl-b2b-order']!();
    const fastOk = flow.nodes.find((n) => n.id === 'fast_ok')!;
    expect(fastOk.config).toEqual({ expression: B2B_AUTO_APPROVE });
    const to = (source: string, handle: string) =>
      flow.edges.find((e) => e.source === source && e.sourceHandle === handle)?.target;
    expect([to('assess', 'yes'), to('fast_ok', 'true'), to('fast_ok', 'false')]).toEqual([
      'fast_ok',
      'reserve',
      'approval',
    ]);
    const c = (order: Record<string, unknown>) => truthy(B2B_AUTO_APPROVE, ctx(order));
    expect(c({ customerId: 'cus_contoso', total: 900, baseTotal: 900 })).toBe(true);
    expect(c({ customerId: 'cus_contoso', total: 12000, baseTotal: 12000 })).toBe(false);
    expect(
      c({
        customerId: 'cus_contoso',
        total: 900,
        baseTotal: 900,
        meta: { customerMatchedBy: 'name' },
      }),
    ).toBe(false);
  });
});
