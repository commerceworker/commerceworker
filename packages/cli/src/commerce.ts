import {
  type CallOptions,
  type CommerceClient,
  type CommerceError,
  createCommerceClient,
  isCommerceApiError,
  isCommerceError,
  OPERATIONS,
  type OperationId,
  type WhoamiResult,
} from '@commerceworker/sdk-commerce';
import {
  announce,
  arg,
  bool,
  type Command,
  type CommandContext,
  type CommerceContext,
  int,
  jsonFlag,
  str,
} from './args.js';
import { type Profile, productOf, readCredentials, writeCredentials } from './credentials.js';
import type { Io } from './io.js';
import {
  assertIssuer,
  discover,
  FIRST_PARTY_CLIENT_ID,
  pollForToken,
  type ServerMetadata,
  startDevice,
} from './oauth.js';
import { cleanDeep, stripControl } from './origin.js';
import { ApiFailure, EXIT, type Result, usageError } from './output.js';
import {
  type CommerceSession,
  originOf,
  profileName,
  resolveCommerceSession,
  type Target,
} from './session.js';

/**
 * The commerce half of the CLI: sign-in against the admin origin, and one command per common
 * task over the generated client. Every command prints one JSON document (agents first); the
 * generated operation table behind `run` reaches the rest of the REST API.
 */

/** A grant never carries `admin` (the REST API refuses it), so the CLI doesn't offer it. */
const ROLES = ['viewer', 'approver', 'operator'] as const;

export const commerceClientFor = (
  session: CommerceSession,
  io: Pick<Io, 'fetch'>,
): CommerceClient =>
  createCommerceClient({ baseUrl: session.url, token: session.token, fetch: io.fetch });

export async function commerceContext(target: Target, io: Io): Promise<CommerceContext> {
  const session = await resolveCommerceSession(target, io);
  return { session, client: commerceClientFor(session, io) };
}

// --- errors ------------------------------------------------------------------

/** A 403 that says a person must do this: what changes prices or tax is never done by a token. */
const PERSON_ONLY = /\b(person|signed in|confirm)/i;

/** Admin pages that exist per resource; anything else links to the admin's home. */
const ADMIN_PAGES: Readonly<Record<string, boolean>> = {
  orders: true,
  carts: true,
  flows: true,
  quotes: true,
  'purchase-orders': true,
  'price-books': true,
  customers: true,
  promotions: false,
};

/** Where in the admin a person can do an operation themselves: its resource's page. */
export function adminLink(origin: string, operationId: string, input: unknown): string {
  const spec = (OPERATIONS as Record<string, { path: string } | undefined>)[operationId];
  const [resource, second] = (spec?.path ?? '').replace('/api/v1', '').split('/').filter(Boolean);
  if (!resource || !(resource in ADMIN_PAGES)) return `${origin}/`;
  const param = second?.match(/^\{(\w+)\}$/)?.[1];
  const value = param ? (input as Record<string, unknown> | undefined)?.[param] : undefined;
  return ADMIN_PAGES[resource] && value
    ? `${origin}/${resource}/${encodeURIComponent(String(value))}`
    : `${origin}/${resource}`;
}

/** The SDK's error as a CLI failure; a 401 is an auth failure (exit 3), anything else exit 1. */
export function failureOf(
  err: CommerceError,
  origin: string,
  operationId?: string,
  input?: unknown,
): ApiFailure {
  const status = isCommerceApiError(err) ? err.status : undefined;
  const message = stripControl(err.message);
  const personOnly = status === 403 && PERSON_ONLY.test(message);
  return new ApiFailure(
    status === 401 ? 'The token was refused (401). Run `commerceworker login` again.' : message,
    status === 401 ? EXIT.auth : EXIT.failure,
    err.kind,
    {
      ...(status === undefined ? {} : { status }),
      ...(err.requestId ? { requestId: stripControl(err.requestId) } : {}),
      ...(err.operationId || operationId ? { operationId: err.operationId ?? operationId } : {}),
      ...(isCommerceApiError(err) && err.issues.length ? { issues: cleanDeep(err.issues) } : {}),
      ...(personOnly && operationId ? { adminLink: adminLink(origin, operationId, input) } : {}),
    },
  );
}

type Caller = (operationId: string, input?: unknown, options?: CallOptions) => Promise<unknown>;

/** One operation by id; the SDK's refusals become {@link ApiFailure}s, its misuse a usage error. */
async function invoke(
  ctx: CommandContext,
  operationId: string,
  input: Record<string, unknown> = {},
  options?: CallOptions,
): Promise<Result> {
  const { client, session } = await ctx.commerce();
  try {
    const data = await (client as unknown as { call: Caller }).call(operationId, input, options);
    return reply(data);
  } catch (err) {
    if (isCommerceError(err)) throw failureOf(err, session.url, operationId, input);
    if (err instanceof TypeError) throw usageError(err.message);
    throw err;
  }
}

const reply = (data: unknown): Result => ({ json: data ?? null, human: '', jsonDefault: true });

/** The flags that were given, as an operation's input. */
function given(ctx: CommandContext, flags: Record<string, 'string' | 'int'>) {
  const out: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(flags)) {
    const value = kind === 'int' ? int(ctx, key) : str(ctx, key);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// --- whoami and sign-in ------------------------------------------------------

/** Whether `whoami` should ask a commerce deployment: by the stored profile, or the env token. */
export async function isCommerceCall(ctx: CommandContext): Promise<boolean> {
  const { io, target } = ctx;
  const envToken = io.env.COMMERCEWORKER_TOKEN;
  if (envToken) {
    const flag = str(ctx, 'product');
    return flag ? flag === 'commerce' : envToken.startsWith('cmw_live_');
  }
  const credentials = await readCredentials(io);
  const profile = credentials.profiles[profileName(target, io, credentials.current)];
  return profile ? productOf(profile) === 'commerce' : false;
}

export async function commerceWhoami(ctx: CommandContext): Promise<Result> {
  const { client, session } = await ctx.commerce();
  let me: WhoamiResult;
  try {
    me = await client.whoami();
  } catch (err) {
    if (isCommerceError(err)) throw failureOf(err, session.url, 'whoami');
    throw err;
  }
  return reply({ url: session.url, source: session.source, ...me });
}

const subjectOf = (me: WhoamiResult): string | undefined =>
  stripControl(me.subject.email ?? me.subject.name ?? me.subject.label ?? '') || undefined;

/**
 * `login` for a commerce deployment: the RFC 8628 device flow for the REST API as an OAuth
 * resource (RFC 8707), or a stored API token. `rawUrl` is the admin origin.
 */
export async function commerceLogin(
  ctx: CommandContext,
  name: string,
  rawUrl: string,
  token: string | undefined,
  discovered?: ServerMetadata,
): Promise<Result> {
  const { io } = ctx;
  const origin = originOf(rawUrl);
  const role = str(ctx, 'role') ?? 'viewer';
  if (!(ROLES as readonly string[]).includes(role)) {
    throw usageError(
      `--role is one of ${ROLES.join(', ')} (a grant never carries admin; use an API token for that).`,
    );
  }
  const session = (accessToken: string): CommerceSession => ({
    url: origin,
    token: accessToken,
    source: name,
  });
  const whoami = async (accessToken: string) => {
    try {
      return await commerceClientFor(session(accessToken), io).whoami();
    } catch (err) {
      if (isCommerceError(err)) throw failureOf(err, origin, 'whoami');
      throw err;
    }
  };

  let profile: Profile;
  if (token) {
    const me = await whoami(token);
    profile = {
      product: 'commerce',
      url: origin,
      accessToken: token,
      scopes: [me.role],
      subject: subjectOf(me),
      ...(me.expiresAt ? { expiresAt: me.expiresAt } : {}),
    };
  } else {
    const meta = discovered ?? (await discover(io, origin));
    // RFC 8414 §3.3: the issuer is the origin the document was fetched from.
    assertIssuer(meta, origin);
    const resource = `${origin}/api/v1`;
    // The first-party client is pre-registered on every commerce deployment: the metadata names
    // it, the constant covers a server that doesn't, and commerce never registers.
    const clientId = meta.commerceworker_cli_client_id ?? FIRST_PARTY_CLIENT_ID;
    const device = await startDevice(io, meta, clientId, role, resource);
    await announce(ctx, device, origin);
    const tokens = await pollForToken(io, meta, clientId, device, resource);
    const me = await whoami(tokens.access_token);
    profile = {
      product: 'commerce',
      url: origin,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in ? io.now() + tokens.expires_in * 1000 : undefined,
      clientId,
      scopes: [me.role],
      subject: subjectOf(me),
    };
  }

  const latest = await readCredentials(io);
  await writeCredentials(io, { current: name, profiles: { ...latest.profiles, [name]: profile } });
  return reply({
    profile: name,
    product: 'commerce',
    url: origin,
    role: profile.scopes?.[0],
    subject: profile.subject,
    method: token ? 'token' : 'device',
  });
}

// --- commands ----------------------------------------------------------------

const commerce = (
  name: string,
  summary: string,
  options: Command['options'],
  run: Command['run'],
  args?: string,
): Command => ({ name, product: 'commerce', summary, options, run, ...(args ? { args } : {}) });

const LIST_STRINGS = { status: 'string', model: 'string', channel: 'string', q: 'string' } as const;

const ordersList = commerce(
  'orders list',
  'List orders, newest first; --all follows every page',
  {
    status: {
      type: 'string',
      description:
        'queued, running, waiting, completed, declined, cancelled, failed or rolled_back',
    },
    model: {
      type: 'string',
      description: 'b2b, b2c, d2c, marketplace, subscription, procurement or replenishment',
    },
    channel: {
      type: 'string',
      description: 'web, mobile, pos, marketplace, email, edi, api, manual, schedule or agent',
    },
    q: { type: 'string', description: 'Search text' },
    limit: { type: 'string', description: 'Orders per page' },
    cursor: { type: 'string', description: 'Continue from a previous page’s nextCursor' },
    all: { type: 'boolean', description: 'Follow every page and print one list' },
  },
  async (ctx) => {
    const input = { ...given(ctx, { ...LIST_STRINGS, limit: 'int', cursor: 'string' }) };
    if (!bool(ctx, 'all')) return invoke(ctx, 'list_orders', input);
    const { client, session } = await ctx.commerce();
    const orders: unknown[] = [];
    try {
      for await (const order of client.paginate('list_orders', input)) orders.push(order);
    } catch (err) {
      if (isCommerceError(err)) throw failureOf(err, session.url, 'list_orders', input);
      throw err;
    }
    return reply({ orders });
  },
);

const ordersGet = commerce(
  'orders get',
  'Show an order: its state, steps and what it waits on',
  {},
  (ctx) => invoke(ctx, 'get_order_state', { id: arg(ctx, 0, 'order id') }),
  '<order id>',
);

const ordersCancel = commerce(
  'orders cancel',
  'Cancel an order (operator); its steps roll back',
  { reason: { type: 'string', description: 'Why, kept on the order’s timeline' } },
  (ctx) =>
    invoke(ctx, 'cancel_order', {
      id: arg(ctx, 0, 'order id'),
      ...given(ctx, { reason: 'string' }),
    }),
  '<order id>',
);

const flowsList = commerce('flows list', 'List flows', {}, (ctx) => invoke(ctx, 'list_flows'));

const flowsGet = commerce(
  'flows get',
  'Show a flow: its graph and the draft to publish or test',
  {},
  (ctx) => invoke(ctx, 'get_flow', { flowId: arg(ctx, 0, 'flow id') }),
  '<flow id>',
);

const DRAFT: Command['options'] = {
  draft: {
    type: 'string',
    description: 'The draft from `flows get`: refused (409) if the flow changed since',
  },
};

const flowsPublish = commerce(
  'flows publish',
  'Publish a flow’s draft (operator)',
  DRAFT,
  (ctx) =>
    invoke(ctx, 'publish_flow', {
      flowId: arg(ctx, 0, 'flow id'),
      ...given(ctx, { draft: 'string' }),
    }),
  '<flow id>',
);

const flowsTest = commerce(
  'flows test',
  'Run a flow’s draft against its test scenarios',
  DRAFT,
  (ctx) =>
    invoke(ctx, 'test_flow', {
      flowId: arg(ctx, 0, 'flow id'),
      ...given(ctx, { draft: 'string' }),
    }),
  '<flow id>',
);

const approvalsDecide = commerce(
  'approvals decide',
  'Approve or reject an order’s approval step (approver)',
  {
    decision: { type: 'string', description: 'approved or rejected (required)' },
    note: { type: 'string', description: 'Kept with the decision' },
    'on-behalf-of': {
      type: 'string',
      description: 'A company member’s id, for a company approval',
    },
  },
  (ctx) => {
    const decision = str(ctx, 'decision');
    if (decision !== 'approved' && decision !== 'rejected') {
      throw usageError('--decision is approved or rejected.');
    }
    const onBehalfOf = str(ctx, 'on-behalf-of');
    return invoke(ctx, 'decide_approval', {
      id: arg(ctx, 0, 'order id'),
      nodeId: arg(ctx, 1, 'approval step id'),
      decision,
      ...given(ctx, { note: 'string' }),
      ...(onBehalfOf ? { onBehalfOf } : {}),
    });
  },
  '<order id> <step id>',
);

const cartsList = commerce(
  'carts list',
  'List carts',
  {
    status: { type: 'string', description: 'open, locked, submitted, returned or canceled' },
    limit: { type: 'string', description: 'Most to return' },
  },
  (ctx) => invoke(ctx, 'list_carts', given(ctx, { status: 'string', limit: 'int' })),
);

const cartsGet = commerce(
  'carts get',
  'Show a cart',
  {},
  (ctx) => invoke(ctx, 'get_cart', { id: arg(ctx, 0, 'cart id') }),
  '<cart id>',
);

const catalogProductsGet = commerce(
  'catalog products get',
  'Show a catalog product by key',
  {},
  (ctx) => invoke(ctx, 'get_catalog_product', { key: arg(ctx, 0, 'product key') }),
  '<key>',
);

const INPUT: Command['options'] = {
  input: { type: 'string', description: 'The input as JSON, or @file to read it from a file' },
};

const catalogProductsPut = commerce(
  'catalog products put',
  'Create or replace catalog products from JSON: an array, or { "products": [...] }',
  INPUT,
  async (ctx) => {
    const body = await jsonFlag<unknown>(ctx, 'input');
    const products = Array.isArray(body) ? body : (body as { products?: unknown } | null)?.products;
    if (!Array.isArray(products)) {
      throw usageError('--input is an array of products, or an object with a products array.');
    }
    return invoke(ctx, 'put_catalog_products', { products });
  },
);

const runOperation = commerce(
  'run',
  'Call any REST operation by its operationId (see --list), with --input JSON',
  {
    ...INPUT,
    list: { type: 'boolean', description: 'List every operationId with its method and path' },
    'idempotency-key': {
      type: 'string',
      description: 'Make a write happen once (operations that take one, such as start_order)',
    },
  },
  async (ctx) => {
    if (bool(ctx, 'list')) {
      return reply(
        Object.entries(OPERATIONS).map(([operationId, op]) => ({
          operationId,
          method: op.method,
          path: op.path,
        })),
      );
    }
    const operationId = arg(ctx, 0, 'operationId (see --list)');
    if (!(operationId in OPERATIONS)) {
      throw usageError(
        `Unknown operation "${operationId}". \`commerceworker run --list\` names them.`,
      );
    }
    const input = ctx.values.input === undefined ? {} : await jsonFlag<unknown>(ctx, 'input');
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw usageError('--input is a JSON object.');
    }
    const key = str(ctx, 'idempotency-key');
    return invoke(ctx, operationId as OperationId, input as Record<string, unknown>, {
      ...(key ? { idempotencyKey: key } : {}),
    });
  },
  '<operationId>',
);

export const COMMERCE_COMMANDS: readonly Command[] = [
  ordersList,
  ordersGet,
  ordersCancel,
  flowsList,
  flowsGet,
  flowsPublish,
  flowsTest,
  approvalsDecide,
  cartsList,
  cartsGet,
  catalogProductsGet,
  catalogProductsPut,
  runOperation,
];
