import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import { describe, expect, it } from 'vitest';

const testEnv = env as Env & {
  TEST_MIGRATIONS: D1Migration[];
  TEST_SEED: D1Migration[];
  TEST_DEMO_RESET: D1Migration[];
  DEMO_DB: D1Database;
};

/** Runs SQL files the way `wrangler d1 execute --file` does: every statement, in one batch. */
const run = (db: D1Database, files: D1Migration[]) =>
  db.batch(files.flatMap((f) => f.queries.map((q) => db.prepare(q))));

const count = async (db: D1Database, sql: string) =>
  (await db.prepare(`SELECT count(*) AS n FROM ${sql}`).first<{ n: number }>())!.n;

describe('the demo reset', () => {
  it('removes what visitors made, keeps the people and settings, and the demo data loads again', async () => {
    const db = testEnv.DEMO_DB;
    await applyD1Migrations(db, testEnv.TEST_MIGRATIONS);
    await run(db, testEnv.TEST_SEED);
    const customers = await count(db, 'customers');
    const products = await count(db, 'products');
    const companies = await count(db, 'companies');
    const members = await count(db, 'company_members');
    expect(companies).toBeGreaterThan(0);
    expect(members).toBeGreaterThan(0);

    await db.batch([
      db.prepare(
        `INSERT INTO companies (customer_id, status, legal_name, created_at, updated_at)
         VALUES ('cus_visitor', 'pending', 'Visitor Ltd', 0, 0)`,
      ),
      db.prepare(
        `INSERT INTO company_teams (id, company_id, name, path) VALUES ('team_v', 'cus_visitor', 'V', '/team_v/')`,
      ),
      db.prepare(
        `INSERT INTO budgets (id, company_id, name, amount, period, anchor, created_at, updated_at)
         VALUES ('bud_v', 'cus_visitor', 'V', 10, 'monthly', 0, 0, 0)`,
      ),
      db.prepare(
        `INSERT INTO budget_spend (id, budget_id, order_id, amount, kind, window_start, at)
         VALUES ('bsp_v', 'bud_v', 'ord_v', 5, 'commit', 0, 0)`,
      ),
      db.prepare(
        `INSERT INTO purchase_orders (id, company_id, po_number, created_at, updated_at)
         VALUES ('po_v', 'cus_visitor', 'PO-V', 0, 0)`,
      ),
      db.prepare(
        `INSERT INTO purchase_order_lines (po_id, position, sku, qty) VALUES ('po_v', 0, 'WID-100', 1)`,
      ),
      db.prepare(
        `INSERT INTO company_members (id, company_id, name, email, created_at, updated_at)
         VALUES ('mem_v', 'cus_visitor', 'V', 'v@example.com', 0, 0)`,
      ),
      db.prepare(
        `INSERT INTO flows (id, name, model, graph_json, published_version, created_at, updated_at)
         VALUES ('visitor-flow', 'Mine', 'b2b', '{}', 1, 0, 0)`,
      ),
      db.prepare(
        `INSERT INTO flow_versions (flow_id, version, flow_json, published_at) VALUES ('visitor-flow', 1, '{}', 0)`,
      ),
      db.prepare(
        `INSERT INTO orders (id, model, channel, status, flow_id, flow_version, created_at, updated_at)
         VALUES ('ord_visitor', 'b2b', 'api', 'waiting', 'visitor-flow', 1, 0, 0)`,
      ),
      db.prepare(`UPDATE products SET stock = 0 WHERE sku = 'MON-27'`),
      db.prepare(
        `INSERT INTO customers (id, name, email) VALUES ('cus_visitor', 'Visitor', 'v@example.com')`,
      ),
      db.prepare(
        `INSERT INTO users (id, email, name, role, created_at) VALUES
         ('usr_demo', 'demo@commerceworker.com', 'Demo visitor', 'operator', 0),
         ('usr_owner', 'owner@example.com', 'Owner', 'operator', 0)`,
      ),
      db.prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES
         ('h-demo', 'usr_demo', 0, 9999999999999), ('h-owner', 'usr_owner', 0, 9999999999999)`,
      ),
      db.prepare(`INSERT INTO audit_events (id, at, action) VALUES ('aud_1', 0, 'auth.sign_in')`),
    ]);

    await run(db, testEnv.TEST_DEMO_RESET);
    expect(await count(db, 'companies')).toBe(0);
    expect(await count(db, 'company_teams')).toBe(0);
    expect(await count(db, 'budgets')).toBe(0);
    expect(await count(db, 'budget_spend')).toBe(0);
    expect(await count(db, 'purchase_orders')).toBe(0);
    expect(await count(db, 'purchase_order_lines')).toBe(0);
    expect(await count(db, 'company_members')).toBe(0);
    expect(await count(db, 'orders')).toBe(0);
    expect(await count(db, 'flows')).toBe(0);
    expect(await count(db, 'audit_events')).toBe(0);
    expect(await count(db, "customers WHERE id = 'cus_internal'")).toBe(1);
    expect(await count(db, "fx_rates WHERE currency = 'USD'")).toBe(1);
    expect(await count(db, 'price_sources')).toBeGreaterThan(0);
    expect(await count(db, 'users')).toBe(2);
    expect(await count(db, "sessions WHERE user_id = 'usr_owner'")).toBe(1);
    expect(await count(db, "sessions WHERE user_id = 'usr_demo'")).toBe(0);

    await run(db, testEnv.TEST_SEED);
    expect(await count(db, 'customers')).toBe(customers);
    expect(await count(db, 'products')).toBe(products);
    expect(await count(db, 'companies')).toBe(companies);
    expect(await count(db, 'company_members')).toBe(members);
    expect(await count(db, "products WHERE sku = 'MON-27' AND stock > 0")).toBe(1);
  });
});
