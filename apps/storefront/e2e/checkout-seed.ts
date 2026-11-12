import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * A hosted checkout for the device tests to open. Hosted checkout is off in a fresh database and a
 * session is made through the API (an operator's call the storefront has no way to make), so the
 * device tests' database gets the settings row and one session row directly, as the engine writes
 * them: the session owned by the SHA-256 of a cookie secret the test then presents. The page only
 * reads and draws it, so the quote and the shipping options it holds are what the page shows.
 */
export const CHECKOUT_ID = 'chk_e2e_page';
export const CHECKOUT_SECRET = 'c0'.repeat(32);

const now = Date.now();
const session = {
  id: CHECKOUT_ID,
  ownerId: `hosted:${createHash('sha256').update(CHECKOUT_SECRET).digest('hex')}`,
  status: 'incomplete',
  currency: 'USD',
  lines: [
    {
      id: 'li_1',
      sku: 'MON-27',
      qty: 2,
      title: '27-inch monitor with a very long product name',
      unitPrice: 189.5,
      listPrice: 210,
    },
    { id: 'li_2', sku: 'CBL-1', qty: 1, title: 'USB-C cable', unitPrice: 12 },
  ],
  buyer: {},
  fulfillment: 'ship',
  shipTo: null,
  shippingOption: null,
  pickupLocationId: null,
  pickupStores: [{ id: 'loc_1', name: 'Austin Central', postalCode: '78701' }],
  promoCodes: ['SAVE10', 'BOGUS'],
  quote: {
    currency: 'USD',
    lines: [
      {
        id: 'li_1',
        sku: 'MON-27',
        title: '27-inch monitor with a very long product name',
        qty: 2,
        unitPrice: 189.5,
        listPrice: 210,
        ships: true,
        total: 379,
        listTotal: 420,
      },
      {
        id: 'li_2',
        sku: 'CBL-1',
        title: 'USB-C cable',
        qty: 1,
        unitPrice: 12,
        ships: true,
        total: 12,
        listTotal: 12,
      },
    ],
    listSubtotal: 432,
    subtotal: 391,
    shipping: 12.5,
    tax: 33.4,
    total: 436.9,
    shippingOptions: [
      { id: 'ground', title: 'Ground', carrier: 'UPS', amount: 12.5, minDays: 3, maxDays: 5 },
      {
        id: 'air',
        title: 'Two-day air',
        carrier: 'UPS',
        amount: 0,
        minDays: 2,
        maxDays: 2,
        free: true,
      },
    ],
    shippingOption: 'ground',
    ships: true,
    discounts: {
      applied: [{ code: 'SAVE10', title: '10% off', kind: 'pct', amount: 41 }],
      refused: [{ code: 'BOGUS', reason: 'That code does not exist.' }],
    },
  },
  issues: [
    {
      kind: 'error',
      code: 'missing',
      path: '$.buyer.email',
      content: "The buyer's email is required.",
      severity: 'recoverable',
    },
    {
      kind: 'warning',
      code: 'promotion',
      path: '$.promoCodes',
      content: 'That code does not exist.',
    },
  ],
  orderId: null,
  createdAt: now,
  updatedAt: now,
  expiresAt: now + 6 * 3_600_000,
  version: 1,
};

/** The same checkout in another state: over, being placed, or placed. */
export const ENDED_ID = 'chk_e2e_ended';
export const CLAIMED_ID = 'chk_e2e_claimed';
export const PLACED_ID = 'chk_e2e_placed';
export const PLACED_ORDER = 'ord_e2e_ab12cd';

/**
 * Sessions the specs that submit a form spend, one per device project and retry so that parallel
 * projects and a retried test never share one: `startSession` is waiting to be redeemed by the token
 * `startToken(key)`, and `formSession` is owned by the cookie secret as `CHECKOUT_ID` is.
 */
export const DEVICE_KEYS = [
  'iphone',
  'iphone-landscape',
  'ipad',
  'ipad-landscape',
  'desktop',
].flatMap((p) => [0, 1, 2].map((r) => `${p.replace('-', '')}${r}`));
export const startId = (key: string) => `chk_e2e_start_${key}`;
export const formId = (key: string) => `chk_e2e_form_${key}`;
export const startToken = (key: string) => `tok_e2e_${key}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const spendable = DEVICE_KEYS.flatMap((key) => [
  { ...session, id: startId(key), ownerId: `hosted-start:${sha256(startToken(key))}` },
  { ...session, id: formId(key) },
]);

const others = [
  {
    ...session,
    id: ENDED_ID,
    status: 'canceled',
    issues: [{ kind: 'info', code: 'expired', content: 'This checkout expired.' }],
  },
  { ...session, id: CLAIMED_ID, status: 'complete_in_progress', issues: [] },
  { ...session, id: PLACED_ID, status: 'completed', orderId: PLACED_ORDER, issues: [] },
];

/** `'` doubled, so JSON sits inside a SQL string. */
const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

const row = (s: typeof session) =>
  `INSERT OR REPLACE INTO checkout_sessions (id, owner_id, status, data, order_id, version, created_at, updated_at, expires_at) VALUES (${q(s.id)}, ${q(s.ownerId)}, ${q(s.status)}, ${q(JSON.stringify(s))}, ${s.orderId ? q(s.orderId) : 'NULL'}, 1, ${now}, ${now}, ${s.expiresAt})`;

/** Writes the rows into the device tests' database (`.wrangler/e2e`, as playwright.config.ts names it). */
export function seedCheckout() {
  const settings = JSON.stringify({
    checkout: { enabled: true, checkoutFlowId: null, editLines: false },
  });
  const sql = [
    `INSERT OR REPLACE INTO workspace_settings (key, value, updated_at, updated_by) VALUES ('storefront', ${q(settings)}, ${now}, 'e2e')`,
    row(session),
    ...[...others, ...spendable].map((o) => row(o as typeof session)),
  ].join(';');
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
      sql,
    ],
    { stdio: 'pipe' },
  );
}
