/**
 * The fleet: one CommerceWorker deployment per customer, each listed in deployments/<id>.jsonc.
 *
 *   node scripts/fleet.ts render <id>             write apps/{catalog,delivery,engine,storefront,web}/wrangler.<id>.json
 *                                                 (and, with `content`, apps/{pipeline,media,api,studio}/)
 *                                                 and plugins/<plugin>/wrangler.<id>.json for each plugin
 *   node scripts/fleet.ts matrix                  print the deployments of each ring for CI
 *   node scripts/fleet.ts secrets <engine|storefront|web> <out> [id]  write this app's secrets from the
 *                                                 environment, refusing ones deployment <id> can't run on
 *   node scripts/fleet.ts secrets <pipeline|media|api|delivery|studio> <out> <id>  the same for a
 *                                                 content Worker (deployment <id> needs `content`)
 *   node scripts/fleet.ts secrets plugin <out> <plugin> [id]  write a plugin's own keys, derived, and
 *                                                 its PLUGIN_<ID>_* secrets from ENV_SECRETS (none
 *                                                 when deployment <id> has a Secrets Store)
 *   node scripts/fleet.ts secrets sandboxed <engine secrets file> <id>  add PLUGIN_SECRETS for its
 *                                                 sandboxed plugins (shared account)
 *   node scripts/fleet.ts check-plugin-secrets <id> <plugin> <manifest.json>  fail if a secret the
 *                                                 plugin needs isn't set (STORE_SECRET_NAMES or ENV_SECRETS)
 *   node scripts/fleet.ts status                  deep health of every deployment
 *   node scripts/fleet.ts write-check <id>        the deploy smoke test's write check, signed with
 *                                                 PRINCIPAL_KEY from the environment
 *   node scripts/fleet.ts names <id>              resource names, as shell variables (provisioning)
 *   node scripts/fleet.ts logpush <id>            its Logpush job's name, bucket, filter and fields, as JSON
 *   node scripts/fleet.ts logpush-foreign <id>    fail if another Logpush job (the API's list, on stdin)
 *                                                 would take its Workers' logs
 *   node scripts/fleet.ts logpush-token <id> <account> [check <group id>]  the Logpush R2 token to
 *                                                 create (permission groups on stdin), or check one (token on stdin)
 *   node scripts/fleet.ts set-d1 <id> <uuid>      record the D1 database id in the registry
 *   node scripts/fleet.ts set-standby-d1 <id> <uuid>  record the standby D1 database id (with redundancy)
 *   node scripts/fleet.ts set-catalog-kv <id> <kv id>  record the catalog's card KV namespace id
 *   node scripts/fleet.ts set-plugin-d1 <id> <plugin> <uuid>  record a plugin's D1 database id
 *   node scripts/fleet.ts set-content-d1 <id> <uuid>  record the content database id (content only)
 *   node scripts/fleet.ts set-content-kv <id> <kv id>  record the content cache's KV namespace id
 *   node scripts/fleet.ts demos                   the provisioned demo deployments, for the nightly reset
 *
 * A rendered config is the app's wrangler.jsonc with the deployment's names, ids and domain put
 * in, written next to it so its relative paths still resolve. See docs/operations.md.
 */

import { createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEdits, modify, type ParseError, parse, printParseErrorCode } from 'jsonc-parser';
import { deriveAssistantKey } from './derive-assistant-key.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RINGS = ['staging', 'internal', 'canary', 'general'] as const;
/** Ids a customer can't have: their `<id>.commerceworker.com` would read as part of CommerceWorker. */
const RESERVED = new Set([
  'admin',
  'api',
  'app',
  'auth',
  'billing',
  'blog',
  'catalog',
  'cdn',
  'console',
  'dashboard',
  'demo',
  'dev',
  'docs',
  'email',
  'help',
  'in',
  'internal',
  'login',
  'mail',
  'mcp',
  'preview',
  'prod',
  'production',
  'sandbox',
  'staging',
  'status',
  'support',
  'test',
  'www',
]);
type Ring = (typeof RINGS)[number];

/** Each app's secrets, read from the deploy job's environment (a GitHub environment's secrets). */
export const SECRETS = {
  // (The storefront's are derived, not read as they are: `storefrontSecrets`.)
  web: [
    'PRINCIPAL_KEY',
    'DATA_KEY',
    'DATA_KEY_PREVIOUS',
    'SETUP_TOKEN',
    'SHOPIFY_WEBHOOK_SECRET',
    'SHOPIFY_SHOPS',
    'PASSWORD_PEPPER',
    'STRIPE_WEBHOOK_SECRET',
    'OIDC_CLIENT_SECRET',
    'TURNSTILE_SECRET_KEY',
  ],
  engine: [
    'PRINCIPAL_KEY',
    'PRINCIPAL_KEY_PREVIOUS',
    'DATA_KEY',
    'DATA_KEY_PREVIOUS',
    'INTAKE_ALLOWLIST',
    'SHIPPING_CARRIER_AUTH',
    'STRIPE_SECRET_KEY',
    // Public text, kept as a secret only for where a deploy reads it from: Stripe's Apple Pay
    // domain verification file, which the storefront serves (docs/operations.md).
    'APPLE_PAY_DOMAIN_ASSOCIATION',
    'UCP_SIGNING_KEY',
  ],
} as const;

/**
 * The content Workers' secrets (a deployment with `content`), read from the same environment. Every
 * Worker gets only its own; the same PRINCIPAL_KEY, DATA_KEY and PASSWORD_PEPPER as the commerce
 * Workers' hold, since one GitHub environment holds the deployment's. The pipeline's assistant keys
 * are derived (`DERIVED`), never read: it never holds PRINCIPAL_KEY.
 */
export const CONTENT_SECRETS = {
  studio: [
    'PRINCIPAL_KEY',
    'PRINCIPAL_KEY_PREVIOUS',
    'DATA_KEY',
    'DATA_KEY_PREVIOUS',
    'SETUP_TOKEN',
    'PASSWORD_PEPPER',
    'OIDC_CLIENT_SECRET',
  ],
  api: [
    'PRINCIPAL_KEY',
    'PRINCIPAL_KEY_PREVIOUS',
    'DATA_KEY',
    'DATA_KEY_PREVIOUS',
    'TOKEN_PEPPER',
    'MEDIA_SIGNING_SECRET',
    'STREAM_WEBHOOK_SECRET',
    'MCP_TOKEN',
    'ADMIN_TOKEN',
  ],
  pipeline: [
    'ASSISTANT_PRINCIPAL_KEY',
    'ASSISTANT_PRINCIPAL_KEY_PREVIOUS',
    'DATA_KEY',
    'DATA_KEY_PREVIOUS',
    'TOKEN_PEPPER',
    'MEDIA_SIGNING_SECRET',
  ],
  delivery: ['DATA_KEY', 'DATA_KEY_PREVIOUS', 'TOKEN_PEPPER', 'MEDIA_SIGNING_SECRET'],
  // Verifies Preview's short-lived signed draft reads; it signs nothing and reads no secret at rest.
  media: ['MEDIA_SIGNING_SECRET'],
} as const;
export type ContentApp = keyof typeof CONTENT_SECRETS;

/**
 * Secrets no environment holds: `secrets` derives each from the one named, so rotating that one
 * rotates it (the previous from the previous). The pipeline's assistant principal key is HKDF of
 * PRINCIPAL_KEY (`deriveAssistantPrincipalKey` in @commerceworker/security).
 */
export const DERIVED: Record<string, { from: string; derive: (secret: string) => string }> = {
  ASSISTANT_PRINCIPAL_KEY: { from: 'PRINCIPAL_KEY', derive: deriveAssistantKey },
  ASSISTANT_PRINCIPAL_KEY_PREVIOUS: { from: 'PRINCIPAL_KEY_PREVIOUS', derive: deriveAssistantKey },
};

/** The deploy job's environment with the derived secrets added (never echoed). */
export function withDerived(env: Record<string, string | undefined>) {
  const out = { ...env };
  for (const [name, { from, derive }] of Object.entries(DERIVED)) {
    const source = env[from];
    out[name] = source ? derive(source) : undefined;
  }
  return out;
}

/**
 * Secrets a deploy can't go without, so without them in the environment the deploy stops here,
 * before migrating anything. PRINCIPAL_KEY signs every request the web Worker forwards to the
 * engine; DATA_KEY encrypts the secrets both Workers store (two-factor, webhook and integration
 * secrets, A2A push credentials).
 */
const REQUIRED_SECRETS = ['PRINCIPAL_KEY', 'DATA_KEY'] as const;
/**
 * What a `content` deployment also can't go without: TOKEN_PEPPER is in every API key hash and
 * MEDIA_SIGNING_SECRET signs every media URL, so neither may change once the content Workers run.
 */
const CONTENT_REQUIRED_SECRETS = ['TOKEN_PEPPER', 'MEDIA_SIGNING_SECRET'] as const;

/** The shared keys, and the ones before them during a rotation: each at least this long. */
const KEYS = [
  'PRINCIPAL_KEY',
  'PRINCIPAL_KEY_PREVIOUS',
  'DATA_KEY',
  'DATA_KEY_PREVIOUS',
  'PASSWORD_PEPPER',
  'TOKEN_PEPPER',
  'MEDIA_SIGNING_SECRET',
] as const;
export const MIN_KEY_LENGTH = 32;

/**
 * Why the shared keys can't be used, or null: one set but shorter than `MIN_KEY_LENGTH`
 * characters is guessable offline from anything it signed. `provision.sh` makes 64 hex digits.
 */
export function keysProblem(env: Record<string, string | undefined>): string | null {
  const short = KEYS.filter((k) => env[k] && env[k]!.length < MIN_KEY_LENGTH);
  return short.length
    ? `${short.join(', ')} must be at least ${MIN_KEY_LENGTH} characters (openssl rand -hex 32)`
    : null;
}

/** Days a deployment keeps its catalog backups when its registry doesn't say. */
export const CATALOG_BACKUP_DAYS = 90;

/** What `redundancy` can switch off one by one (`except`); later slices act on the others. */
export const REDUNDANCY_PARTS = [
  'd1Backup',
  'objectBackup',
  'r2Replica',
  'kvBackup',
  'queues',
  'email',
  'intake',
  'aiFallback',
  'alerts',
  'canary',
  'readReplicas',
] as const;
export type RedundancyPart = (typeof REDUNDANCY_PARTS)[number];

export const OFFSITE_PROVIDERS = ['s3', 'gcs', 'azure'] as const;
export type OffsiteProvider = (typeof OFFSITE_PROVIDERS)[number];

/** The registry's `redundancy`, with its defaults. `alerts` and `offsite` are checked but not acted on yet. */
export type Redundancy = {
  /** Days the commerce D1 backups are kept and locked: at least 31, at most `personalDataRetentionDays`. Default 35. */
  backupDays: number;
  /** The hour (UTC) the daily backup starts. Default 1. */
  backupHourUtc: number;
  /** How often the restore drill runs: Sundays or the 1st of the month. Default weekly. */
  drill: 'weekly' | 'monthly';
  except: RedundancyPart[];
  alerts?: { webhook?: string; pagerduty?: string };
  offsite?: { provider: OffsiteProvider; bucket: string; region: string };
};

export const REDUNDANCY_BACKUP_DAYS = 35;

/**
 * Days the logs bucket keeps Workers' pushed logs when the registry doesn't say: past a year, so an
 * incident found at an annual review still has its logs, and the same as audit retention.
 */
export const LOG_RETENTION_DAYS = 400;
/** Workers Logs itself keeps 7 days; less than a month here would add little to that. */
export const MIN_LOG_RETENTION_DAYS = 30;

export type Deployment = {
  id: string;
  ring: Ring;
  /** Unique per deployment: keeps each one's rate-limit counters apart. */
  slot: number;
  /** Defaults to `<id>.commerceworker.com`. */
  domain: string;
  /** The public catalog API's host. Defaults to `catalog.<domain>`. */
  catalogDomain: string;
  /** The storefront's host: buyers' pages and agentic checkout. Defaults to `shop.<domain>`. */
  storefrontDomain: string;
  /**
   * The content stack: published content (the studio, the content API, the content engine) and the
   * assets service, each with a separate content database. Default false: a commerce-only
   * deployment renders and deploys none of it.
   */
  content: boolean;
  /** The content admin's host. Only with `content`, defaulting to `studio.<domain>` (`contentHosts`). */
  studioDomain?: string;
  /** The Content Management, Preview, MCP and OAuth API's host. Only with `content`; defaults to `api.<domain>`. */
  apiDomain?: string;
  /** Delivery's content side (its catalog stays at `catalogDomain`). Only with `content`; defaults to `cdn.<domain>`. */
  cdnDomain?: string;
  /** The assets service's host. Only with `content`; defaults to `media.<domain>`. */
  mediaDomain?: string;
  /**
   * The content space and environment a product's `asset:<assetId>` reference resolves in (the
   * media Worker's `/a/` route). Only with `content`; defaults to `space-1` and `main`.
   */
  mediaScope?: { space: string; environment: string };
  /** Appended to every resource name. Defaults to `-<id>`; app.commerceworker.com's own is `""`. */
  suffix: string;
  /** The GitHub environment holding this deployment's secrets. Defaults to `deploy-<id>`. */
  environment: string;
  /** Set by scripts/provision.sh; required to render or deploy. */
  d1Id?: string;
  /**
   * The standby D1 database (`commerceworker-standby<suffix>`) the restore drill rebuilds the
   * newest backup in, and the database to promote after a loss. Set by scripts/provision.sh;
   * required to render with `redundancy`, and never the same database as `d1Id`.
   */
  standbyD1Id?: string;
  /**
   * Redundancy: daily D1 backups and a restore drill (docs/operations.md, "Redundancy"). Off
   * (undefined) renders, provisions and deploys what a deployment without it always did.
   */
  redundancy?: Redundancy;
  /** The catalog's card KV namespace id. Set by scripts/provision.sh; required like d1Id. */
  catalogKvId?: string;
  /** The content database (`commerceworker-content<suffix>`). Set by scripts/provision.sh; required with `content`. */
  contentD1Id?: string;
  /** The content stack's cache KV namespace id. Set by scripts/provision.sh; required with `content`. */
  contentKvId?: string;
  /** Data location for D1 and R2 (`eu`), set when they're created. */
  jurisdiction?: 'eu' | 'fedramp';
  /** Skipped by CI: stays on what it runs now. */
  hold: boolean;
  /** Deploys the docs site after it (the commerceworker deployment only). */
  docs: boolean;
  /**
   * A public demo: the demo data is loaded on each deploy and nightly, visitors sign in with one
   * click, models are mocked and waits run 1440× faster. Never on a customer's deployment.
   */
  demo: boolean;
  /** Requests a minute per caller, where this customer needs other than the base budgets. */
  limits?: Partial<Record<LimitKey, number>>;
  /** Days audit events are kept before they're archived to R2 and deleted (at least 90). */
  auditRetentionDays?: number;
  /** Days after an order finishes that its buyer's personal data is erased (at least 30). */
  personalDataRetentionDays?: number;
  /** Days the R2 archive keeps audit events past the database's retention; unset keeps them. */
  auditArchiveDays?: number;
  /**
   * Days the catalog's daily backups are kept, and locked against deletion (at least 31, so a
   * backup outlives Durable Objects' 30 days of point-in-time recovery). Default 90.
   */
  catalogBackupDays: number;
  /**
   * Days the logs bucket (`commerceworker-logs<suffix>`) keeps what Logpush writes there, the Workers'
   * trace events (at least 30). Default 400, or `personalDataRetentionDays` when that is set,
   * which it may not exceed: erasure never reaches the logs.
   */
  logRetentionDays: number;
  /** Model tokens a person's assistant may use a day (0: no limit); unset keeps the base. */
  assistantDailyTokens?: number;
  /** `send` lets workflow AI nodes see buyers' personal data; the default, `redact`, doesn't. */
  aiPersonalData: 'redact' | 'send';
  /** Whether the AI Gateway keeps request logs (prompts and responses). Default false. */
  aiGatewayLogs: boolean;
  /**
   * Currencies the deployment sells in besides the base (USD), whose exchange rates the engine's
   * daily cron refreshes from the ECB. Default none.
   */
  fxCurrencies: string[];
  /**
   * The customer's OpenID Connect identity provider for single sign-on: its issuer (https, as its
   * discovery document names it) and this deployment's client id. The client secret is the
   * environment's OIDC_CLIENT_SECRET; the redirect URI to register is https://<domain>/login/sso/callback.
   */
  sso?: { issuer: string; clientId: string; trustEmail?: boolean };
  /**
   * Cloudflare Email Sending for the engine: the address mail goes from (`from`, on a domain
   * onboarded to Email Sending with `wrangler email sending enable <domain>`) and an optional
   * display name. It adds the engine's `send_email` binding (EMAIL) and sets EMAIL_FROM and
   * EMAIL_FROM_NAME. Without it the engine sends no email: an order confirmation is recorded
   * unsent and says so.
   */
  email?: { from: string; fromName?: string };
  /**
   * The site key of this deployment's Turnstile widget (public; scripts/provision.sh creates the
   * widget and prints it). With it, password sign-in and /setup ask for a Turnstile check, and so
   * does a card payment on the storefront's hosted checkout; the web Worker and the storefront
   * verify them with the environment's TURNSTILE_SECRET_KEY: a deploy then requires
   * that secret. Without it, neither page shows a check. Cloudflare's test keys (1x…–3x…) only
   * on a demo.
   */
  turnstileSiteKey?: string;
  /**
   * How the engine takes payments: `mock` records them without taking money; `stripe` authorizes,
   * captures and refunds through Stripe with the environment's STRIPE_SECRET_KEY, which a deploy
   * then requires. Written explicitly on every canary or general deployment and on every one with
   * a `storefrontDomain` that isn't a demo (`paymentsProblem`); elsewhere an unset field is `mock`.
   */
  payments: 'mock' | 'stripe';
  /** Whether the registry file wrote `payments` itself (see `paymentsProblem`). */
  paymentsSet: boolean;
  /**
   * The Stripe publishable key (pk_…) of the same account and mode as STRIPE_SECRET_KEY. Agentic
   * checkout's Stripe payment handler gives it to platforms to tokenize cards with; without it no
   * handler is offered, and the storefront's hosted checkout takes cards, which needs a
   * `turnstileSiteKey`. Only with `payments: "stripe"`.
   */
  stripePublishableKey?: string;
  /**
   * Installed plugins (plugins/<id>/). A `worker` plugin (the default `runtime`) has its own Worker
   * and D1 database, bound to the engine and the web Worker as PLUGIN_<ID>; `d1Id` is set by
   * scripts/provision.sh. A `sandboxed` one is a bundle CI publishes to the deployment's DOCS
   * bucket, pinned in the engine's PLUGIN_BUNDLES, and loaded by the engine; it needs no Worker,
   * binding or database of its own. `secrets` names the plugin's secrets, needed with
   * `secretsStore`. Removing an entry uninstalls the plugin on the next deploy; see docs/plugins.md.
   */
  plugins: Record<string, PluginEntry>;
  /**
   * The deployment's Cloudflare Secrets Store, for a deployment on its own Cloudflare account:
   * plugin secrets are then read from it (as PLUGIN_<ID>_<NAME>) instead of the GitHub environment.
   * Leave it out on a shared account (one store and 100 secrets an account).
   */
  secretsStore?: { storeId: string };
  /**
   * Runtime installs: an admin may install a sandboxed plugin from its Plugins page when its bundle
   * is signed by one of these publishers (name → Ed25519 public key, raw 32 bytes, base64url, as
   * `pnpm plugin:pack keygen` prints it). Absent, runtime installs are off. `assistant: true` also
   * lets the workspace assistant draft business-rule plugins for an admin to review and approve.
   */
  pluginInstalls?: { publishers?: Record<string, string>; assistant?: true };
};

/** What a plugin may ask of the core through COMMERCEWORKER (`PLUGIN_CAPABILITIES` in core). */
const PLUGIN_CAPABILITIES = ['carts:external', 'orders:start', 'orders:cancel'];

/**
 * Top-level path segments the web app serves itself: its pages (apps/web/app/routes.ts) and what
 * its Worker answers before them (apps/web/workers/app.ts). A plugin alias may not be one of them;
 * fleet.test.ts reads both files so a new route can't be missed. A plugin's aliases are served by
 * the web Worker alone: the storefront's paths (`/cart`, `/ucp`) are on another host.
 */
export const RESERVED_PATH_SEGMENTS = new Set([
  'account',
  'agents',
  'api',
  'approvals',
  'assets',
  'audit',
  'a2a',
  'carts',
  'catalog',
  'commerce',
  'customers',
  'docs',
  'flows',
  'health',
  'login',
  'logout',
  'mcp',
  'oauth',
  'orders',
  'performance',
  'plugins',
  'price-books',
  'promotions',
  'purchase-orders',
  'quotes',
  'scim',
  'setup',
  'team',
]);

/** A plugin alias: one lowercase path segment, as `/<segment>/`. */
const ALIAS_RE = /^\/([a-z][a-z0-9-]{1,30})\/$/;

export type PluginEntry = {
  /** Another path the plugin's pages answer at, besides `/plugins/<id>/` (e.g. `/punchout/`). */
  alias?: string;
  d1Id?: string;
  personalData?: 'send';
  capabilities?: string[];
  runtime?: 'worker' | 'sandboxed';
  secrets?: string[];
};

/** Ids whose binding would be one of the engine's plugin variables (`RESERVED_IDS` in core). */
const RESERVED_PLUGIN_IDS = new Set([
  'bundles',
  'secrets',
  'grants',
  'key',
  'storage',
  'dev-bundles',
  'publishers',
]);

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,62}$/;

/** How a deployment runs a plugin. */
export const runtimeOf = (d: Deployment, p: string) => d.plugins[p]?.runtime ?? 'worker';
export const workerPlugins = (d: Deployment) =>
  Object.keys(d.plugins)
    .filter((p) => runtimeOf(d, p) === 'worker')
    .sort();
export const sandboxedPlugins = (d: Deployment) =>
  Object.keys(d.plugins)
    .filter((p) => runtimeOf(d, p) === 'sandboxed')
    .sort();

/** Test fixtures in plugins/ that no deployment may install. */
const FIXTURE_PLUGINS = new Set(['example', 'fixture-carrier']);

/** A plugin's binding name, as `pluginBinding` in @commerceworker/core makes it: "qbd-sync" → "PLUGIN_QBD_SYNC". */
export const pluginBinding = (id: string) => `PLUGIN_${id.toUpperCase().replaceAll('-', '_')}`;

/** The registry's `limits` keys, and the web Worker's rate-limit binding each one sets. */
const LIMITS = {
  api: 'API_LIMIT',
  agents: 'AGENT_LIMIT',
  catalog: 'CATALOG_LIMIT',
  webhooks: 'WEBHOOK_LIMIT',
} as const;
type LimitKey = keyof typeof LIMITS;

function readJsonc(path: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parse(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length) {
    const e = errors[0]!;
    throw new Error(`${path}: ${printParseErrorCode(e.error)} at offset ${e.offset}`);
  }
  return value;
}

/** The registry's content host fields, and the label each defaults to under the deployment's domain. */
const CONTENT_HOSTS = {
  studioDomain: 'studio',
  apiDomain: 'api',
  cdnDomain: 'cdn',
  mediaDomain: 'media',
} as const;
const HOST_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

/** The registry's `redundancy` and `standbyD1Id`, validated, with the defaults filled in. */
function redundancyOf(
  raw: Record<string, unknown>,
  file: string,
  personal: number | undefined,
): Redundancy | undefined {
  const r = raw.redundancy;
  if (raw.standbyD1Id !== undefined) {
    if (typeof raw.standbyD1Id !== 'string' || !raw.standbyD1Id)
      throw new Error(`${file}: standbyD1Id must be the standby D1 database's id`);
    if (raw.standbyD1Id === raw.d1Id)
      throw new Error(`${file}: standbyD1Id is the live database (d1Id): a restore would wipe it`);
  }
  if (r === undefined || r === false) {
    if (raw.standbyD1Id !== undefined) throw new Error(`${file}: standbyD1Id needs redundancy`);
    return undefined;
  }
  if (r !== true && (typeof r !== 'object' || r === null || Array.isArray(r)))
    throw new Error(
      `${file}: redundancy must be true or { "backupDays"?, "backupHourUtc"?, "drill"?, "except"?, "alerts"?, "offsite"? }`,
    );
  if (raw.demo === true) throw new Error(`${file}: a demo has no data to keep: drop redundancy`);
  const o = r === true ? {} : (r as Record<string, unknown>);
  const known = ['backupDays', 'backupHourUtc', 'drill', 'except', 'alerts', 'offsite'];
  const unknown = Object.keys(o).filter((k) => !known.includes(k));
  if (unknown.length)
    throw new Error(
      `${file}: redundancy has no ${unknown.join(', ')} (it has ${known.join(', ')})`,
    );

  // Keeping a backup longer than the personal data its rows hold would keep what erasure removed.
  const days =
    o.backupDays ??
    (personal === undefined ? REDUNDANCY_BACKUP_DAYS : Math.min(REDUNDANCY_BACKUP_DAYS, personal));
  if (!Number.isInteger(days) || (days as number) < 31)
    throw new Error(
      `${file}: redundancy.backupDays must be a whole number of days, at least 31${personal !== undefined && personal < 31 ? ` (personalDataRetentionDays ${personal} is too short to keep backups under it)` : ''}`,
    );
  if (personal !== undefined && (days as number) > personal)
    throw new Error(
      `${file}: redundancy.backupDays (${days}) can't be longer than personalDataRetentionDays (${personal}): backups would keep personal data the sweep erased`,
    );
  const hour = o.backupHourUtc ?? 1;
  if (!Number.isInteger(hour) || (hour as number) < 0 || (hour as number) > 23)
    throw new Error(`${file}: redundancy.backupHourUtc must be a whole hour from 0 to 23 (UTC)`);
  const drill = o.drill ?? 'weekly';
  if (drill !== 'weekly' && drill !== 'monthly')
    throw new Error(`${file}: redundancy.drill must be "weekly" or "monthly"`);
  const except = o.except ?? [];
  if (!Array.isArray(except))
    throw new Error(`${file}: redundancy.except must be a list of ${REDUNDANCY_PARTS.join(', ')}`);
  const bad = except.filter((e) => !(REDUNDANCY_PARTS as readonly unknown[]).includes(e));
  if (bad.length)
    throw new Error(
      `${file}: redundancy.except names ${bad.map(String).join(', ')}, which isn't one of ${REDUNDANCY_PARTS.join(', ')}`,
    );

  let alerts: Redundancy['alerts'];
  if (o.alerts !== undefined) {
    const a = o.alerts as Record<string, unknown>;
    if (typeof a !== 'object' || a === null || Array.isArray(a))
      throw new Error(`${file}: redundancy.alerts must be { "webhook"?, "pagerduty"? }`);
    const extra = Object.keys(a).filter((k) => k !== 'webhook' && k !== 'pagerduty');
    if (extra.length) throw new Error(`${file}: redundancy.alerts has no ${extra.join(', ')}`);
    if (
      a.webhook !== undefined &&
      (typeof a.webhook !== 'string' || !/^https:\/\/\S+$/.test(a.webhook))
    )
      throw new Error(`${file}: redundancy.alerts.webhook must be an https URL`);
    if (a.pagerduty !== undefined && (typeof a.pagerduty !== 'string' || !a.pagerduty.trim()))
      throw new Error(`${file}: redundancy.alerts.pagerduty must be a routing key`);
    alerts = a as Redundancy['alerts'];
  }
  let offsite: Redundancy['offsite'];
  if (o.offsite !== undefined) {
    const f = o.offsite as Record<string, unknown>;
    if (typeof f !== 'object' || f === null || Array.isArray(f))
      throw new Error(`${file}: redundancy.offsite must be { "provider", "bucket", "region" }`);
    const extra = Object.keys(f).filter((k) => !['provider', 'bucket', 'region'].includes(k));
    if (extra.length) throw new Error(`${file}: redundancy.offsite has no ${extra.join(', ')}`);
    if (!(OFFSITE_PROVIDERS as readonly unknown[]).includes(f.provider))
      throw new Error(
        `${file}: redundancy.offsite.provider must be one of ${OFFSITE_PROVIDERS.join(', ')}`,
      );
    for (const k of ['bucket', 'region'] as const)
      if (typeof f[k] !== 'string' || !(f[k] as string).trim())
        throw new Error(`${file}: redundancy.offsite.${k} must be a non-empty string`);
    offsite = f as Redundancy['offsite'];
  }
  return {
    backupDays: days as number,
    backupHourUtc: hour as number,
    drill,
    except: [...new Set(except as RedundancyPart[])],
    ...(alerts ? { alerts } : {}),
    ...(offsite ? { offsite } : {}),
  };
}

/** Whether the commerce D1 is backed up and drilled: `redundancy` on, `d1Backup` not an exception. */
export const backsUpD1 = (d: Deployment): d is Deployment & { redundancy: Redundancy } =>
  !!d.redundancy && !d.redundancy.except.includes('d1Backup');

/** The two Workflows' cron schedules: the backup daily, the drill six hours later on Sundays or the 1st. */
/** Whether `DOCS` has a replica: `redundancy` on, `r2Replica` not an exception. */
export const replicatesDocs = (d: Deployment): d is Deployment & { redundancy: Redundancy } =>
  !!d.redundancy && !d.redundancy.except.includes('r2Replica');

export function redundancySchedules(r: Redundancy) {
  const drillHour = (r.backupHourUtc + 6) % 24;
  return {
    backup: `0 ${r.backupHourUtc} * * *`,
    restore: r.drill === 'monthly' ? `0 ${drillHour} 1 * *` : `0 ${drillHour} * * 0`,
  };
}

export function toDeployment(raw: Record<string, unknown>, file = 'deployment'): Deployment {
  const id = raw.id;
  if (typeof id !== 'string' || !/^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){1,30}$/.test(id))
    throw new Error(`${file}: id must be lowercase letters, digits and dashes`);
  // CommerceWorker's own deployments name their domain; a customer's comes from the id.
  if (RESERVED.has(id) && typeof raw.domain !== 'string')
    throw new Error(
      `${file}: "${id}" is reserved for CommerceWorker; choose another id or set domain`,
    );
  const ring = raw.ring as Ring;
  if (!RINGS.includes(ring)) throw new Error(`${file}: ring must be one of ${RINGS.join(', ')}`);
  if (!Number.isInteger(raw.slot) || (raw.slot as number) < 1 || (raw.slot as number) > 999)
    throw new Error(`${file}: slot must be an integer from 1 to 999`);
  if (raw.d1Id !== undefined && (typeof raw.d1Id !== 'string' || !raw.d1Id))
    throw new Error(`${file}: d1Id must be the D1 database's id`);
  if (
    raw.catalogDomain !== undefined &&
    (typeof raw.catalogDomain !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(raw.catalogDomain))
  )
    throw new Error(`${file}: catalogDomain must be a host name`);
  if (
    raw.storefrontDomain !== undefined &&
    (typeof raw.storefrontDomain !== 'string' ||
      !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(raw.storefrontDomain))
  )
    throw new Error(`${file}: storefrontDomain must be a host name`);
  // The content stack is opt-in: what only it uses can't be set without it.
  if (raw.content !== undefined && typeof raw.content !== 'boolean')
    throw new Error(`${file}: content must be true or false`);
  const content = raw.content === true;
  for (const k of [...Object.keys(CONTENT_HOSTS), 'contentD1Id', 'contentKvId'])
    if (raw[k] !== undefined && !content)
      throw new Error(`${file}: ${k} needs "content": true (the content stack is off)`);
  for (const k of Object.keys(CONTENT_HOSTS))
    if (raw[k] !== undefined && (typeof raw[k] !== 'string' || !HOST_RE.test(raw[k] as string)))
      throw new Error(`${file}: ${k} must be a host name`);
  if (raw.mediaScope !== undefined) {
    if (!content)
      throw new Error(`${file}: mediaScope needs "content": true (the content stack is off)`);
    const m = raw.mediaScope as Record<string, unknown> | null;
    const ok = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
    if (!m || typeof m !== 'object' || !ok(m.space) || !ok(m.environment))
      throw new Error(`${file}: mediaScope must be { "space": "<id>", "environment": "<id>" }`);
  }
  if (raw.contentD1Id !== undefined && (typeof raw.contentD1Id !== 'string' || !raw.contentD1Id))
    throw new Error(`${file}: contentD1Id must be the content database's id`);
  if (
    raw.contentKvId !== undefined &&
    (typeof raw.contentKvId !== 'string' || !/^[0-9a-f]{32}$/.test(raw.contentKvId))
  )
    throw new Error(`${file}: contentKvId must be the KV namespace's 32-character id`);
  if (
    raw.catalogKvId !== undefined &&
    (typeof raw.catalogKvId !== 'string' || !/^[0-9a-f]{32}$/.test(raw.catalogKvId))
  )
    throw new Error(`${file}: catalogKvId must be the KV namespace's 32-character id`);
  if (raw.jurisdiction !== undefined && raw.jurisdiction !== 'eu' && raw.jurisdiction !== 'fedramp')
    throw new Error(`${file}: jurisdiction must be "eu" or "fedramp"`);
  const limits = raw.limits as Record<string, unknown> | undefined;
  if (limits !== undefined) {
    if (typeof limits !== 'object' || limits === null)
      throw new Error(`${file}: limits must be an object`);
    for (const [k, v] of Object.entries(limits)) {
      if (!(k in LIMITS))
        throw new Error(`${file}: limits.${k} is not one of ${Object.keys(LIMITS).join(', ')}`);
      if (!Number.isInteger(v) || (v as number) < 1)
        throw new Error(
          `${file}: limits.${k} must be a positive whole number of requests a minute`,
        );
    }
  }
  if (
    raw.aiPersonalData !== undefined &&
    raw.aiPersonalData !== 'redact' &&
    raw.aiPersonalData !== 'send'
  )
    throw new Error(`${file}: aiPersonalData must be "redact" or "send"`);
  if (raw.aiGatewayLogs !== undefined && typeof raw.aiGatewayLogs !== 'boolean')
    throw new Error(`${file}: aiGatewayLogs must be true or false`);
  const fx = raw.fxCurrencies;
  if (
    fx !== undefined &&
    (!Array.isArray(fx) ||
      fx.length > 40 ||
      fx.some((c) => typeof c !== 'string' || !/^[A-Z]{3}$/.test(c) || c === 'USD'))
  )
    throw new Error(
      `${file}: fxCurrencies must be a list of ISO 4217 codes such as "EUR", other than USD`,
    );
  const tokens = raw.assistantDailyTokens;
  if (tokens !== undefined && (!Number.isInteger(tokens) || (tokens as number) < 0))
    throw new Error(`${file}: assistantDailyTokens must be a whole number (0 for no limit)`);
  const personal = raw.personalDataRetentionDays;
  if (personal !== undefined && (!Number.isInteger(personal) || (personal as number) < 30))
    throw new Error(
      `${file}: personalDataRetentionDays must be a whole number of days, at least 30`,
    );
  const archive = raw.auditArchiveDays;
  if (archive !== undefined && (!Number.isInteger(archive) || (archive as number) < 1))
    throw new Error(`${file}: auditArchiveDays must be a whole number of days`);
  const backupDays = raw.catalogBackupDays;
  if (backupDays !== undefined && (!Number.isInteger(backupDays) || (backupDays as number) < 31))
    throw new Error(`${file}: catalogBackupDays must be a whole number of days, at least 31`);
  const redundancy = redundancyOf(raw, file, personal as number | undefined);
  const logDays = raw.logRetentionDays;
  if (
    logDays !== undefined &&
    (!Number.isInteger(logDays) || (logDays as number) < MIN_LOG_RETENTION_DAYS)
  )
    throw new Error(
      `${file}: logRetentionDays must be a whole number of days, at least ${MIN_LOG_RETENTION_DAYS}`,
    );
  // The logs carry audit lines (emails, IPs) and error text, and erasure never reaches them: they
  // may not outlast the personal data the sweep erases.
  if (logDays !== undefined && personal !== undefined && (logDays as number) > (personal as number))
    throw new Error(
      `${file}: logRetentionDays (${logDays}) can't be longer than personalDataRetentionDays (${personal})`,
    );
  const retention = raw.auditRetentionDays;
  if (retention !== undefined && (!Number.isInteger(retention) || (retention as number) < 90))
    throw new Error(`${file}: auditRetentionDays must be a whole number of days, at least 90`);
  const sso = raw.sso as Record<string, unknown> | undefined;
  if (sso !== undefined) {
    if (typeof sso !== 'object' || sso === null)
      throw new Error(`${file}: sso must be { "issuer", "clientId" }`);
    if (typeof sso.issuer !== 'string' || !/^https:\/\/[^\s]+$/.test(sso.issuer))
      throw new Error(`${file}: sso.issuer must be the identity provider's https issuer URL`);
    if (typeof sso.clientId !== 'string' || !sso.clientId.trim())
      throw new Error(`${file}: sso.clientId must be the client id the provider issued`);
    if (sso.trustEmail !== undefined && typeof sso.trustEmail !== 'boolean')
      throw new Error(`${file}: sso.trustEmail must be true or false`);
  }
  const email = raw.email as Record<string, unknown> | undefined;
  if (email !== undefined) {
    if (typeof email !== 'object' || email === null)
      throw new Error(`${file}: email must be { "from", "fromName"? }`);
    // The same shape the sender adapter accepts, so a typo fails here and not at the first order.
    if (typeof email.from !== 'string' || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email.from))
      throw new Error(
        `${file}: email.from must be an address on a domain onboarded to Email Sending`,
      );
    if (
      email.fromName !== undefined &&
      (typeof email.fromName !== 'string' ||
        !email.fromName.trim() ||
        /[\r\n<>]/.test(email.fromName))
    )
      throw new Error(`${file}: email.fromName must be a plain display name`);
  }
  const turnstile = raw.turnstileSiteKey;
  // Real keys are 0x…, Cloudflare's test keys 1x…–3x…; anything else is a paste of something else.
  // A test key always passes (or always fails) whoever solves it, so only a demo may have one:
  // anywhere else, people's passwords would sit behind a check that checks nothing.
  if (
    turnstile !== undefined &&
    (typeof turnstile !== 'string' || !/^[0-3]x[\w-]{8,64}$/.test(turnstile))
  )
    throw new Error(`${file}: turnstileSiteKey must be a Turnstile site key (0x…)`);
  if (typeof turnstile === 'string' && !turnstile.startsWith('0x') && raw.demo !== true)
    throw new Error(
      `${file}: turnstileSiteKey ${turnstile.slice(0, 2)}… is a Cloudflare test key, which only a demo may use; use the widget's own (0x…)`,
    );
  if (raw.payments !== undefined && raw.payments !== 'mock' && raw.payments !== 'stripe')
    throw new Error(
      `${file}: payments must be "mock" or "stripe" (got ${JSON.stringify(raw.payments)})`,
    );
  const payments = raw.payments === 'stripe' ? 'stripe' : 'mock';
  if (payments === 'stripe' && raw.demo === true)
    throw new Error(`${file}: a demo takes no real payments; leave payments "mock"`);
  const pk = raw.stripePublishableKey;
  if (pk !== undefined) {
    if (typeof pk !== 'string' || !/^pk_(test|live)_\w+$/.test(pk))
      throw new Error(
        `${file}: stripePublishableKey must be a Stripe publishable key (pk_test_… or pk_live_…)`,
      );
    if (payments !== 'stripe')
      throw new Error(`${file}: stripePublishableKey needs payments "stripe"`);
    // The storefront's hosted checkout is turned on at runtime (a workspace setting), and with a
    // publishable key it takes cards: each press of Pay can test one, so it needs the Turnstile check.
    if (turnstile === undefined)
      throw new Error(
        `${file}: stripePublishableKey puts card payment on the storefront, which needs a turnstileSiteKey (docs/operations.md, "Card payment on the hosted checkout")`,
      );
  }
  const plugins = raw.plugins ?? {};
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins))
    throw new Error(`${file}: plugins must be an object of plugin id → { "d1Id"? }`);
  for (const [p, v] of Object.entries(plugins as Record<string, unknown>)) {
    if (!/^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){1,30}$/.test(p))
      throw new Error(
        `${file}: plugins.${p} is not a plugin id (lowercase letters, digits, dashes)`,
      );
    if (FIXTURE_PLUGINS.has(p)) throw new Error(`${file}: plugins.${p} is a test fixture`);
    if (RESERVED_PLUGIN_IDS.has(p)) throw new Error(`${file}: plugins.${p} is a reserved id`);
    const rt = (v as { runtime?: unknown } | null)?.runtime;
    if (rt !== undefined && rt !== 'worker' && rt !== 'sandboxed')
      throw new Error(`${file}: plugins.${p}.runtime must be "worker" or "sandboxed"`);
    const names = (v as { secrets?: unknown } | null)?.secrets;
    if (
      names !== undefined &&
      (!Array.isArray(names) ||
        names.some(
          (n) => typeof n !== 'string' || !SECRET_NAME_RE.test(n) || PLUGIN_RESERVED_ENV.has(n),
        ))
    )
      throw new Error(`${file}: plugins.${p}.secrets must be a list of secret names (upper case)`);
    if (rt === 'sandboxed' && (v as { d1Id?: unknown }).d1Id !== undefined)
      throw new Error(`${file}: plugins.${p} is sandboxed: it has no D1 database (drop d1Id)`);
    const d1 = (v as { d1Id?: unknown } | null)?.d1Id;
    const pd = (v as { personalData?: unknown } | null)?.personalData;
    if (pd !== undefined && pd !== 'send')
      throw new Error(
        `${file}: plugins.${p}.personalData can only be "send" (to grant buyer details)`,
      );
    const alias = (v as { alias?: unknown } | null)?.alias;
    if (alias !== undefined) {
      const seg = typeof alias === 'string' ? ALIAS_RE.exec(alias)?.[1] : undefined;
      if (!seg)
        throw new Error(
          `${file}: plugins.${p}.alias must be one lowercase path segment, like "/${p}/"`,
        );
      if (RESERVED_PATH_SEGMENTS.has(seg))
        throw new Error(`${file}: plugins.${p}.alias "${alias}" is one of the app's own paths`);
      const taken = Object.entries(plugins as Record<string, { alias?: unknown }>).find(
        ([q, w]) => q !== p && w?.alias === alias,
      );
      if (taken) throw new Error(`${file}: plugins.${p}.alias "${alias}" is also ${taken[0]}'s`);
    }
    const caps = (v as { capabilities?: unknown } | null)?.capabilities;
    if (
      caps !== undefined &&
      (!Array.isArray(caps) ||
        caps.some((c) => !PLUGIN_CAPABILITIES.includes(c as string)) ||
        new Set(caps).size !== caps.length)
    )
      throw new Error(
        `${file}: plugins.${p}.capabilities must list each of ${PLUGIN_CAPABILITIES.join(', ')} at most once`,
      );
    const extra = Object.keys((v as object) ?? {}).filter(
      (k) => !['alias', 'd1Id', 'personalData', 'capabilities', 'runtime', 'secrets'].includes(k),
    );
    if (extra.length)
      throw new Error(`${file}: plugins.${p} has unknown keys: ${extra.join(', ')}`);
    if (
      typeof v !== 'object' ||
      v === null ||
      (d1 !== undefined && (typeof d1 !== 'string' || !d1))
    )
      throw new Error(
        `${file}: plugins.${p} must be { "alias"?, "d1Id"?, "personalData"?, "capabilities"?, "runtime"?, "secrets"? }`,
      );
  }
  const installs = raw.pluginInstalls;
  if (installs !== undefined) {
    const i = (installs ?? {}) as { publishers?: unknown; assistant?: unknown };
    const pubs = i.publishers;
    const keys = typeof installs === 'object' && installs !== null ? Object.keys(installs) : [];
    if (
      typeof installs !== 'object' ||
      installs === null ||
      !keys.length ||
      keys.some((k) => k !== 'publishers' && k !== 'assistant') ||
      (i.assistant !== undefined && i.assistant !== true) ||
      (pubs !== undefined &&
        (typeof pubs !== 'object' ||
          pubs === null ||
          Array.isArray(pubs) ||
          !Object.keys(pubs).length ||
          Object.entries(pubs).some(
            ([n, k]) =>
              !/^[a-z][a-z0-9-]{0,39}$/.test(n) ||
              // Reserved: the assistant's drafts are staged as "assistant", trusted by `assistant`.
              n === 'assistant' ||
              typeof k !== 'string' ||
              !/^[A-Za-z0-9_-]{43}$/.test(k),
          )))
    )
      throw new Error(
        `${file}: pluginInstalls must be { "publishers"?: { "<name>": "<Ed25519 public key, base64url>" }, "assistant"?: true }, with at least one (a publisher can't be named "assistant")`,
      );
  }
  const store = raw.secretsStore;
  if (
    store !== undefined &&
    (typeof store !== 'object' ||
      store === null ||
      Object.keys(store).join() !== 'storeId' ||
      typeof (store as { storeId?: unknown }).storeId !== 'string' ||
      !/^[0-9a-f]{32}$/.test((store as { storeId: string }).storeId))
  )
    throw new Error(`${file}: secretsStore must be { "storeId": "<32 hex characters>" }`);
  // A plugin's secrets are PLUGIN_<ID>_<NAME>, so with ids "a" and "a-b" both installed,
  // PLUGIN_A_B_X would be a's B_X and b's X at once.
  for (const a of Object.keys(plugins))
    for (const b of Object.keys(plugins))
      if (a !== b && pluginBinding(b).startsWith(`${pluginBinding(a)}_`))
        throw new Error(
          `${file}: plugins ${a} and ${b} can't both be installed: ${pluginBinding(b)}_* secrets would also reach ${a}`,
        );
  const domain = typeof raw.domain === 'string' ? raw.domain : `${id}.commerceworker.com`;
  const host = (k: keyof typeof CONTENT_HOSTS) =>
    typeof raw[k] === 'string' ? (raw[k] as string) : `${CONTENT_HOSTS[k]}.${domain}`;
  const catalogDomain =
    typeof raw.catalogDomain === 'string' ? raw.catalogDomain : `catalog.${domain}`;
  const storefrontDomain =
    typeof raw.storefrontDomain === 'string' ? raw.storefrontDomain : `shop.${domain}`;
  // One host, one Worker: the admin, the catalog, the storefront and each content surface differ.
  const served = [
    domain,
    catalogDomain,
    storefrontDomain,
    ...(content
      ? Object.keys(CONTENT_HOSTS).map((k) => host(k as keyof typeof CONTENT_HOSTS))
      : []),
  ];
  const twice = served.find((h, i) => served.indexOf(h) !== i);
  if (twice) throw new Error(`${file}: ${twice} is the host of two of the deployment's Workers`);
  return {
    id,
    ring,
    slot: raw.slot as number,
    domain,
    catalogDomain,
    storefrontDomain,
    content,
    ...(content
      ? {
          studioDomain: host('studioDomain'),
          apiDomain: host('apiDomain'),
          cdnDomain: host('cdnDomain'),
          mediaDomain: host('mediaDomain'),
        }
      : {}),
    suffix: typeof raw.suffix === 'string' ? raw.suffix : `-${id}`,
    environment: typeof raw.environment === 'string' ? raw.environment : `deploy-${id}`,
    ...(raw.d1Id ? { d1Id: raw.d1Id as string } : {}),
    ...(raw.standbyD1Id ? { standbyD1Id: raw.standbyD1Id as string } : {}),
    ...(redundancy ? { redundancy } : {}),
    ...(raw.catalogKvId ? { catalogKvId: raw.catalogKvId as string } : {}),
    ...(raw.mediaScope
      ? { mediaScope: raw.mediaScope as NonNullable<Deployment['mediaScope']> }
      : {}),
    ...(raw.contentD1Id ? { contentD1Id: raw.contentD1Id as string } : {}),
    ...(raw.contentKvId ? { contentKvId: raw.contentKvId as string } : {}),
    ...(raw.jurisdiction ? { jurisdiction: raw.jurisdiction as 'eu' | 'fedramp' } : {}),
    hold: raw.hold === true,
    docs: raw.docs === true,
    demo: raw.demo === true,
    ...(limits ? { limits: limits as Deployment['limits'] } : {}),
    ...(retention !== undefined ? { auditRetentionDays: retention as number } : {}),
    ...(personal !== undefined ? { personalDataRetentionDays: personal as number } : {}),
    ...(tokens !== undefined ? { assistantDailyTokens: tokens as number } : {}),
    ...(archive !== undefined ? { auditArchiveDays: archive as number } : {}),
    catalogBackupDays: backupDays === undefined ? CATALOG_BACKUP_DAYS : (backupDays as number),
    logRetentionDays: (logDays ?? personal ?? LOG_RETENTION_DAYS) as number,
    aiPersonalData: raw.aiPersonalData === 'send' ? 'send' : 'redact',
    aiGatewayLogs: raw.aiGatewayLogs === true,
    fxCurrencies: [...new Set((raw.fxCurrencies as string[] | undefined) ?? [])],
    ...(sso
      ? {
          sso: {
            issuer: sso.issuer as string,
            clientId: sso.clientId as string,
            ...(sso.trustEmail === true ? { trustEmail: true } : {}),
          },
        }
      : {}),
    ...(email
      ? {
          email: {
            from: (email.from as string).trim(),
            ...(email.fromName ? { fromName: (email.fromName as string).trim() } : {}),
          },
        }
      : {}),
    ...(turnstile !== undefined ? { turnstileSiteKey: turnstile as string } : {}),
    payments,
    paymentsSet: raw.payments !== undefined,
    ...(pk !== undefined ? { stripePublishableKey: pk as string } : {}),
    plugins: plugins as Deployment['plugins'],
    ...(store ? { secretsStore: { storeId: (store as { storeId: string }).storeId } } : {}),
    ...(installs ? { pluginInstalls: installs as Deployment['pluginInstalls'] & object } : {}),
  };
}

/**
 * A deployment that serves buyers must say how it takes payments: an unset `payments` renders
 * `PAYMENTS_MODE=mock`, which records payments without taking money. So `payments` is required
 * (not defaulted) on the canary and general rings and wherever `storefrontDomain` is set, except
 * on a demo. `mock` there is a deliberate choice, and refused outright on the general ring.
 * Returns the problem, or null.
 */
export function paymentsProblem(d: Deployment, raw: { storefrontDomain?: unknown }): string | null {
  if (d.demo) return null;
  const serves = d.ring === 'canary' || d.ring === 'general' || raw.storefrontDomain !== undefined;
  if (serves && !d.paymentsSet)
    return `${d.id}: set "payments" in deployments/${d.id}.jsonc to "stripe" (takes money through Stripe) or "mock" (records payments, takes no money; staging only). An unset payments mode renders mock, and ring ${d.ring}${raw.storefrontDomain !== undefined ? ' with a storefrontDomain' : ''} must choose`;
  if (d.ring === 'general' && d.payments === 'mock')
    return `${d.id}: payments "mock" takes no money and is refused on the general ring; set "payments": "stripe", or move the deployment to the internal or canary ring`;
  return null;
}

/** Every Cloudflare resource id a registry entry names: no two deployments may share one. */
export function resourceIds(d: Deployment): [field: string, id: string][] {
  const ids: [string, string | undefined][] = [
    ['d1Id', d.d1Id],
    ['standbyD1Id', d.standbyD1Id],
    ['catalogKvId', d.catalogKvId],
    ['contentD1Id', d.contentD1Id],
    ['contentKvId', d.contentKvId],
    ...Object.entries(d.plugins).map(([p, v]): [string, string | undefined] => [
      `plugins.${p}.d1Id`,
      v?.d1Id,
    ]),
  ];
  return ids.filter((x): x is [string, string] => typeof x[1] === 'string' && x[1] !== '');
}

export function loadDeployments(dir = join(ROOT, 'deployments')): Deployment[] {
  const list = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonc'))
    .sort()
    .map((f) => {
      const raw = readJsonc(join(dir, f));
      const d = toDeployment(raw, f);
      if (`${d.id}.jsonc` !== f) throw new Error(`${f}: id "${d.id}" must match the file name`);
      const problem = paymentsProblem(d, raw);
      if (problem) throw new Error(`${f}: ${problem}`);
      return d;
    });
  for (const key of ['slot', 'domain', 'suffix'] as const) {
    const seen = new Map<unknown, string>();
    for (const d of list) {
      const other = seen.get(d[key]);
      if (other) throw new Error(`${d.id} and ${other} share ${key} ${JSON.stringify(d[key])}`);
      seen.set(d[key], d.id);
    }
  }
  // One resource id in two entries (a copied file with a stale id) points a customer at another's
  // data, and CI would migrate it. Within one entry too: a D1 id can't also be its KV id.
  const idOwner = new Map<string, string>();
  for (const d of list)
    for (const [field, id] of resourceIds(d)) {
      const other = idOwner.get(id);
      if (other)
        throw new Error(
          `${d.id} ${field} ${JSON.stringify(id)} is already used by ${other}: every deployment needs its own resources (run scripts/provision.sh ${d.id})`,
        );
      idOwner.set(id, `${d.id} ${field}`);
    }
  // No host serves two deployments (a content host only counts on a deployment with content).
  const hostOwner = new Map<string, string>();
  for (const d of list)
    for (const h of servedHosts(d)) {
      const other = hostOwner.get(h);
      if (other && other !== d.id) throw new Error(`${d.id} and ${other} share the host ${h}`);
      hostOwner.set(h, d.id);
    }
  // Queue names are account-wide: an id such as "dlq" would name another deployment's dead letters.
  const queueOwner = new Map<string, string>();
  for (const d of list.filter((x) => x.content))
    for (const q of CONTENT_QUEUES.map(names(d).contentQueue)) {
      const other = queueOwner.get(q);
      if (other) throw new Error(`${d.id} and ${other} share the queue ${q}`);
      queueOwner.set(q, d.id);
    }
  if (list.filter((d) => d.docs).length > 1) throw new Error('only one deployment sets docs');
  for (const d of list)
    for (const p of workerPlugins(d))
      if (!existsSync(join(ROOT, 'plugins', p, 'wrangler.jsonc')))
        throw new Error(`${d.id}: plugin "${p}" has no plugins/${p}/wrangler.jsonc`);
  return list;
}

/** Resource names: the base name plus the deployment's suffix. */
export const names = (d: Deployment) => ({
  web: `commerceworker-web${d.suffix}`,
  storefront: `commerceworker-storefront${d.suffix}`,
  engine: `commerceworker-engine${d.suffix}`,
  d1: `commerceworker${d.suffix}`,
  r2: `commerceworker-docs${d.suffix}`,
  aiGateway: `commerceworker${d.suffix}`,
  productIndex: `commerceworker-products${d.suffix}`,
  catalog: `commerceworker-catalog${d.suffix}`,
  catalogR2: `commerceworker-catalog${d.suffix}`,
  /** The commerce D1 backups and drill evidence (`redundancy`), and the database a drill restores into. */
  backups: `commerceworker-backups${d.suffix}`,
  standbyD1: `commerceworker-standby${d.suffix}`,
  /** The replica of the order documents bucket (`redundancy`), the queue R2's notifications go to, and its dead letters. */
  docsReplica: `commerceworker-docs-replica${d.suffix}`,
  docsReplicaQueue: `commerceworker-docs-replica${d.suffix}`,
  docsReplicaDlq: `commerceworker-docs-replica-dlq${d.suffix}`,
  catalogKv: `commerceworker-catalog-cards${d.suffix}`,
  catalogFeedParts: `commerceworker-catalog-feed-parts${d.suffix}`,
  catalogFeedPartsDlq: `commerceworker-catalog-feed-parts-dlq${d.suffix}`,
  delivery: `commerceworker-delivery${d.suffix}`,
  catalogPurge: `commerceworker-catalog-purge${d.suffix}`,
  catalogChanges: `commerceworker-catalog-changes${d.suffix}`,
  catalogChangesDlq: `commerceworker-catalog-changes-dlq${d.suffix}`,
  catalogPurgeDlq: `commerceworker-catalog-purge-dlq${d.suffix}`,
  // The content stack (`content`): its Workers, database, cache, assets bucket and vector index.
  pipeline: `commerceworker-pipeline${d.suffix}`,
  api: `commerceworker-api${d.suffix}`,
  studio: `commerceworker-studio${d.suffix}`,
  // The media Worker shares its base name with the bucket (Workers and buckets are named apart).
  mediaWorker: `commerceworker-media${d.suffix}`,
  mediaBucket: `commerceworker-media${d.suffix}`,
  contentD1: `commerceworker-content${d.suffix}`,
  contentKv: `commerceworker-content-cache${d.suffix}`,
  contentVectors: `commerceworker-vectors${d.suffix}`,
  contentDataset: `commerceworker_metrics${d.suffix.replaceAll('-', '_')}`,
  /** A content queue's name for the deployment, from its base name (`CONTENT_QUEUES`). */
  contentQueue: (q: string) => `${q}${d.suffix}`,
  /** Where Logpush writes the deployment's Workers' trace events, and the job and token that do. */
  logs: `commerceworker-logs${d.suffix}`,
  logpushJob: `commerceworker-workers${d.suffix}`,
  logpushToken: `commerceworker-logpush${d.suffix}`,
  // Analytics Engine dataset names allow letters, digits and underscores.
  catalogDataset: `commerceworker_catalog_delivery${d.suffix.replaceAll('-', '_')}`,
  /** A plugin's Worker and its D1 database share a name. */
  plugin: (p: string) => `commerceworker-plugin-${p}${d.suffix}`,
});

/** The content stack's four hosts; throws for a deployment that has it off. */
export function contentHosts(d: Deployment) {
  if (!d.studioDomain || !d.apiDomain || !d.cdnDomain || !d.mediaDomain)
    throw new Error(`${d.id} has the content stack off: no content hosts`);
  return { studio: d.studioDomain, api: d.apiDomain, cdn: d.cdnDomain, media: d.mediaDomain };
}

/** Every host a deployment serves: the admin, the catalog, the storefront and, with content, its four. */
export const servedHosts = (d: Deployment) => [
  d.domain,
  d.catalogDomain,
  d.storefrontDomain,
  ...(d.content ? Object.values(contentHosts(d)) : []),
];

/**
 * The content stack's queues, by base name: domain events with their dead letters, bulk chunks,
 * agent jobs, delivery purges, media purges and asset events (each with dead letters).
 * `agents` has none: its failures go to the events dead letters.
 */
export const CONTENT_QUEUES = [
  'commerceworker-events',
  'commerceworker-events-dlq',
  'commerceworker-bulk',
  'commerceworker-agents',
  'commerceworker-purge',
  'commerceworker-purge-dlq',
  'commerceworker-media-purge',
  'commerceworker-media-purge-dlq',
  'commerceworker-asset-events',
  'commerceworker-asset-events-dlq',
] as const;

/**
 * The trace-event fields Logpush keeps. `Event` is left out: it is the request (URL, method,
 * headers, `cf`) or the queue, cron or alarm that started the invocation, and its headers carry
 * the client's IP and user agent and, past Cloudflare's name-based redaction, any credential
 * header it doesn't recognise. What forensics needs is in `Logs`: the `audit_event` lines and
 * every other line the code writes.
 */
export const LOG_FIELDS = [
  'EventTimestampMs',
  'EventType',
  'Outcome',
  'ScriptName',
  'Entrypoint',
  'ScriptVersion',
  'Exceptions',
  'Logs',
  'CPUTimeMs',
  'WallTimeMs',
];

/** Logpush refuses a filter longer than about 1,000 bytes. */
const LOGPUSH_FILTER_MAX = 1000;

/**
 * The deployment's Logpush job (`provision.sh` creates or updates it): the Workers whose trace
 * events it pushes, by script name, since a job for `workers_trace_events` otherwise takes every
 * Worker on the account that sets `logpush`, other deployments' included.
 */
export function logpushJob(d: Deployment) {
  const n = names(d);
  const scripts = [
    n.web,
    n.storefront,
    n.engine,
    n.catalog,
    n.delivery,
    ...(d.content ? [n.pipeline, n.mediaWorker, n.api, n.studio] : []),
    ...workerPlugins(d).map(n.plugin),
  ];
  const filter = JSON.stringify({ where: { key: 'ScriptName', operator: 'in', value: scripts } });
  if (filter.length > LOGPUSH_FILTER_MAX)
    throw new Error(`${d.id}: its Logpush filter (${filter.length} bytes) is too long`);
  return {
    name: n.logpushJob,
    bucket: n.logs,
    prefix: 'workers/',
    scripts,
    filter,
    output_options: { output_type: 'ndjson', field_names: LOG_FIELDS, timestamp_format: 'rfc3339' },
  };
}

type LogpushFilter = {
  and?: LogpushFilter[];
  or?: LogpushFilter[];
  key?: string;
  operator?: string;
  value?: unknown;
};

/**
 * Whether a Logpush filter (the job's `filter` string) can let through events from Worker
 * `script`. Only `ScriptName` conditions are decided; any other condition (`Outcome`, …) might
 * hold, and a filter that doesn't parse, or has no `where`, lets everything through.
 */
export function filterAdmits(filter: string | null | undefined, script: string): boolean {
  if (!filter) return true;
  let where: LogpushFilter | undefined;
  try {
    where = (JSON.parse(filter) as { where?: LogpushFilter }).where;
  } catch {
    return true;
  }
  if (!where) return true;
  const admits = (f: LogpushFilter): boolean => {
    if (f.and) return f.and.every(admits);
    if (f.or) return f.or.some(admits);
    if (f.key !== 'ScriptName') return true;
    const v = f.value;
    const list = Array.isArray(v) ? v : [v];
    switch (f.operator) {
      case 'eq':
        return v === script;
      case '!eq':
        return v !== script;
      case 'in':
        return list.includes(script);
      case '!in':
        return !list.includes(script);
      case 'startsWith':
        return typeof v === 'string' && script.startsWith(v);
      case '!startsWith':
        return !(typeof v === 'string' && script.startsWith(v));
      case 'endsWith':
        return typeof v === 'string' && script.endsWith(v);
      case '!endsWith':
        return !(typeof v === 'string' && script.endsWith(v));
      case 'contains':
        return typeof v === 'string' && script.includes(v);
      case '!contains':
        return !(typeof v === 'string' && script.includes(v));
      default:
        return true;
    }
  };
  return admits(where);
}

/**
 * The account's `workers_trace_events` jobs, other than the deployment's own, that would take its
 * Workers' trace events. `logpush` puts a Worker in every such job on the account, so one without
 * a filter (another project's, made in the dashboard) would collect this deployment's audit lines
 * and errors. Another deployment's job, filtered to its own Workers, doesn't.
 */
export function foreignJobsReaching(
  jobs: { id: number; name?: string | null; filter?: string | null }[],
  d: Deployment,
) {
  const own = logpushJob(d);
  return jobs.filter(
    (j) => j.name !== own.name && own.scripts.some((s) => filterAdmits(j.filter, s)),
  );
}

/** The permission group Logpush's R2 token gets: object writes, and nothing else. */
export const R2_WRITE_GROUP = 'Workers R2 Storage Bucket Item Write';

/**
 * The account token Logpush writes the logs bucket with: R2 object writes in that one bucket.
 * `groups` is the account's permission groups (the API's list); exactly one must be
 * `R2_WRITE_GROUP`. The resource names the bucket's jurisdiction (`default` outside one).
 */
export function logpushToken(
  d: Deployment,
  accountId: string,
  groups: { id: string; name: string }[],
) {
  if (!/^[0-9a-f]{32}$/.test(accountId)) throw new Error(`${accountId} is not an account id`);
  const found = groups.filter((g) => g.name === R2_WRITE_GROUP);
  if (found.length !== 1)
    throw new Error(
      `expected one permission group named "${R2_WRITE_GROUP}", found ${found.length}`,
    );
  const bucket = `com.cloudflare.edge.r2.bucket.${accountId}_${d.jurisdiction ?? 'default'}_${names(d).logs}`;
  return {
    name: names(d).logpushToken,
    policies: [
      { effect: 'allow', resources: { [bucket]: '*' }, permission_groups: [{ id: found[0]!.id }] },
    ],
  };
}

/**
 * Whether an existing token (the API's token details) holds exactly `expected`'s one policy: the
 * same effect, the same single resource and the one permission group. Rolling a token that can do
 * more would hand Logpush that much more.
 */
export function tokenMatches(
  token: {
    name?: string;
    policies?: { effect?: string; resources?: unknown; permission_groups?: { id: string }[] }[];
  },
  expected: ReturnType<typeof logpushToken>,
) {
  const [want] = expected.policies;
  const got = token.policies ?? [];
  if (token.name !== expected.name || got.length !== 1 || !want) return false;
  const [p] = got;
  return (
    p!.effect === want.effect &&
    JSON.stringify(p!.resources) === JSON.stringify(want.resources) &&
    (p!.permission_groups ?? []).length === 1 &&
    p!.permission_groups![0]!.id === want.permission_groups[0]!.id
  );
}

/** The engine's and web Worker's service bindings to the deployment's Worker plugins. */
function pluginServices(d: Deployment) {
  return workerPlugins(d).map((p) => ({ binding: pluginBinding(p), service: names(d).plugin(p) }));
}

/** A plugin secret's name in the deployment's Secrets Store (and its GitHub environment). */
export const pluginSecretVar = (p: string, name: string) => `${pluginBinding(p)}_${name}`;

/** The engine's binding for a sandboxed plugin's secret in the Secrets Store (`storeBinding`). */
export const storeBinding = (p: string, name: string) =>
  `PLUGIN_SECRET_${pluginBinding(p).slice('PLUGIN_'.length)}__${name}`;

/** Secrets Store bindings: `binding(name)` for each of these plugins' listed secrets. */
function storeSecrets(d: Deployment, plugins: string[], binding: (p: string, n: string) => string) {
  const storeId = d.secretsStore?.storeId;
  if (!storeId) return [];
  return plugins.flatMap((p) =>
    (d.plugins[p]?.secrets ?? []).map((n) => ({
      binding: binding(p, n),
      store_id: storeId,
      secret_name: pluginSecretVar(p, n),
    })),
  );
}

/**
 * What a plugin's wrangler.jsonc may hold. Anything else (service bindings, Durable Objects,
 * buckets, queues, routes…) could reach the engine or another deployment's resources, so a plugin
 * that asks for it is refused rather than deployed.
 */
const PLUGIN_CONFIG_KEYS = new Set([
  '$schema',
  'name',
  'main',
  'compatibility_date',
  'compatibility_flags',
  'workers_dev',
  'preview_urls',
  'observability',
  'upload_source_maps',
  'vars',
  'd1_databases',
]);

export function renderPlugin(base: Config, d: Deployment, p: string): Config {
  if (runtimeOf(d, p) !== 'worker') throw new Error(`${d.id}: plugin ${p} is sandboxed: no Worker`);
  const d1Id = d.plugins[p]?.d1Id;
  if (!d1Id) throw new Error(`${d.id}: plugin ${p} has no d1Id: run scripts/provision.sh ${d.id}`);
  const extra = Object.keys(base).filter((k) => !PLUGIN_CONFIG_KEYS.has(k));
  if (extra.length)
    throw new Error(
      `plugins/${p}/wrangler.jsonc: a plugin may not declare ${extra.join(', ')}; it gets one D1 database and vars`,
    );
  const dbs = (base.d1_databases ?? []) as Config[];
  if (dbs.length > 1 || (dbs[0] && dbs[0].binding !== 'DB'))
    throw new Error(`plugins/${p}/wrangler.jsonc: a plugin has one D1 binding, named DB`);
  const config = structuredClone(base);
  config.name = names(d).plugin(p);
  config.workers_dev = false;
  config.preview_urls = false;
  // Its logs go to the deployment's logs bucket like the apps' (logpushJob names it). The
  // deployment decides, so a plugin's own config can't say otherwise (PLUGIN_CONFIG_KEYS).
  config.logpush = true;
  config.d1_databases = dbs.map((db) => ({
    ...db,
    database_name: names(d).plugin(p),
    database_id: d1Id,
  }));
  // On its own account, the deployment's Secrets Store holds the plugin's secrets: each is bound
  // under its own name (`secret()` in the SDK reads either kind).
  const store = storeSecrets(d, [p], (_p, n) => n);
  if (store.length) config.secrets_store_secrets = store;
  // The core's host API, as this plugin: props name it, so it can't act as another. Bound only
  // when the deployment grants it a capability; the engine checks the grant on every call.
  if (d.plugins[p]?.capabilities?.length)
    config.services = [
      {
        binding: 'COMMERCEWORKER',
        service: names(d).engine,
        entrypoint: 'PluginHost',
        props: { id: p },
      },
    ];
  return config;
}

/**
 * A plugin's own page-signing key: the HMAC of the deployment's principal key with its id, as
 * `pluginKey` in @commerceworker/core computes it (fleet.test.ts holds the two to the same vector). The
 * plugin never gets the principal key itself.
 */
export const pluginKey = (principalKey: string, id: string) =>
  createHmac('sha256', principalKey).update(`commerceworker-plugin:${id}`).digest('hex');

/** What the engine grants plugins beyond the defaults, from the registry: buyer details, capabilities. */
function pluginGrants(d: Deployment) {
  const grants = Object.fromEntries(
    Object.entries(d.plugins).flatMap(([p, v]) => {
      const g = {
        ...(v.personalData === 'send' ? { personalData: 'send' } : {}),
        ...(v.capabilities?.length ? { capabilities: v.capabilities } : {}),
      };
      return Object.keys(g).length ? [[p, g]] : [];
    }),
  );
  return Object.keys(grants).length ? JSON.stringify(grants) : '';
}

// biome-ignore lint/suspicious/noExplicitAny: a wrangler config is JSON read as is
type Config = Record<string, any>;

function storage(config: Config, d: Deployment) {
  if (!d.d1Id) throw new Error(`${d.id} has no d1Id: run scripts/provision.sh ${d.id}`);
  const n = names(d);
  // Only DB and DOCS: the engine's redundancy bindings (STANDBY_DB, BACKUPS) are rendered apart.
  config.d1_databases = config.d1_databases.map((db: Config) =>
    db.binding === 'DB' ? { ...db, database_name: n.d1, database_id: d.d1Id } : db,
  );
  config.r2_buckets = config.r2_buckets.map((b: Config) =>
    b.binding === 'DOCS'
      ? { ...b, bucket_name: n.r2, ...(d.jurisdiction ? { jurisdiction: d.jurisdiction } : {}) }
      : b,
  );
}

/**
 * The engine's redundancy bindings: the base config carries them (commerceworker has the flag on),
 * so a deployment without `redundancy`, or with `d1Backup` an exception, has them stripped, as
 * ASSISTANT_PLUGINS is. With them: the standby database, the backups bucket in the deployment's
 * jurisdiction, and the two Workflows at the registry's hour.
 */
function redundancyBindings(config: Config, d: Deployment) {
  const workflows = ['D1_BACKUP', 'D1_RESTORE'];
  if (!backsUpD1(d)) {
    config.d1_databases = config.d1_databases.filter((db: Config) => db.binding !== 'STANDBY_DB');
    config.r2_buckets = config.r2_buckets.filter((b: Config) => b.binding !== 'BACKUPS');
    config.workflows = config.workflows.filter((w: Config) => !workflows.includes(w.binding));
    return;
  }
  if (!d.standbyD1Id)
    throw new Error(`${d.id} has no standbyD1Id: run scripts/provision.sh ${d.id}`);
  const n = names(d);
  const cron = redundancySchedules(d.redundancy);
  config.d1_databases = config.d1_databases.map((db: Config) =>
    db.binding === 'STANDBY_DB'
      ? { ...db, database_name: n.standbyD1, database_id: d.standbyD1Id }
      : db,
  );
  config.r2_buckets = config.r2_buckets.map((b: Config) =>
    b.binding === 'BACKUPS'
      ? {
          ...b,
          bucket_name: n.backups,
          ...(d.jurisdiction ? { jurisdiction: d.jurisdiction } : {}),
        }
      : b,
  );
  config.workflows = config.workflows.map((w: Config) =>
    w.binding === 'D1_BACKUP'
      ? { ...w, schedules: [cron.backup] }
      : w.binding === 'D1_RESTORE'
        ? { ...w, schedules: [cron.restore] }
        : w,
  );
}

/**
 * The docs replica's bindings: the bucket (in the deployment's jurisdiction), the reconcile
 * Workflow, and the queue consumers for R2's notifications and their dead letters, with the
 * suffixed queue names. Stripped, with the bucket, when `redundancy` is off or `r2Replica` is an
 * exception. Apart from the D1 backup's, so each part switches off on its own.
 */
function docsReplicaBindings(config: Config, d: Deployment) {
  if (!replicatesDocs(d)) {
    config.r2_buckets = config.r2_buckets.filter((b: Config) => b.binding !== 'DOCS_REPLICA');
    config.workflows = config.workflows.filter((w: Config) => w.binding !== 'DOCS_RECONCILE');
    delete config.queues;
    return;
  }
  const n = names(d);
  config.r2_buckets = config.r2_buckets.map((b: Config) =>
    b.binding === 'DOCS_REPLICA'
      ? {
          ...b,
          bucket_name: n.docsReplica,
          ...(d.jurisdiction ? { jurisdiction: d.jurisdiction } : {}),
        }
      : b,
  );
  config.queues = {
    ...config.queues,
    consumers: config.queues.consumers.map((c: Config) => ({
      ...c,
      queue: `${c.queue}${d.suffix}`,
      ...(c.dead_letter_queue ? { dead_letter_queue: `${c.dead_letter_queue}${d.suffix}` } : {}),
    })),
  };
}

export function renderEngine(base: Config, d: Deployment): Config {
  const config = structuredClone(base);
  config.name = names(d).engine;
  // Workflow names are unique per account, so each deployment's carry its suffix.
  config.workflows = config.workflows.map((w: Config) => ({ ...w, name: `${w.name}${d.suffix}` }));
  storage(config, d);
  redundancyBindings(config, d);
  docsReplicaBindings(config, d);
  // The product index ai.extract reads. A demo mocks every model, so it has none (and
  // scripts/provision.sh creates none).
  if (d.demo) delete config.vectorize;
  else
    config.vectorize = config.vectorize.map((v: Config) => ({
      ...v,
      index_name: names(d).productIndex,
    }));
  config.services = [
    ...config.services.map((s: Config) =>
      s.binding === 'CATALOG'
        ? { ...s, service: names(d).catalog }
        : s.binding === 'CATALOG_EDGE'
          ? { ...s, service: names(d).delivery }
          : s,
    ),
    ...pluginServices(d),
  ];
  const grants = pluginGrants(d);
  // Always set, so a deployment that grants nothing doesn't keep the base config's grants.
  config.vars = { ...config.vars, PLUGIN_GRANTS: grants };
  // The publishers whose signed bundles an admin may install at runtime.
  if (d.pluginInstalls?.publishers)
    config.vars = {
      ...config.vars,
      PLUGIN_PUBLISHERS: JSON.stringify(d.pluginInstalls.publishers),
    };
  // Whether the assistant may draft business-rule plugins for an admin to approve. The base config
  // has app.commerceworker.com's "on", so a deployment that doesn't ask for it must not keep it.
  const { ASSISTANT_PLUGINS: _drafts, ...vars } = config.vars;
  config.vars = d.pluginInstalls?.assistant ? { ...vars, ASSISTANT_PLUGINS: 'on' } : vars;
  // Sandboxed plugins' secrets, on a deployment with its own Secrets Store (else PLUGIN_SECRETS,
  // a secret the deploy writes). PLUGIN_BUNDLES is added by the deploy once it has published them.
  const store = storeSecrets(d, sandboxedPlugins(d), storeBinding);
  if (store.length)
    config.secrets_store_secrets = [...(config.secrets_store_secrets ?? []), ...store];
  config.vars = {
    ...config.vars,
    AI_GATEWAY_ID: names(d).aiGateway,
    AI_GATEWAY_LOGS: String(d.aiGatewayLogs),
    FX_CURRENCIES: d.fxCurrencies.join(','),
  };
  // The storefront's origin (where an external cart's buyer opens their start link) and the hosts
  // the deployment serves, which an external cart must never post back to.
  config.vars = {
    ...config.vars,
    STOREFRONT_ORIGIN: `https://${d.storefrontDomain}`,
    OWN_HOSTS: [d.domain, d.storefrontDomain, d.catalogDomain].join(','),
  };
  if (d.auditRetentionDays)
    config.vars = { ...config.vars, AUDIT_RETENTION_DAYS: String(d.auditRetentionDays) };
  config.vars = { ...config.vars, AI_PERSONAL_DATA: d.aiPersonalData };
  // Email Sending: the binding and its sender only where the registry sets `email`. The vars are
  // always set, so a deployment without one never keeps another's sender.
  if (d.email) config.send_email = [...(config.send_email ?? []), { name: 'EMAIL' }];
  config.vars = {
    ...config.vars,
    EMAIL_FROM: d.email?.from ?? '',
    EMAIL_FROM_NAME: d.email?.fromName ?? '',
  };
  if (d.assistantDailyTokens !== undefined)
    config.vars = { ...config.vars, ASSISTANT_DAILY_TOKENS: String(d.assistantDailyTokens) };
  // Durable Objects keep data where D1 and R2 do.
  if (d.jurisdiction) config.vars = { ...config.vars, DATA_JURISDICTION: d.jurisdiction };
  if (d.personalDataRetentionDays)
    config.vars = {
      ...config.vars,
      PERSONAL_DATA_RETENTION_DAYS: String(d.personalDataRetentionDays),
    };
  config.vars = {
    ...config.vars,
    PAYMENTS_MODE: d.payments,
    STRIPE_PUBLISHABLE_KEY: d.stripePublishableKey ?? '',
  };
  // A demo spends nothing on models, finishes a "3-day" wait in minutes and runs the failing
  // scenarios, like local dev.
  if (d.demo)
    config.vars = {
      ...config.vars,
      AI_MODE: 'mock',
      AI_GATEWAY_ID: '',
      TIME_SCALE: '1440',
      SIMULATE_FAILURES: 'true',
    };
  return config;
}

export function renderCatalog(base: Config, d: Deployment): Config {
  if (!d.catalogKvId)
    throw new Error(`${d.id} has no catalogKvId: run scripts/provision.sh ${d.id}`);
  const config = structuredClone(base);
  const n = names(d);
  config.name = n.catalog;
  config.r2_buckets = config.r2_buckets.map((b: Config) => ({
    ...b,
    bucket_name: n.catalogR2,
    ...(d.jurisdiction ? { jurisdiction: d.jurisdiction } : {}),
  }));
  config.kv_namespaces = config.kv_namespaces.map((k: Config) =>
    k.binding === 'CARDS' ? { ...k, id: d.catalogKvId } : k,
  );
  // CommerceWorker's own database, for the variant names and prices the catalog keeps in `products`.
  if (!d.d1Id) throw new Error(`${d.id} has no d1Id: run scripts/provision.sh ${d.id}`);
  config.d1_databases = config.d1_databases.map((db: Config) => ({
    ...db,
    database_name: n.d1,
    database_id: d.d1Id,
  }));
  // Workflow and queue names are unique per account, so each deployment's carry its suffix.
  config.workflows = config.workflows.map((w: Config) => ({ ...w, name: `${w.name}${d.suffix}` }));
  const queue = (name: string) => `${name}${d.suffix}`;
  config.queues = {
    producers: config.queues.producers.map((p: Config) => ({ ...p, queue: queue(p.queue) })),
    consumers: config.queues.consumers.map((c: Config) => ({
      ...c,
      queue: queue(c.queue),
      ...(c.dead_letter_queue ? { dead_letter_queue: queue(c.dead_letter_queue) } : {}),
    })),
  };
  // The shards keep their data where the deployment's other data lives.
  if (d.jurisdiction) config.vars = { ...config.vars, DATA_JURISDICTION: d.jurisdiction };
  // The assets service's origin, only where the deployment has the service: with it set the catalog
  // accepts `asset:` media; without it only absolute https URLs (`mediaSrcProblem` in core).
  if (d.content) config.vars = { ...config.vars, MEDIA_ORIGIN: `https://${contentHosts(d).media}` };
  return config;
}

/**
 * The delivery Worker as the fleet deploys it: `wrangler.catalog.jsonc` (the catalog's public read
 * API, content off) at `catalog.<domain>`. With `content`, it is the dispatcher instead: the
 * content stack's template (`wrangler.jsonc`, passed as `contentBase`) with the catalog's bindings
 * and host added, so one Worker serves `catalog.<domain>` and `cdn.<domain>`.
 */
export function renderDelivery(base: Config, d: Deployment, contentBase?: Config): Config {
  const catalog = renderCatalogDelivery(base, d);
  if (!d.content) return catalog;
  if (!contentBase) throw new Error(`${d.id}: delivery with content needs its content template`);
  const config = contentCommon(contentBase, d, 'delivery');
  // The catalog's side: its host beside the content one, and the bindings only it uses.
  config.routes = [...catalog.routes, { pattern: contentHosts(d).cdn, custom_domain: true }];
  config.r2_buckets = [...config.r2_buckets, ...catalog.r2_buckets];
  config.kv_namespaces = [...config.kv_namespaces, ...catalog.kv_namespaces];
  config.services = catalog.services;
  config.queues = {
    consumers: [...config.queues.consumers, ...catalog.queues.consumers],
  };
  config.analytics_engine_datasets = [
    ...config.analytics_engine_datasets,
    ...catalog.analytics_engine_datasets,
  ];
  // The default entrypoint is the uncached gateway; each side has its own cached one.
  config.exports = { ...config.exports, ...catalog.exports };
  config.observability = { ...config.observability, redact_query_string: true };
  return config;
}

function renderCatalogDelivery(base: Config, d: Deployment): Config {
  if (!d.catalogKvId)
    throw new Error(`${d.id} has no catalogKvId: run scripts/provision.sh ${d.id}`);
  const config = structuredClone(base);
  const n = names(d);
  config.name = n.delivery;
  config.routes = [{ pattern: d.catalogDomain, custom_domain: true }];
  config.services = config.services.map((s: Config) =>
    s.binding === 'CATALOG' ? { ...s, service: n.catalog } : s,
  );
  config.r2_buckets = config.r2_buckets.map((b: Config) => ({
    ...b,
    bucket_name: n.catalogR2,
    ...(d.jurisdiction ? { jurisdiction: d.jurisdiction } : {}),
  }));
  config.kv_namespaces = config.kv_namespaces.map((k: Config) =>
    k.binding === 'CARDS' ? { ...k, id: d.catalogKvId } : k,
  );
  config.queues = {
    consumers: config.queues.consumers.map((c: Config) => ({
      ...c,
      queue: `${c.queue}${d.suffix}`,
      ...(c.dead_letter_queue ? { dead_letter_queue: `${c.dead_letter_queue}${d.suffix}` } : {}),
    })),
  };
  config.analytics_engine_datasets = config.analytics_engine_datasets.map((a: Config) => ({
    ...a,
    dataset: n.catalogDataset,
  }));
  return config;
}

/**
 * The rate-limit bindings with this deployment's namespaces and budgets. Namespaces are per
 * account: slot 1 keeps the base ids (the web Worker's 1001 to 1005, the storefront's 1006 to
 * 1010), slot 2 uses 2001 and so on. The registry's `limits` replace a binding's requests a
 * minute; the period stays 60 seconds.
 */
function rateLimits(ratelimits: Config[], d: Deployment): Config[] {
  const budgets = new Map(
    Object.entries(d.limits ?? {}).map(([k, v]) => [LIMITS[k as LimitKey] as string, v]),
  );
  return ratelimits.map((r: Config) => ({
    ...r,
    namespace_id: String(d.slot * 1000 + (Number(r.namespace_id) % 1000)),
    ...(budgets.has(r.name) ? { simple: { ...r.simple, limit: budgets.get(r.name) } } : {}),
  }));
}

/**
 * The storefront: buyers' pages and agentic checkout at its own host, on the deployment's engine.
 * It is public, so it binds nothing else: no database, no documents bucket (the engine's
 * `StorefrontApi` does that work) and no principal key. It has no resource of its own to provision.
 */
export function renderStorefront(base: Config, d: Deployment): Config {
  const config = structuredClone(base);
  config.name = names(d).storefront;
  config.routes = [{ pattern: d.storefrontDomain, custom_domain: true }];
  config.workers_dev = false;
  config.preview_urls = false;
  config.services = config.services.map((s: Config) =>
    s.binding === 'ENGINE' ? { ...s, service: names(d).engine } : s,
  );
  config.ratelimits = rateLimits(config.ratelimits, d);
  // Always set, so a deployment without a widget never shows another's.
  config.vars = { ...config.vars, TURNSTILE_SITE_KEY: d.turnstileSiteKey ?? '' };
  return config;
}

export function renderWeb(base: Config, d: Deployment): Config {
  const config = structuredClone(base);
  const n = names(d);
  config.name = n.web;
  config.routes = [{ pattern: d.domain, custom_domain: true }];
  config.workers_dev = false;
  config.preview_urls = false;
  config.services = [
    ...config.services.map((s: Config) =>
      s.binding === 'ENGINE'
        ? { ...s, service: n.engine }
        : s.binding === 'CATALOG'
          ? { ...s, service: n.catalog }
          : s,
    ),
    ...pluginServices(d),
  ];
  config.ratelimits = rateLimits(config.ratelimits, d);
  storage(config, d);
  // The storefront's origin: where a plugin may send a buyer to their cart's start link.
  config.vars = { ...config.vars, STOREFRONT_ORIGIN: `https://${d.storefrontDomain}` };
  // Plugins' aliases, alias → plugin id; always set, so one deployment's never carries over.
  const aliases = Object.fromEntries(
    Object.entries(d.plugins).flatMap(([p, v]) => (v.alias ? [[v.alias, p]] : [])),
  );
  config.vars = {
    ...config.vars,
    PLUGIN_ALIASES: Object.keys(aliases).length ? JSON.stringify(aliases) : '',
  };
  if (d.demo) config.vars = { ...config.vars, DEMO_MODE: 'true' };
  // Always set, so a deployment without a widget never shows another's.
  config.vars = { ...config.vars, TURNSTILE_SITE_KEY: d.turnstileSiteKey ?? '' };
  if (d.sso)
    config.vars = {
      ...config.vars,
      OIDC_ISSUER: d.sso.issuer,
      OIDC_CLIENT_ID: d.sso.clientId,
      OIDC_TRUST_EMAIL: d.sso.trustEmail ? 'true' : '',
    };
  return config;
}

/**
 * Everything the content stack's Workers share, from their own templates (the content stack's
 * `wrangler.jsonc`): the deployment's names and ids in place of the base ones, every account-wide
 * name suffixed, and the content database in `DB`. Bindings a template keeps only for local work
 * (a second, `remote` database, bucket or index) are dropped: a deployed Worker binds the
 * deployment's own and no other.
 */
function contentCommon(base: Config, d: Deployment, app: ContentApp): Config {
  if (!d.content)
    throw new Error(
      `${d.id} has the content stack off: set "content": true in deployments/${d.id}.jsonc`,
    );
  if (!d.contentD1Id)
    throw new Error(`${d.id} has no contentD1Id: run scripts/provision.sh ${d.id}`);
  if (!d.contentKvId && app !== 'studio')
    throw new Error(`${d.id} has no contentKvId: run scripts/provision.sh ${d.id}`);
  const n = names(d);
  const hosts = contentHosts(d);
  const c = structuredClone(base);
  c.name = {
    pipeline: n.pipeline,
    media: n.mediaWorker,
    api: n.api,
    delivery: n.delivery,
    studio: n.studio,
  }[app];
  c.workers_dev = false;
  c.preview_urls = false;
  // Trace events go to the deployment's Logpush job like the commerce Workers' (logpushJob).
  c.logpush = true;
  c.d1_databases = (c.d1_databases ?? [])
    .filter((db: Config) => db.binding === 'DB')
    .map(({ remote: _remote, ...db }: Config) => ({
      ...db,
      database_name: n.contentD1,
      database_id: d.contentD1Id,
    }));
  if (c.kv_namespaces)
    c.kv_namespaces = c.kv_namespaces.map((k: Config) =>
      k.binding === 'KV_CACHE' ? { ...k, id: d.contentKvId } : k,
    );
  if (c.r2_buckets)
    c.r2_buckets = c.r2_buckets
      .filter((b: Config) => b.binding === 'MEDIA_BUCKET')
      .map(({ remote: _remote, ...b }: Config) => ({
        ...b,
        bucket_name: n.mediaBucket,
        ...(d.jurisdiction ? { jurisdiction: d.jurisdiction } : {}),
      }));
  // A demo mocks every model and has no index (provision.sh creates none).
  if (c.vectorize) {
    if (d.demo) delete c.vectorize;
    else
      c.vectorize = c.vectorize
        .filter((v: Config) => v.binding === 'VECTORIZE')
        .map(({ remote: _remote, ...v }: Config) => ({ ...v, index_name: n.contentVectors }));
  }
  if (c.analytics_engine_datasets)
    c.analytics_engine_datasets = c.analytics_engine_datasets.map((a: Config) => ({
      ...a,
      dataset: n.contentDataset,
    }));
  if (c.queues?.producers)
    c.queues.producers = c.queues.producers.map((p: Config) => ({
      ...p,
      queue: n.contentQueue(p.queue),
    }));
  if (c.queues?.consumers)
    c.queues.consumers = c.queues.consumers.map((q: Config) => ({
      ...q,
      queue: n.contentQueue(q.queue),
      ...(q.dead_letter_queue ? { dead_letter_queue: n.contentQueue(q.dead_letter_queue) } : {}),
    }));
  // Workflow names are account-wide; bindings to another script follow its rendered name.
  if (c.workflows)
    c.workflows = c.workflows.map((w: Config) => ({
      ...w,
      name: `${w.name}${d.suffix}`,
      ...(w.script_name ? { script_name: n.pipeline } : {}),
    }));
  if (c.durable_objects?.bindings)
    c.durable_objects.bindings = c.durable_objects.bindings.map((b: Config) =>
      b.script_name ? { ...b, script_name: n.pipeline } : b,
    );
  if (c.services)
    c.services = c.services.map((s: Config) =>
      s.binding === 'API'
        ? { ...s, service: n.api }
        : s.binding === 'DELIVERY'
          ? { ...s, service: n.delivery }
          : s,
    );
  // The content Workers' namespaces sit in the deployment's slot at 500 and up: the commerce
  // Workers' (1001 to 1010 for slot 1) are another set of counters with their own budgets.
  if (c.ratelimits)
    c.ratelimits = c.ratelimits.map((r: Config) => ({
      ...r,
      namespace_id: String(d.slot * 1000 + 500 + (Number(r.namespace_id) % 1000)),
    }));
  if (c.vars) {
    if ('AI_GATEWAY_ID' in c.vars) {
      c.vars.AI_GATEWAY_ID = n.aiGateway;
      c.vars.AI_GATEWAY_LOGS = String(d.aiGatewayLogs);
    }
    if ('MEDIA_BASE_URL' in c.vars) c.vars.MEDIA_BASE_URL = `https://${hosts.api}`;
    if ('MEDIA_PUBLIC_URL' in c.vars) c.vars.MEDIA_PUBLIC_URL = `https://${hosts.media}`;
    if ('QUEUE_SUFFIX' in c.vars) c.vars.QUEUE_SUFFIX = d.suffix;
    // Only Workers that bind Durable Objects need the jurisdiction (the studio binds none).
    if (d.jurisdiction && app !== 'studio') c.vars.DATA_JURISDICTION = d.jurisdiction;
    // A demo mocks every model and has no vector index: those fakes are its point, so it allows
    // them (a persistent deployment refuses fakes it doesn't allow).
    if (d.demo && app !== 'studio') {
      c.vars.AI_MODE = 'mock';
      c.vars.AI_GATEWAY_ID = '';
      c.vars.ALLOW_FAKE_ADAPTERS = 'ai,vectors';
      // The api offers the enterprise starter: a demo is where its brand is shown.
      if ('DEMO_STARTERS' in c.vars) c.vars.DEMO_STARTERS = 'true';
    }
  }
  return c;
}

/** The content engine: queue consumers, cron, and the owner of every content Durable Object and Workflow. No route. */
export function renderPipeline(base: Config, d: Deployment): Config {
  return contentCommon(base, d, 'pipeline');
}

export function renderApi(base: Config, d: Deployment): Config {
  const c = contentCommon(base, d, 'api');
  c.routes = [{ pattern: contentHosts(d).api, custom_domain: true }];
  // OAuth for MCP clients is served on the studio's origin: the consent screen needs the person's
  // session (the studio forwards /oauth/* and /mcp with the signed principal).
  c.vars = { ...c.vars, OAUTH_ISSUER: `https://${contentHosts(d).studio}` };
  return c;
}

export function renderMedia(base: Config, d: Deployment): Config {
  const c = contentCommon(base, d, 'media');
  c.routes = [{ pattern: contentHosts(d).media, custom_domain: true }];
  // Where an `asset:` reference resolves; the base config carries the defaults.
  if (d.mediaScope)
    c.vars = {
      ...c.vars,
      ASSET_REF_SPACE: d.mediaScope.space,
      ASSET_REF_ENV: d.mediaScope.environment,
    };
  return c;
}

/** The content admin and human sign-in; it fronts the api with a signed principal. */
export function renderStudio(base: Config, d: Deployment): Config {
  const c = contentCommon(base, d, 'studio');
  c.routes = [{ pattern: contentHosts(d).studio, custom_domain: true }];
  // The same identity provider as the admin's, a second redirect URI (https://<studio>/login/sso/callback).
  if (d.sso)
    c.vars = {
      ...c.vars,
      OIDC_ISSUER: d.sso.issuer,
      OIDC_CLIENT_ID: d.sso.clientId,
      OIDC_TRUST_EMAIL: d.sso.trustEmail ? 'true' : '',
    };
  return c;
}

function byId(id: string | undefined): Deployment {
  const d = loadDeployments().find((x) => x.id === id);
  if (!d) throw new Error(`no deployment ${JSON.stringify(id)} in deployments/`);
  return d;
}

function render(id: string | undefined) {
  const d = byId(id);
  const template = (app: string, file = 'wrangler.jsonc') =>
    readJsonc(join(ROOT, 'apps', app, file));
  const write = (app: string, config: Config) => {
    const out = join(ROOT, 'apps', app, `wrangler.${d.id}.json`);
    writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
    console.log(out);
  };
  for (const [app, fn] of [
    ['catalog', renderCatalog],
    ['engine', renderEngine],
    ['storefront', renderStorefront],
    ['web', renderWeb],
  ] as const)
    write(app, fn(template(app), d));
  // Catalog-only unless the deployment has content, which adds the dispatcher's content side.
  write(
    'delivery',
    renderDelivery(
      template('delivery', 'wrangler.catalog.jsonc'),
      d,
      d.content ? template('delivery') : undefined,
    ),
  );
  if (d.content)
    for (const [app, fn] of [
      ['pipeline', renderPipeline],
      ['media', renderMedia],
      ['api', renderApi],
      ['studio', renderStudio],
    ] as const)
      write(app, fn(template(app), d));
  for (const p of workerPlugins(d)) {
    const out = join(ROOT, 'plugins', p, `wrangler.${d.id}.json`);
    const base = readJsonc(join(ROOT, 'plugins', p, 'wrangler.jsonc'));
    writeFileSync(out, `${JSON.stringify(renderPlugin(base, d, p), null, 2)}\n`);
    console.log(out);
  }
}

/** `{ staging: [...], internal: [...], ... }`, held deployments left out. */
export function matrix(list: Deployment[]): Record<Ring, Deployment[]> {
  const unprovisioned = list
    .filter(
      (d) =>
        !d.hold &&
        (!d.d1Id ||
          (backsUpD1(d) && !d.standbyD1Id) ||
          !d.catalogKvId ||
          workerPlugins(d).some((p) => !d.plugins[p]!.d1Id) ||
          (d.content && (!d.contentD1Id || !d.contentKvId))),
    )
    .map((d) => d.id);
  if (unprovisioned.length)
    throw new Error(
      `not provisioned (no d1Id, catalogKvId or plugin d1Id, with redundancy no standbyD1Id, or with content no contentD1Id or contentKvId): ${unprovisioned.join(', ')}; provision or hold them`,
    );
  return Object.fromEntries(
    RINGS.map((ring) => [ring, list.filter((d) => d.ring === ring && !d.hold)]),
  ) as Record<Ring, Deployment[]>;
}

/**
 * Why the environment's secrets can't run `app` for `d`, or null. The engine of a Stripe
 * deployment needs STRIPE_SECRET_KEY, in the same mode (test or live) as its publishable key. The
 * web Worker and the storefront of a deployment with a Turnstile site key need TURNSTILE_SECRET_KEY:
 * without it every password sign-in and card payment would be refused. The storefront needs besides
 * only the principal key every app needs, which it is given as a derived key.
 */
export function secretsProblem(
  d: Deployment,
  env: Record<string, string | undefined>,
  app: 'engine' | 'storefront' | 'web',
) {
  if (app === 'storefront' || app === 'web')
    return d.turnstileSiteKey && !env.TURNSTILE_SECRET_KEY
      ? `${d.id} has a turnstileSiteKey: add its widget's secret as TURNSTILE_SECRET_KEY to the ${d.environment} GitHub environment`
      : null;
  if (d.payments !== 'stripe') return null;
  const sk = env.STRIPE_SECRET_KEY;
  if (!sk)
    return `${d.id} takes payments through Stripe: add STRIPE_SECRET_KEY to its GitHub environment`;
  const live = (k: string) => /^(sk|rk|pk)_live_/.test(k);
  if (d.stripePublishableKey && live(sk) !== live(d.stripePublishableKey))
    return `${d.id}: STRIPE_SECRET_KEY and stripePublishableKey are not both test or both live keys`;
  return null;
}

/**
 * The storefront's secrets: `storefrontKey` of the principal key and of the previous one while a
 * rotation finishes, and the Turnstile widget's secret where there is one (it checks a card
 * payment's token). The principal key itself never reaches it.
 */
export function storefrontSecrets(env: Record<string, string | undefined>) {
  const [current, previous] = [env.PRINCIPAL_KEY, env.PRINCIPAL_KEY_PREVIOUS];
  return {
    ...(current ? { STOREFRONT_KEY: storefrontKey(current) } : {}),
    ...(previous ? { STOREFRONT_KEY_PREVIOUS: storefrontKey(previous) } : {}),
    ...(env.TURNSTILE_SECRET_KEY ? { TURNSTILE_SECRET_KEY: env.TURNSTILE_SECRET_KEY } : {}),
  };
}

/**
 * The content Workers' secrets: only the ones set in `env`, plus the pipeline's derived assistant
 * keys. A `content` deployment can't deploy without TOKEN_PEPPER and MEDIA_SIGNING_SECRET as well
 * as the keys every deployment needs, nor with a key too short to sign with.
 */
export function contentSecretValues(
  d: Deployment,
  env: Record<string, string | undefined>,
  app: ContentApp,
): Record<string, string> {
  if (!d.content)
    throw new Error(`${d.id} has the content stack off: no ${app} to collect secrets for`);
  const missing = [...REQUIRED_SECRETS, ...CONTENT_REQUIRED_SECRETS].filter((k) => !env[k]);
  if (missing.length)
    throw new Error(
      `${missing.join(', ')} not set: add it to the ${d.environment} GitHub environment (scripts/provision.sh generates one)`,
    );
  const short = keysProblem(env);
  if (short) throw new Error(short);
  const all = withDerived(env);
  // Only the ones set: `--secrets-file` adds to a Worker's secrets and never removes one.
  return Object.fromEntries(
    CONTENT_SECRETS[app].flatMap((k) => (all[k] ? [[k, all[k] as string]] : [])),
  );
}

function contentSecrets(app: ContentApp, out: string, id: string | undefined) {
  if (!id) throw new Error(`secrets ${app} <out> <deployment id>`);
  const values = contentSecretValues(byId(id), process.env, app);
  writeFileSync(out, JSON.stringify(values), { mode: 0o600 });
  console.log(`${app}: ${Object.keys(values).join(', ') || 'no secrets set'}`);
}

function secrets(app: string | undefined, out: string | undefined, id?: string, more?: string) {
  const usage =
    'secrets <engine|storefront|web|plugin|sandboxed> <out> [id | plugin id]  or  secrets <pipeline|media|api|delivery|studio> <out> <id>';
  if (out && app && app in CONTENT_SECRETS) return contentSecrets(app as ContentApp, out, id);
  if (
    app !== 'web' &&
    app !== 'storefront' &&
    app !== 'engine' &&
    app !== 'plugin' &&
    app !== 'sandboxed'
  )
    throw new Error(usage);
  if (!out) throw new Error(usage);
  if (app === 'plugin') return pluginSecrets(out, id, more);
  if (app === 'sandboxed') return sandboxedSecrets(out, id);
  const missing = REQUIRED_SECRETS.filter((k) => !process.env[k]);
  if (missing.length)
    throw new Error(
      `${missing.join(', ')} not set: add it to the deployment's GitHub environment (scripts/provision.sh generates one)`,
    );
  const short = keysProblem(process.env);
  if (short) throw new Error(short);
  const problem = id ? secretsProblem(byId(id), process.env, app) : null;
  if (problem) throw new Error(problem);
  // Only the ones set: `--secrets-file` adds to a Worker's secrets and never removes one.
  const values =
    app === 'storefront'
      ? storefrontSecrets(process.env)
      : Object.fromEntries(
          SECRETS[app].flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])),
        );
  writeFileSync(out, JSON.stringify(values), { mode: 0o600 });
  console.log(`${app}: ${Object.keys(values).join(', ') || 'no secrets set'}`);
}

/** Names a plugin's env already has from the deployment (`RESERVED_PLUGIN_ENV` in @commerceworker/core). */
const PLUGIN_RESERVED_ENV = new Set([
  'PLUGIN_KEY',
  'PLUGIN_KEY_PREVIOUS',
  'DB',
  'SECRETS',
  'STORAGE',
]);

/**
 * A plugin's own secrets among the deployment's: each `PLUGIN_<ID>_<NAME>` (`pluginSecretVar` in
 * @commerceworker/core), under `<NAME>`. Nothing without the plugin's prefix reaches it.
 */
export function pluginOwnSecrets(plugin: string, source: Record<string, unknown>) {
  const prefix = `${pluginBinding(plugin)}_`;
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (!k.startsWith(prefix) || typeof v !== 'string' || !v) continue;
    const name = k.slice(prefix.length);
    if (!/^[A-Z][A-Z0-9_]{0,62}$/.test(name) || PLUGIN_RESERVED_ENV.has(name))
      throw new Error(`${k}: ${name} can't be a secret name for plugin ${plugin}`);
    values[name] = v;
  }
  return values;
}

/**
 * Sandboxed plugins' secrets, added to the engine's secrets file as PLUGIN_SECRETS (`{ "<id>":
 * { "<NAME>": "…" } }`, each from the environment's PLUGIN_<ID>_* by `pluginOwnSecrets`). A
 * deployment with a Secrets Store reads them from it instead, so nothing is written for it.
 */
function sandboxedSecrets(out: string, id: string | undefined) {
  const d = byId(id);
  const plugins = sandboxedPlugins(d);
  if (!plugins.length || d.secretsStore) {
    console.log(`sandboxed: ${d.secretsStore ? 'secrets come from the Secrets Store' : 'none'}`);
    return;
  }
  const all = process.env.ENV_SECRETS ? JSON.parse(process.env.ENV_SECRETS) : process.env;
  const values = Object.fromEntries(plugins.map((p) => [p, pluginOwnSecrets(p, all)]));
  const file = existsSync(out)
    ? (JSON.parse(readFileSync(out, 'utf8')) as Record<string, string>)
    : {};
  writeFileSync(out, JSON.stringify({ ...file, PLUGIN_SECRETS: JSON.stringify(values) }), {
    mode: 0o600,
  });
  console.log(
    `sandboxed: ${plugins.map((p) => `${p} (${Object.keys(values[p]!).join(', ') || 'no secrets'})`).join('; ')}`,
  );
}

/**
 * The secrets a plugin's manifest needs (`required`, its non-optional names) that the deployment
 * doesn't have: from the environment (PLUGIN_<ID>_<NAME>, shared account), or for a deployment
 * with a Secrets Store, missing from its registry entry's `secrets` or from `stored` (the store's
 * secret names). Presence only: no value is read.
 */
export function missingPluginSecrets(
  d: Deployment,
  p: string,
  required: string[],
  source: { env?: Record<string, unknown>; stored?: string[] },
): string[] {
  if (d.secretsStore) {
    const listed = new Set(d.plugins[p]?.secrets ?? []);
    const stored = new Set(source.stored ?? []);
    return required.filter((n) => !listed.has(n) || !stored.has(pluginSecretVar(p, n)));
  }
  const env = source.env ?? {};
  return required.filter((n) => {
    const v = env[pluginSecretVar(p, n)];
    return typeof v !== 'string' || !v;
  });
}

/**
 * CI's check, before anything deploys: every secret the plugin's manifest (as `scripts/plugin-
 * bundle.ts` extracted it) needs is set. With a Secrets Store, STORE_SECRET_NAMES is the JSON list
 * of the store's secret names; else ENV_SECRETS (the job's secrets) or the environment is checked.
 */
function checkPluginSecrets(id: string | undefined, plugin: string | undefined, manifest?: string) {
  if (!plugin || !manifest) throw new Error('check-plugin-secrets <id> <plugin> <manifest.json>');
  const d = byId(id);
  if (!(plugin in d.plugins)) throw new Error(`${d.id} doesn't install plugin ${plugin}`);
  const m = JSON.parse(readFileSync(manifest, 'utf8')) as {
    id: string;
    secrets: { name: string; optional?: boolean }[];
  };
  if (m.id !== plugin)
    throw new Error(`${manifest}: the manifest's id is "${m.id}", not "${plugin}"`);
  const required = m.secrets.filter((s) => !s.optional).map((s) => s.name);
  const missing = missingPluginSecrets(d, plugin, required, {
    env: process.env.ENV_SECRETS ? JSON.parse(process.env.ENV_SECRETS) : process.env,
    stored: process.env.STORE_SECRET_NAMES ? JSON.parse(process.env.STORE_SECRET_NAMES) : [],
  });
  if (missing.length)
    throw new Error(
      d.secretsStore
        ? `${d.id}: plugin ${plugin} needs ${missing.map((n) => pluginSecretVar(plugin, n)).join(', ')}: list them under plugins.${plugin}.secrets and add them to the Secrets Store`
        : `${d.id}: plugin ${plugin} needs ${missing.map((n) => pluginSecretVar(plugin, n)).join(', ')} in the ${d.environment} GitHub environment`,
    );
  console.log(`${plugin}: ${required.length ? required.join(', ') : 'no required secrets'} set`);
}

/**
 * A plugin's secrets: its own keys derived from PRINCIPAL_KEY (and the one before a rotation), and
 * its PLUGIN_<ID>_* secrets from ENV_SECRETS (the job's `toJSON(secrets)`), else the environment.
 */
function pluginSecrets(out: string, plugin: string | undefined, id?: string) {
  if (!plugin || !/^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){1,30}$/.test(plugin))
    throw new Error('secrets plugin <out> <plugin id> [deployment id]');
  // With a Secrets Store its own secrets are bound from the store (renderPlugin), not written here.
  const fromStore = id ? !!byId(id).secretsStore : false;
  const current = process.env.PRINCIPAL_KEY;
  if (!current) throw new Error("PRINCIPAL_KEY not set: a plugin's key is derived from it");
  const previous = process.env.PRINCIPAL_KEY_PREVIOUS;
  const all = process.env.ENV_SECRETS ? JSON.parse(process.env.ENV_SECRETS) : process.env;
  const values = {
    ...(fromStore ? {} : pluginOwnSecrets(plugin, all)),
    PLUGIN_KEY: pluginKey(current, plugin),
    ...(previous ? { PLUGIN_KEY_PREVIOUS: pluginKey(previous, plugin) } : {}),
  };
  writeFileSync(out, JSON.stringify(values), { mode: 0o600 });
  console.log(`plugin ${plugin}: ${Object.keys(values).join(', ')}`);
}

/** What provision.sh reads (`names`): a deployment's resource names and settings. */
export function shellVars(d: Deployment): Record<string, string> {
  const n = names(d);
  return {
    WEB: n.web,
    STOREFRONT: n.storefront,
    D1: n.d1,
    R2: n.r2,
    AI_GATEWAY: n.aiGateway,
    // The product index (Vectorize); empty for a demo, which has none.
    PRODUCT_INDEX: d.demo ? '' : n.productIndex,
    CATALOG_R2: n.catalogR2,
    // The commerce D1 backups: the bucket, the standby database and how long a backup is kept and
    // locked. All empty without `redundancy` (or with `d1Backup` an exception).
    BACKUPS_R2: backsUpD1(d) ? n.backups : '',
    STANDBY_D1: backsUpD1(d) ? n.standbyD1 : '',
    BACKUP_DAYS: backsUpD1(d) ? String(d.redundancy.backupDays) : '',
    // The docs replica: its bucket, the queue R2's notifications go to and that queue's dead-letter
    // queue. All empty without `redundancy` (or with `r2Replica` an exception).
    DOCS_REPLICA_R2: replicatesDocs(d) ? n.docsReplica : '',
    DOCS_REPLICA_QUEUE: replicatesDocs(d) ? n.docsReplicaQueue : '',
    DOCS_REPLICA_DLQ: replicatesDocs(d) ? n.docsReplicaDlq : '',
    CATALOG_KV: n.catalogKv,
    CATALOG_FEED_PARTS: n.catalogFeedParts,
    CATALOG_FEED_PARTS_DLQ: n.catalogFeedPartsDlq,
    CATALOG_PURGE: n.catalogPurge,
    CATALOG_PURGE_DLQ: n.catalogPurgeDlq,
    CATALOG_CHANGES: n.catalogChanges,
    CATALOG_CHANGES_DLQ: n.catalogChangesDlq,
    CATALOG_DOMAIN: d.catalogDomain,
    DOMAIN: d.domain,
    STOREFRONT_DOMAIN: d.storefrontDomain,
    // The registry's Turnstile site key, to compare with the widget provision.sh finds or creates.
    TURNSTILE_SITE_KEY: d.turnstileSiteKey ?? '',
    ENVIRONMENT: d.environment,
    JURISDICTION: d.jurisdiction ?? '',
    AI_GATEWAY_LOGS: String(d.aiGatewayLogs),
    AUDIT_ARCHIVE_DAYS: String(d.auditArchiveDays ?? ''),
    // How long catalog backups (backups/ in CATALOG_R2) are kept, and locked.
    CATALOG_BACKUP_DAYS: String(d.catalogBackupDays),
    // The logs bucket, how long it keeps what Logpush writes, and the job and R2 token that write
    // it (the job's filter and fields: `fleet.ts logpush <id>`).
    LOGS_R2: n.logs,
    LOG_RETENTION_DAYS: String(d.logRetentionDays),
    LOGPUSH_JOB: n.logpushJob,
    LOGPUSH_TOKEN: n.logpushToken,
    // The content stack: `true` creates its resources too. The rest are empty without it.
    CONTENT: String(d.content),
    CONTENT_D1: d.content ? n.contentD1 : '',
    CONTENT_KV: d.content ? n.contentKv : '',
    CONTENT_MEDIA: d.content ? n.mediaBucket : '',
    // The content vector index (Vectorize); empty for a demo, which mocks its models.
    CONTENT_VECTORS: d.content && !d.demo ? n.contentVectors : '',
    CONTENT_QUEUES: d.content ? CONTENT_QUEUES.map(n.contentQueue).join(' ') : '',
    // The queue the media bucket's object-create notifications go to (asset ingest).
    ASSET_EVENTS: d.content ? n.contentQueue('commerceworker-asset-events') : '',
    STUDIO_DOMAIN: d.studioDomain ?? '',
    API_DOMAIN: d.apiDomain ?? '',
    CDN_DOMAIN: d.cdnDomain ?? '',
    MEDIA_DOMAIN: d.mediaDomain ?? '',
    // The content Workers provision.sh asks for their secrets, to keep a running one's.
    STUDIO: d.content ? n.studio : '',
    API: d.content ? n.api : '',
    // Space-separated plugin ids; each one's D1 database is named commerceworker-plugin-<id><suffix>.
    PLUGINS: workerPlugins(d).join(' '),
    // The deployment's own Secrets Store (own Cloudflare account), when its registry names one.
    SECRETS_STORE: d.secretsStore?.storeId ?? '',
    // Plugins the engine loads from a bundle: no Worker or D1 to create.
    SANDBOXED_PLUGINS: sandboxedPlugins(d).join(' '),
    SUFFIX: d.suffix,
  };
}

/** provision.sh: refuse when another job would collect the deployment's logs (jobs on stdin). */
function logpushForeign(id: string | undefined) {
  const jobs = (
    JSON.parse(readFileSync(0, 'utf8')) as {
      result: { id: number; name?: string; filter?: string }[];
    }
  ).result;
  const foreign = foreignJobsReaching(jobs, byId(id));
  if (foreign.length)
    throw new Error(
      `${foreign.map((j) => `Logpush job ${j.id} (${j.name || 'unnamed'})`).join(', ')} would also take ${id}'s Worker logs: filter it to its own Workers' ScriptName, or delete it`,
    );
}

/**
 * provision.sh: with `body`, the token to create from the permission groups on stdin; with
 * `check <group id>`, fail unless the token details on stdin hold exactly that policy.
 */
function logpushTokenCmd(
  id: string | undefined,
  accountId: string | undefined,
  mode?: string,
  groupId?: string,
) {
  const d = byId(id);
  if (!accountId) throw new Error('logpush-token <id> <account id> [check <group id>]');
  const input = JSON.parse(readFileSync(0, 'utf8')) as { result: unknown };
  if (mode === undefined) {
    console.log(
      JSON.stringify(logpushToken(d, accountId, input.result as { id: string; name: string }[])),
    );
    return;
  }
  if (mode !== 'check' || !groupId)
    throw new Error('logpush-token <id> <account id> check <group id>');
  const expected = logpushToken(d, accountId, [{ id: groupId, name: R2_WRITE_GROUP }]);
  if (!tokenMatches(input.result as Parameters<typeof tokenMatches>[0], expected))
    throw new Error(
      `token ${expected.name} exists but isn't R2 object writes on ${names(d).logs} alone: check it, or delete it so provision.sh makes it again`,
    );
}

function shellNames(id: string | undefined) {
  for (const [k, v] of Object.entries(shellVars(byId(id)))) console.log(`${k}='${v}'`);
}

/** Writes one field into deployments/<id>.jsonc, keeping its comments. */
function setField(
  id: string | undefined,
  field: 'd1Id' | 'standbyD1Id' | 'catalogKvId' | 'contentD1Id' | 'contentKvId',
  value: string,
) {
  const d = byId(id);
  if (field.startsWith('content') && !d.content)
    throw new Error(
      `${d.id} has the content stack off: set "content": true before recording ${field}`,
    );
  const file = join(ROOT, 'deployments', `${d.id}.jsonc`);
  const text = readFileSync(file, 'utf8');
  const edits = modify(text, [field], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  writeFileSync(file, applyEdits(text, edits));
}

function setPluginD1(id: string | undefined, plugin: string | undefined, uuid: string | undefined) {
  if (!plugin || !uuid || !/^[0-9a-f-]{36}$/.test(uuid))
    throw new Error('set-plugin-d1 <id> <plugin> <uuid>');
  const d = byId(id);
  if (!(plugin in d.plugins)) throw new Error(`${d.id} doesn't install plugin ${plugin}`);
  const file = join(ROOT, 'deployments', `${d.id}.jsonc`);
  const text = readFileSync(file, 'utf8');
  const edits = modify(text, ['plugins', plugin, 'd1Id'], uuid, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  writeFileSync(file, applyEdits(text, edits));
}

function setD1(id: string | undefined, uuid: string | undefined) {
  if (!uuid || !/^[0-9a-f-]{36}$/.test(uuid)) throw new Error('set-d1 <id> <uuid>');
  setField(id, 'd1Id', uuid);
}

function setStandbyD1(id: string | undefined, uuid: string | undefined) {
  if (!uuid || !/^[0-9a-f-]{36}$/.test(uuid)) throw new Error('set-standby-d1 <id> <uuid>');
  const d = byId(id);
  if (!backsUpD1(d))
    throw new Error(`${d.id} has no redundancy: set it before recording standbyD1Id`);
  setField(id, 'standbyD1Id', uuid);
}

function setCatalogKv(id: string | undefined, kvId: string | undefined) {
  if (!kvId || !/^[0-9a-f]{32}$/.test(kvId)) throw new Error('set-catalog-kv <id> <namespace id>');
  setField(id, 'catalogKvId', kvId);
}

function setContentD1(id: string | undefined, uuid: string | undefined) {
  if (!uuid || !/^[0-9a-f-]{36}$/.test(uuid)) throw new Error('set-content-d1 <id> <uuid>');
  setField(id, 'contentD1Id', uuid);
}

function setContentKv(id: string | undefined, kvId: string | undefined) {
  if (!kvId || !/^[0-9a-f]{32}$/.test(kvId)) throw new Error('set-content-kv <id> <namespace id>');
  setField(id, 'contentKvId', kvId);
}

async function status() {
  for (const d of loadDeployments()) {
    let health = 'unreachable';
    try {
      const r = await fetch(`https://${d.domain}/health/deep`, {
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await r.json()) as { ok: boolean; checks: Record<string, string> };
      const failed = Object.entries(body.checks)
        .filter(([, s]) => s !== 'ok')
        .map(([k]) => k);
      health = body.ok ? 'ok' : `fail (${failed.join(', ')})`;
    } catch {}
    const flags = [d.hold && 'hold', d.jurisdiction].filter(Boolean).join(' ');
    console.log([d.id.padEnd(16), d.ring.padEnd(9), d.domain.padEnd(28), health, flags].join(' '));
  }
}

/** The write check's path and header (`HEALTH_WRITE_PATH`, `HEALTH_CHECK_HEADER` in @commerceworker/core). */
const HEALTH_WRITE_PATH = '/health/write';
const HEALTH_CHECK_HEADER = 'x-commerceworker-health-check';

/**
 * The key the deploy smoke test signs its write check with: the HMAC of the deployment's principal
 * key with the check's own label, as `healthCheckKey` in @commerceworker/core derives it (fleet.test.ts
 * holds the two to the same vector).
 */
export const healthCheckKey = (principalKey: string) =>
  createHmac('sha256', principalKey).update('commerceworker-health-check').digest('hex');

/**
 * The key the storefront signs and verifies with: the HMAC of the deployment's principal key with
 * the storefront's own label, as `storefrontKey` in @commerceworker/core derives it (fleet.test.ts
 * holds the two to the same vector). The storefront gets this and never the principal key itself.
 */
export const storefrontKey = (principalKey: string) =>
  createHmac('sha256', principalKey).update('commerceworker-storefront').digest('hex');

/** The write check's header value, good for a minute (`signHealthCheck` in @commerceworker/core). */
export function signHealthCheck(principalKey: string, now = Date.now()): string {
  const body = JSON.stringify({ path: HEALTH_WRITE_PATH, exp: now + 60_000 });
  const signed = `h1.${Buffer.from(body).toString('base64url')}`;
  const sig = createHmac('sha256', healthCheckKey(principalKey)).update(signed).digest('base64url');
  return `${signed}.${sig}`;
}

/** How long the write check may take in all: five minutes, like the smoke test's curl checks. */
export const WRITE_CHECK_DEADLINE_MS = 5 * 60_000;
/** How long one attempt may take before it counts as failed (the Workers' own checks take 3 s). */
export const WRITE_CHECK_ATTEMPT_MS = 10_000;
/** The wait between attempts. */
export const WRITE_CHECK_DELAY_MS = 10_000;

/**
 * Posts the write check to `url` until it answers `200` or `deadlineMs` has passed, and returns the
 * report. No attempt and no wait runs past the deadline, so the whole check ends within it (a new
 * Worker version takes a moment to be everywhere; the deploy job's Smoke test step also has a
 * timeout of its own). Each attempt is signed afresh, since a header lasts a minute. The header is
 * never printed; a report names only checks and pass or fail.
 */
export async function postWriteCheck(
  url: string,
  principalKey: string,
  {
    deadlineMs = WRITE_CHECK_DEADLINE_MS,
    attemptMs = WRITE_CHECK_ATTEMPT_MS,
    delayMs = WRITE_CHECK_DELAY_MS,
    log = console.log as (line: string) => void,
  } = {},
): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  let last = 'no attempt';
  for (let attempt = 1; ; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { [HEALTH_CHECK_HEADER]: signHealthCheck(principalKey) },
        signal: AbortSignal.timeout(Math.min(attemptMs, left)),
      });
      const body = await r.text();
      if (r.ok) return body;
      last = `${r.status} ${body.slice(0, 500)}`;
    } catch (err) {
      last = (err as Error).message;
    }
    const wait = Math.min(delayMs, deadline - Date.now());
    if (wait <= 0) break;
    log(`write check attempt ${attempt} failed: ${last}`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  throw new Error(`write check failed: ${last}`);
}

/** The write check on deployment `id`, with PRINCIPAL_KEY from the environment. */
async function writeCheck(id: string | undefined) {
  const key = process.env.PRINCIPAL_KEY;
  if (!key) throw new Error('write-check needs PRINCIPAL_KEY in the environment');
  console.log(await postWriteCheck(`https://${byId(id).domain}${HEALTH_WRITE_PATH}`, key));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'render') render(args[0]);
    else if (cmd === 'matrix') console.log(JSON.stringify(matrix(loadDeployments())));
    else if (cmd === 'secrets') secrets(args[0], args[1], args[2], args[3]);
    else if (cmd === 'check-plugin-secrets') checkPluginSecrets(args[0], args[1], args[2]);
    else if (cmd === 'status') await status();
    else if (cmd === 'write-check') await writeCheck(args[0]);
    else if (cmd === 'names') shellNames(args[0]);
    else if (cmd === 'logpush') console.log(JSON.stringify(logpushJob(byId(args[0]))));
    else if (cmd === 'logpush-foreign') logpushForeign(args[0]);
    else if (cmd === 'logpush-token') logpushTokenCmd(args[0], args[1], args[2], args[3]);
    else if (cmd === 'set-d1') setD1(args[0], args[1]);
    else if (cmd === 'set-standby-d1') setStandbyD1(args[0], args[1]);
    else if (cmd === 'set-catalog-kv') setCatalogKv(args[0], args[1]);
    else if (cmd === 'set-plugin-d1') setPluginD1(args[0], args[1], args[2]);
    else if (cmd === 'set-content-d1') setContentD1(args[0], args[1]);
    else if (cmd === 'set-content-kv') setContentKv(args[0], args[1]);
    else if (cmd === 'demos')
      console.log(JSON.stringify(loadDeployments().filter((d) => d.demo && d.d1Id)));
    else
      throw new Error(
        'usage: fleet.ts render|matrix|secrets|check-plugin-secrets|status|write-check|names|logpush|logpush-foreign|logpush-token|set-d1|set-standby-d1|set-catalog-kv|set-plugin-d1|set-content-d1|set-content-kv|demos (see the header)',
      );
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
