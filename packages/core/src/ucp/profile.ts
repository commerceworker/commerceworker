/**
 * Discovery and negotiation. CommerceWorker publishes a business profile at `/.well-known/ucp`; each
 * platform names its own profile in `UCP-Agent`, and the capabilities active for a request are
 * the ones both profiles list at a common version, less any extension whose parent didn't make it.
 */

import { z } from 'zod';
import { egressProblem } from '../egress';
import { UCP_VERSION } from './errors';
import { isInnerList, parseDictionary } from './structured';

export const UCP_PROFILE_PATH = '/.well-known/ucp';
/** The engine's UCP surface: REST under `/ucp/v1`, MCP at `/ucp/mcp`. */
export const UCP_PATH = '/ucp';
export const UCP_REST_PATH = '/ucp/v1';
export const UCP_MCP_PATH = '/ucp/mcp';

/**
 * The catalog's read operations. Over REST each is `POST` under `UCP_REST_PATH`; over MCP it is the
 * tool of the same name. The storefront gives them their own request budget, so it recognises them
 * in a path and in an MCP call, as the engine does to route them.
 */
export const UCP_CATALOG_ROUTES = {
  '/catalog/search': 'search_catalog',
  '/catalog/lookup': 'lookup_catalog',
  '/catalog/product': 'get_product',
} as const;
export type UcpCatalogOp = (typeof UCP_CATALOG_ROUTES)[keyof typeof UCP_CATALOG_ROUTES];
export const UCP_CATALOG_TOOLS: readonly string[] = Object.values(UCP_CATALOG_ROUTES);

/**
 * The catalog operation a request path names, or null. Empty segments are ignored, as the engine's
 * router ignores them, so a doubled or trailing slash names the same operation in both.
 */
export function ucpCatalogOp(pathname: string): UcpCatalogOp | null {
  if (!pathname.startsWith(`${UCP_REST_PATH}/`)) return null;
  const rest = `/${pathname.slice(UCP_REST_PATH.length).split('/').filter(Boolean).join('/')}`;
  return Object.hasOwn(UCP_CATALOG_ROUTES, rest)
    ? UCP_CATALOG_ROUTES[rest as keyof typeof UCP_CATALOG_ROUTES]
    : null;
}

/** Platform API keys look like `cmw_ucp_<43 base64url chars>`. */
export const UCP_PLATFORM_KEY_PREFIX = 'cmw_ucp_';

const isUrl = (u: string) => {
  try {
    return ['https:', 'http:'].includes(new URL(u).protocol);
  } catch {
    return false;
  }
};

const isHttpsUrl = (u: string) => {
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
};

/** The workspace setting (`workspace_settings`) holding `UcpSettings` as JSON. */
export const UCP_SETTINGS_KEY = 'ucp';

/**
 * What an admin sets for agentic checkout. With no checkout flow it is off: discovery answers 404
 * and every `/ucp` call is refused.
 */
export const ucpSettingsSchema = z.object({
  /** The flow a completed checkout starts (its latest published version). */
  checkoutFlowId: z.string().min(1).max(100).nullable(),
  /** Legal links every checkout shows the buyer (privacy policy, terms, refund policy…). */
  links: z
    .array(
      z.object({
        type: z.string().min(1).max(40),
        url: z.string().url().max(500),
        title: z.string().max(100).optional(),
      }),
    )
    .max(10)
    .default([]),
  /** Where a buyer sees their order: a URL with `{id}`, e.g. `https://shop.example/orders/{id}`. */
  orderUrl: z
    .string()
    .max(500)
    .refine((u) => u.includes('{id}') && isUrl(u.replace('{id}', 'x')), 'A URL with {id}')
    .nullable()
    .default(null),
  /**
   * Where a buyer sees a product, for catalog search and lookup: an https URL with `{slug}` and/or
   * `{key}`, e.g. `https://shop.example/p/{slug}`. Null: results carry no product URL.
   */
  productUrl: z
    .string()
    .max(500)
    .refine(
      (u) =>
        /\{(slug|key)\}/.test(u) &&
        isHttpsUrl(u.replaceAll('{slug}', 'x').replaceAll('{key}', 'x')),
      'An https URL with {slug} or {key}',
    )
    .nullable()
    .default(null),
});
export type UcpSettings = z.infer<typeof ucpSettingsSchema>;

/** A platform an admin let in, as the admin API shows it: never its key. */
export const ucpPlatformSchema = z.object({
  id: z.string(),
  name: z.string(),
  profileUrl: z.string().describe('The UCP profile the platform must name in `UCP-Agent`'),
  keyPrefix: z.string().describe('The key’s first characters, to tell keys apart'),
  createdAt: z.number().int(),
  createdBy: z.string().nullable(),
  lastUsedAt: z.number().int().nullable(),
  revokedAt: z.number().int().nullable(),
});

/** Agentic checkout's settings and the platforms let in (`GET /api/v1/ucp`). */
export const ucpAdminSchema = z.object({
  settings: ucpSettingsSchema,
  platforms: z.array(ucpPlatformSchema),
});

/** A platform just let in, with its API key, shown only once. */
export const ucpPlatformKeySchema = z.object({
  platform: ucpPlatformSchema,
  key: z.string().describe('The platform’s API key. It is shown only once'),
});

/** A registered platform as the storefront needs it: who it is and the profile it must name. */
export type UcpPlatformRef = { id: string; name: string; profileUrl: string };

/** The workspace setting (`workspace_settings`) holding `StorefrontSettings` as JSON. */
export const STOREFRONT_SETTINGS_KEY = 'storefront';

/**
 * What the public storefront offers buyers. Hosted checkout is off until an admin turns it on:
 * with it off the engine refuses every hosted call and `create_checkout` makes no link.
 */
export const storefrontSettingsSchema = z.object({
  checkout: z
    .object({
      enabled: z
        .boolean()
        .default(false)
        .describe('Whether buyers can open a hosted checkout; off, every link stops working'),
      /** The flow a hosted checkout is priced by and places its order on; UCP's when unset. */
      checkoutFlowId: z
        .string()
        .min(1)
        .max(100)
        .nullable()
        .default(null)
        .describe('The published flow that prices a hosted checkout; null uses agentic checkout’s'),
      /** Whether the buyer may change the lines on their page; off, only the merchant's call does. */
      editLines: z
        .boolean()
        .default(false)
        .describe('Whether the buyer may change the lines on their page'),
    })
    .default({ enabled: false, checkoutFlowId: null, editLines: false }),
});
export type StorefrontSettings = z.infer<typeof storefrontSettingsSchema>;

/** Hosted checkout's settings as the admin API shows them (`GET /api/v1/storefront`). */
export const storefrontAdminSchema = z.object({ settings: storefrontSettingsSchema });

export const STOREFRONT_OFF: StorefrontSettings = storefrontSettingsSchema.parse({});

/** Settings as stored, or off when there are none or they don't parse. */
export function readStorefrontSettings(raw: string | null | undefined): StorefrontSettings {
  if (!raw) return STOREFRONT_OFF;
  try {
    const parsed = storefrontSettingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : STOREFRONT_OFF;
  } catch {
    return STOREFRONT_OFF;
  }
}

export const UCP_OFF: UcpSettings = {
  checkoutFlowId: null,
  links: [],
  orderUrl: null,
  productUrl: null,
};

/** Settings as stored, or off when there are none or they don't parse. */
export function readUcpSettings(raw: string | null | undefined): UcpSettings {
  if (!raw) return UCP_OFF;
  try {
    const parsed = ucpSettingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : UCP_OFF;
  } catch {
    return UCP_OFF;
  }
}

/** The order's page for its buyer: the configured template, else the app's. */
export const orderPermalink = (s: UcpSettings, origin: string, orderId: string) =>
  s.orderUrl
    ? s.orderUrl.replace('{id}', encodeURIComponent(orderId))
    : `${origin}/orders/${encodeURIComponent(orderId)}`;

export const CHECKOUT_CAPABILITY = 'dev.ucp.shopping.checkout';
export const FULFILLMENT_CAPABILITY = 'dev.ucp.shopping.fulfillment';
export const DISCOUNT_CAPABILITY = 'dev.ucp.shopping.discount';
export const ORDER_CAPABILITY = 'dev.ucp.shopping.order';
/** `search_catalog`. */
export const CATALOG_SEARCH_CAPABILITY = 'dev.ucp.shopping.catalog.search';
/** `lookup_catalog` and `get_product`. */
export const CATALOG_LOOKUP_CAPABILITY = 'dev.ucp.shopping.catalog.lookup';

// Spec pages checked against upstream's docs at cd78fb3 (`specification/shopping/catalog/{search,lookup}.md`).
const SPEC = `https://ucp.dev/${UCP_VERSION}`;

/** CommerceWorker's capabilities, each `{ version, spec, schema, extends? }` as the profile lists it. */
export const UCP_CAPABILITIES = {
  [CHECKOUT_CAPABILITY]: {
    spec: `${SPEC}/specification/shopping/checkout`,
    schema: `${SPEC}/schemas/shopping/checkout.json`,
  },
  [FULFILLMENT_CAPABILITY]: {
    spec: `${SPEC}/specification/shopping/extensions/fulfillment`,
    schema: `${SPEC}/schemas/shopping/fulfillment.json`,
    extends: CHECKOUT_CAPABILITY,
  },
  [DISCOUNT_CAPABILITY]: {
    spec: `${SPEC}/specification/shopping/extensions/discount`,
    schema: `${SPEC}/schemas/shopping/discount.json`,
    extends: CHECKOUT_CAPABILITY,
  },
  [ORDER_CAPABILITY]: {
    spec: `${SPEC}/specification/shopping/order`,
    schema: `${SPEC}/schemas/shopping/order.json`,
  },
  [CATALOG_SEARCH_CAPABILITY]: {
    spec: `${SPEC}/specification/shopping/catalog/search`,
    schema: `${SPEC}/schemas/shopping/catalog_search.json`,
  },
  [CATALOG_LOOKUP_CAPABILITY]: {
    spec: `${SPEC}/specification/shopping/catalog/lookup`,
    schema: `${SPEC}/schemas/shopping/catalog_lookup.json`,
  },
} as const;
export type UcpCapability = keyof typeof UCP_CAPABILITIES;

/** A payment handler as the profile advertises it (`payment_handler.json`, business schema). */
export type UcpPaymentHandler = {
  /** Reverse-domain name the handler is registered under. */
  name: string;
  id: string;
  version: string;
  spec: string;
  schema: string;
  available_instruments?: { type: string; constraints?: unknown }[];
  config?: Record<string, unknown>;
};

export type UcpPublicKey = {
  kid: string;
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  alg?: string;
  use?: string;
};

const handlerEntry = ({ name: _name, ...h }: UcpPaymentHandler) => h;

/** The business profile served at `/.well-known/ucp` on `origin`. */
export function businessProfile(
  origin: string,
  handlers: UcpPaymentHandler[],
  keys: UcpPublicKey[],
) {
  const service = (transport: 'rest' | 'mcp', path: string, schema: string) => ({
    version: UCP_VERSION,
    spec: `${SPEC}/specification/overview/`,
    transport,
    endpoint: `${origin}${path}`,
    schema: `${SPEC}/services/shopping/${schema}`,
  });
  const byName = new Map<string, ReturnType<typeof handlerEntry>[]>();
  for (const h of handlers) byName.set(h.name, [...(byName.get(h.name) ?? []), handlerEntry(h)]);
  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        'dev.ucp.shopping': [
          service('rest', UCP_REST_PATH, 'rest.openapi.json'),
          service('mcp', UCP_MCP_PATH, 'mcp.openrpc.json'),
        ],
      },
      capabilities: Object.fromEntries(
        Object.entries(UCP_CAPABILITIES).map(([name, c]) => [
          name,
          [{ version: UCP_VERSION, ...c }],
        ]),
      ),
      payment_handlers: Object.fromEntries(byName),
    },
    keys,
  };
}

/** The profile URL in a `UCP-Agent` header (`profile="https://…"`), or null. */
export function ucpAgentProfile(header: string | null | undefined): string | null {
  const m = parseDictionary(header)?.get('profile');
  if (!m || isInnerList(m) || typeof m.value !== 'string') return null;
  try {
    const url = new URL(m.value);
    return url.protocol === 'https:' || url.hostname === 'localhost' ? url.href : null;
  } catch {
    return null;
  }
}

/** The header CommerceWorker sends as a business (webhooks): its own profile. */
export const ucpAgentHeader = (origin: string) => `profile="${origin}${UCP_PROFILE_PATH}"`;

/** What CommerceWorker reads from a platform's profile. */
export type PlatformProfile = {
  version: string;
  /** Capability name → versions the platform supports, with the newest entry's `config`. */
  capabilities: Map<
    string,
    { versions: string[]; extends: string[]; config?: Record<string, unknown> }
  >;
  /** The order capability's `config.webhook_url`, if the platform wants order events. */
  webhookUrl: string | null;
  keys: UcpPublicKey[];
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REVERSE_DOMAIN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/** A platform profile's parts CommerceWorker uses, or the reason it can't be used. */
export function parsePlatformProfile(doc: unknown): PlatformProfile | { problem: string } {
  if (!doc || typeof doc !== 'object') return { problem: 'The profile is not a JSON object.' };
  const ucp = (doc as { ucp?: unknown }).ucp as Record<string, unknown> | undefined;
  if (!ucp || typeof ucp !== 'object') return { problem: 'The profile has no ucp object.' };
  if (typeof ucp.version !== 'string' || !DATE.test(ucp.version))
    return { problem: 'The profile has no ucp.version.' };
  const caps = new Map<
    string,
    { versions: string[]; extends: string[]; config?: Record<string, unknown> }
  >();
  const registry = ucp.capabilities;
  if (registry && typeof registry === 'object')
    for (const [name, entries] of Object.entries(registry as Record<string, unknown>)) {
      if (!REVERSE_DOMAIN.test(name) || !Array.isArray(entries)) continue;
      const valid = entries.filter(
        (e): e is { version: string; extends?: unknown; config?: unknown } =>
          !!e && typeof e === 'object' && DATE.test(String((e as { version?: unknown }).version)),
      );
      if (!valid.length) continue;
      const newest = [...valid].sort((a, b) => b.version.localeCompare(a.version))[0]!;
      const ext = newest.extends;
      caps.set(name, {
        versions: valid.map((e) => e.version),
        extends: typeof ext === 'string' ? [ext] : Array.isArray(ext) ? ext.map(String) : [],
        ...(newest.config && typeof newest.config === 'object'
          ? { config: newest.config as Record<string, unknown> }
          : {}),
      });
    }
  const hook = caps.get(ORDER_CAPABILITY)?.config?.webhook_url;
  let webhookUrl: string | null = null;
  // Kept only where a delivery may go (the egress policy, with localhost for local development).
  if (typeof hook === 'string' && egressProblem(hook, { loopback: true }) === null)
    webhookUrl = new URL(hook).href;
  const keys = Array.isArray((doc as { keys?: unknown }).keys)
    ? ((doc as { keys: unknown[] }).keys.filter(
        (k) =>
          !!k &&
          typeof k === 'object' &&
          typeof (k as UcpPublicKey).kid === 'string' &&
          typeof (k as UcpPublicKey).kty === 'string',
      ) as UcpPublicKey[])
    : [];
  return { version: ucp.version, capabilities: caps, webhookUrl, keys };
}

export type Negotiated =
  | { ok: true; capabilities: Map<UcpCapability, string> }
  | { ok: false; code: 'version_unsupported' | 'capabilities_incompatible'; content: string };

/**
 * The capabilities active between CommerceWorker and a platform: each of ours the platform lists at a
 * version both support (the newest such), then without extensions whose parent is gone. A
 * platform on a newer protocol version than ours is refused (`version_unsupported`).
 */
export function negotiate(platform: PlatformProfile): Negotiated {
  if (platform.version > UCP_VERSION)
    return {
      ok: false,
      code: 'version_unsupported',
      content: `This business supports UCP ${UCP_VERSION}; the platform profile is ${platform.version}.`,
    };
  const active = new Map<UcpCapability, string>();
  for (const name of Object.keys(UCP_CAPABILITIES) as UcpCapability[]) {
    const theirs = platform.capabilities.get(name);
    if (theirs?.versions.includes(UCP_VERSION)) active.set(name, UCP_VERSION);
  }
  for (let pruned = true; pruned; ) {
    pruned = false;
    for (const name of active.keys()) {
      const parent = (UCP_CAPABILITIES[name] as { extends?: string }).extends;
      if (parent && !active.has(parent as UcpCapability)) {
        active.delete(name);
        pruned = true;
      }
    }
  }
  if (!active.size)
    return {
      ok: false,
      code: 'capabilities_incompatible',
      content: 'The platform profile shares no capability with this business.',
    };
  return { ok: true, capabilities: active };
}

/**
 * The `ucp.capabilities` a response lists: the active ones relevant to it (the root capability
 * and its extensions), each as `[{ version }]`.
 */
export function responseCapabilities(active: Map<UcpCapability, string>, root: UcpCapability) {
  const out: Record<string, { version: string }[]> = {};
  for (const [name, version] of active) {
    const parent = (UCP_CAPABILITIES[name] as { extends?: string }).extends;
    if (name === root || parent === root) out[name] = [{ version }];
  }
  return out;
}
