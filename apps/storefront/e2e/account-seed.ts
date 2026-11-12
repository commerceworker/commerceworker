import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hashShopperSecret, SHOPPER_ORDERS_PAGE } from '@commerceworker/core';
import { PROJECTS } from './shopper-seed';

/**
 * A signed-in shopper per device project, with what the account pages list: more orders than a
 * page, a stranger's order and an erased one that must not show, a consumer customer's saved
 * addresses and a business customer's under the same address that must not show either. Written as
 * the engine stores them (a session by the SHA-256 of its secret, which the test presents as the
 * cookie). Each project has its own address, so the five run at once without sharing a row, and a
 * second shopper per project whose addresses the forget test is free to change.
 *
 * The orders are index rows only: an order's detail page reads its agent's state, which a row
 * can't stand in for, so the device tests open one to see it refused, as a stranger's is.
 */
export const ORDER_COUNT = SHOPPER_ORDERS_PAGE + 3;
export const FORGET_COUNT = 12;

const BASE = Date.UTC(2026, 10, 1);

export const accountSeed = (project: string) => ({
  email: `${project}-acct@e2e.test`,
  secret: createHash('sha256').update(`e2e-acct-${project}`).digest('hex'),
  forgetEmail: `${project}-forget@e2e.test`,
  forgetSecret: createHash('sha256').update(`e2e-forget-${project}`).digest('hex'),
  /** Order `n`, newest (0) first. */
  orderId: (n: number) => `ord_e2e_${project}_${String(n).padStart(2, '0')}`,
  stranger: `ord_e2e_${project}_stranger`,
  erased: `ord_e2e_${project}_erased`,
  /** The ref the list shows for order `n`. */
  ref: (n: number) => `#${`ord_e2e_${project}_${String(n).padStart(2, '0')}`.slice(-6)}`,
});

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

const order = (id: string, email: string | null, at: number, status: string, extra = '') =>
  `INSERT OR REPLACE INTO orders (id, model, channel, contact_email, status, title, flow_id, flow_version, currency, total, created_at, updated_at${extra ? ', erased_at' : ''}) VALUES (${q(id)}, 'b2c', 'web', ${email ? q(email) : 'NULL'}, ${q(status)}, 'E2E order', 'tpl-pos-sale', 1, 'USD', ${(at % 997) / 10 + 5}, ${at}, ${at}${extra})`;

const place = (id: string, customerId: string, line1: string, at: number) =>
  `INSERT OR REPLACE INTO customer_addresses (id, customer_id, key, name, line1, city, region, postal_code, country, orders, first_used_at, last_used_at, last_order_id) VALUES (${q(id)}, ${q(customerId)}, ${q(line1.toLowerCase())}, 'Pat Buyer', ${q(line1)}, 'Springfield', 'IL', '62701', 'US', 1, ${at}, ${at}, 'ord_e2e_x')`;

const customer = (id: string, email: string, kind: string) =>
  `INSERT OR REPLACE INTO customers (id, name, email, kind) VALUES (${q(id)}, 'Pat Buyer', ${q(email)}, ${q(kind)})`;

export async function seedAccounts() {
  const now = Date.now();
  const rows: string[] = [];
  for (const p of PROJECTS) {
    const s = accountSeed(p);
    for (const [email, secret] of [
      [s.email, s.secret],
      [s.forgetEmail, s.forgetSecret],
    ] as const)
      rows.push(
        `INSERT OR REPLACE INTO shopper_sessions (token_hash, email, created_at, expires_at, last_seen_at) VALUES (${q(await hashShopperSecret(secret))}, ${q(email)}, ${now - 3_600_000}, ${now + 6 * 3_600_000}, ${now})`,
      );
    for (let n = 0; n < ORDER_COUNT; n++)
      rows.push(
        order(
          s.orderId(n),
          // One in the address's other case: orders are found by the address, not its spelling.
          n === 1 ? s.email.toUpperCase() : s.email,
          BASE - n * 60_000,
          ['completed', 'running', 'cancelled'][n % 3]!,
        ),
      );
    rows.push(order(s.stranger, `stranger-${p}@e2e.test`, BASE + 60_000, 'completed'));
    rows.push(order(s.erased, null, BASE + 120_000, 'completed', `, ${BASE}`));
    rows.push(
      customer(`cus_e2e_${p}_consumer`, s.email, 'consumer'),
      customer(`cus_e2e_${p}_business`, s.email, 'business'),
      customer(`cus_e2e_${p}_forget`, s.forgetEmail, 'consumer'),
      place(`adr_e2e_${p}_1`, `cus_e2e_${p}_consumer`, '1 Main St', BASE),
      place(`adr_e2e_${p}_2`, `cus_e2e_${p}_consumer`, '9 Oak Ave', BASE - 86_400_000),
      place(`adr_e2e_${p}_biz`, `cus_e2e_${p}_business`, '77 Dock Rd', BASE + 1),
    );
    // Enough that the forget test, run again or retried, still has one to forget.
    for (let i = 0; i < FORGET_COUNT; i++)
      rows.push(
        place(`adr_e2e_${p}_f${i}`, `cus_e2e_${p}_forget`, `${i + 5} Pine Rd`, BASE - i * 1000),
      );
  }
  execFileSync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      'commerceworker',
      '--local',
      '--persist-to',
      '.wrangler/e2e',
      '--config',
      '../engine/wrangler.jsonc',
      '--command',
      rows.join(';'),
    ],
    { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 },
  );
}
