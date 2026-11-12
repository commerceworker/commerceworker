import { execFileSync } from 'node:child_process';
import { storefrontOrderFlow } from '@commerceworker/core';
import { now, q, row, STORE_NAME, session, sha256 } from './checkout-seed';

/**
 * What the placed-order spec needs in the engine's database that the other specs must not see: a
 * published checkout flow (the device engine has none, and `checkout.spec.ts` expects that: it
 * ends at the engine's "not set up" refusal), the demo catalog the flow prices from, and a session
 * per device project, retry and variant that a buyer redeems from its start link.
 *
 * The flow is published after the other specs have finished (the `publish` project in
 * playwright.config.ts, which the placed projects depend on), because the storefront's settings
 * name one checkout flow for the whole deployment and the specs share one database.
 */
export const FLOW_ID = 'e2e-hosted-checkout';
/** The demo catalog's monitor, in stock in `packages/db/seed`. */
export const SKU = 'MON-27';

export const PLACED_PROJECTS = ['iphone', 'iphone-landscape', 'ipad', 'ipad-landscape', 'desktop'];
/** One per device project, retry and variant (hydrated `j`, scripts off `n`), so none is spent twice. */
export const placedKey = (project: string, retry: number, scripts: boolean) =>
  `${project.replaceAll('-', '')}${retry}${scripts ? 'j' : 'n'}`;
const KEYS = PLACED_PROJECTS.flatMap((p) =>
  [0, 1, 2].flatMap((r) => [true, false].map((s) => placedKey(p, r, s))),
);
export const placedId = (key: string) => `chk_e2e_placed_${key}`;
export const placedToken = (key: string) => `tok_e2e_placed_${key}`;

const engineConfig = ['--config', '../engine/wrangler.jsonc'];
const target = ['--local', '--persist-to', '.wrangler/e2e', ...engineConfig];

export function seedPlaced() {
  const flow = { ...storefrontOrderFlow(), id: FLOW_ID, name: 'E2E hosted checkout' };
  const graph = JSON.stringify({ nodes: flow.nodes, edges: flow.edges });
  const settings = JSON.stringify({
    storeName: STORE_NAME,
    checkout: { enabled: true, checkoutFlowId: FLOW_ID, editLines: false },
  });
  // Waiting to be redeemed, priced as an operator's `create_checkout` leaves one: one line, a
  // ship-to still to give. The engine reprices it with the flow's own nodes on the first change.
  const line = { id: 'li_1', sku: SKU, title: '27" monitor', qty: 1, unitPrice: 349 };
  const quote = {
    ...session.quote,
    lines: [{ ...line, ships: true, total: 349, listTotal: 349 }],
    listSubtotal: 349,
    subtotal: 349,
    shipping: 12.5,
    tax: 0,
    total: 361.5,
    discounts: { applied: [], refused: [] },
  };
  const waiting = KEYS.map((key) => ({
    ...session,
    id: placedId(key),
    ownerId: `hosted-start:${sha256(placedToken(key))}`,
    lines: [line],
    promoCodes: [],
    quote,
  }));
  const statements = [
    `INSERT OR REPLACE INTO flows (id, name, description, model, channels, graph_json, published_version, created_at, updated_at) VALUES (${q(flow.id)}, ${q(flow.name)}, ${q(flow.description)}, ${q(flow.model)}, ${q(JSON.stringify(flow.channels))}, ${q(graph)}, 1, ${now}, ${now})`,
    `INSERT OR REPLACE INTO flow_versions (flow_id, version, flow_json, published_at, published_by) VALUES (${q(flow.id)}, 1, ${q(JSON.stringify(flow))}, ${now}, 'e2e')`,
    `INSERT OR REPLACE INTO workspace_settings (key, value, updated_at, updated_by) VALUES ('storefront', ${q(settings)}, ${now}, 'e2e')`,
    ...waiting.map((s) => row(s as never)),
  ];
  execFileSync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      'commerceworker',
      ...target,
      '--command',
      statements.join(';'),
    ],
    { stdio: 'pipe' },
  );
  // The demo data (INSERT OR IGNORE): the catalog the flow prices, the stock it reserves.
  execFileSync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      'commerceworker',
      ...target,
      '--file',
      '../../packages/db/seed/0001_demo.sql',
    ],
    { stdio: 'pipe' },
  );
}
