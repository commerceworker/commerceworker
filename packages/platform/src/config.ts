/**
 * 12-factor environment configuration. Adapter selection is driven entirely by
 * vars and bindings (each app's wrangler.jsonc), so one codebase serves every
 * Worker and environment.
 */

/** Requests permitted per window, per client, per class. `0` disables a class. */
export interface RateLimitBudgets {
  readonly read: number;
  readonly write: number;
  readonly ai: number;
  /** Rolling window length. */
  readonly windowSeconds: number;
}

export type Role = 'all' | 'management' | 'delivery' | 'preview';

/**
 * True when this deployment mounts the given API surface. ROLE is a single
 * role or a comma-separated union (e.g. `delivery,preview` for a scale-out
 * read plane that serves drafts too); `all` mounts everything.
 */
export function mountsRole(config: Pick<ApiConfig, 'role'>, role: Exclude<Role, 'all'>): boolean {
  const roles = config.role.split(',').map((s) => s.trim());
  return roles.includes('all') || roles.includes(role);
}

export interface ApiConfig {
  /** One {@link Role}, or a comma-separated union — check via {@link mountsRole}. */
  readonly role: string;
  /** Content Management API key (write access). */
  readonly cmaKey: string;
  /** Content Delivery API key (read published). */
  readonly cdaKey: string;
  /** Content Preview API key (read drafts). */
  readonly cpaKey: string;
  /** Root/admin bearer token — all scopes, all spaces (provisioning). */
  readonly adminToken: string;
  /** Optional server-side pepper mixed into API key hashes at rest. */
  readonly tokenPepper?: string;
  /**
   * Dev seeding. The in-memory store always seeds space + keys; SEED_DEV=true
   * additionally runs the @commerceworker/seed demo dataset (all content types, a scaled
   * entry corpus, and every platform surface) so a fresh stack is usable out
   * of the box. Never enable in production.
   */
  readonly seedDev: boolean;
  /**
   * Whether creating a space offers the demo starters (DEMO_STARTERS=true): the enterprise starter,
   * a large fictional brand installed in the background. Demo deployments and local dev only.
   */
  readonly demoStarters: boolean;
  /** Default space/env + locales used to seed the in-memory store. */
  readonly seed: {
    spaceId: string;
    environmentId: string;
    defaultLocale: string;
    locales: string[];
    /** Corpus multiplier (SEED_SCALE): 1 = demo (~550 entries), 100 = bench. */
    scale: number;
  };
  /**
   * Signs OAuth consent forms when no PRINCIPAL_KEY is set (local and test wiring only; a
   * deployment signs them with a key derived from PRINCIPAL_KEY).
   */
  readonly sessionSecret: string;
  /**
   * Keys that verify the web Worker's signed principal (`x-cw-principal`): PRINCIPAL_KEY, then
   * PRINCIPAL_KEY_PREVIOUS during a rotation. Empty → browser sessions can't reach the api.
   */
  readonly principalKeys: readonly string[];
  /**
   * OAuth 2.1 authorization server. Enabled by setting {@link oauthIssuer} to
   * this deployment's public base URL — it must be the externally reachable
   * origin, because it is published in discovery metadata and used to build
   * redirect and verification URLs that clients and humans follow.
   */
  readonly oauthIssuer?: string;
  /** Canonical URI of the protected MCP resource. Defaults to `<issuer>/mcp`. */
  readonly oauthResource?: string;
  readonly oauthAccessTokenTtlSeconds: number;
  readonly oauthRefreshTokenTtlSeconds: number;
  /** Max accepted request body size in bytes (DoS guard). Default 5 MiB. */
  readonly maxBodyBytes?: number;
  /** Trusted reverse proxies in front (spoof-resistant X-Forwarded-For parsing). */
  readonly trustedProxyCount?: number;
  /**
   * When true, publishing an entry runs the moderation classifier first and
   * blocks the publish if the content is flagged (a synchronous pre-publish
   * gate). Off by default — moderation otherwise runs post-publish and retracts.
   */
  readonly moderateBeforePublish?: boolean;
  /**
   * Deployment policy for installing plugins from a URL.
   *
   * A caller may ask for a longer wait or a narrower host set than this; never
   * a shorter or wider one — a policy a caller can turn off is not a policy.
   */
  readonly pluginSources?: {
    readonly minimumReleaseAgeHours?: number;
    readonly allowedHosts?: readonly string[];
  };
  /**
   * Per-space AI usage ceilings over a rolling window. Guards against a single
   * space driving unbounded LLM spend. Set `maxRequests` or `maxTokens` to 0 to
   * disable metering entirely.
   */
  readonly aiBudget?: {
    readonly maxRequests: number;
    readonly maxTokens: number;
    readonly windowSeconds: number;
  };
  /**
   * Per-client request-rate ceilings, bucketed by marginal cost. Off by default
   * (every class `0`) so existing deployments and the k6 benchmarks are
   * unaffected; publicly reachable deployments should set all three.
   */
  readonly rateLimit?: RateLimitBudgets;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const role = (env.ROLE ?? 'all').trim();
  const roles = role.split(',').map((s) => s.trim());
  if (
    roles.length === 0 ||
    roles.some((r) => !['all', 'management', 'preview', 'delivery'].includes(r))
  ) {
    throw new Error(`Invalid ROLE "${role}"`);
  }
  // The dev keys exist to seed the in-memory store (demo, tests, local without D1). A Worker with a
  // database bound never gets them: an unset ADMIN_TOKEN is then '' (off; every check is guarded
  // on it being non-empty), never a well-known token that would grant wildcard admin.
  const persistent = Boolean((env as Record<string, unknown>).DB);
  const dev = (value: string | undefined, fallback: string) =>
    value ?? (persistent ? '' : fallback);
  return {
    role,
    cmaKey: dev(env.CMA_KEY, 'dev-cma-key'),
    cdaKey: dev(env.CDA_KEY, 'dev-cda-key'),
    cpaKey: dev(env.CPA_KEY, 'dev-cpa-key'),
    adminToken: dev(env.ADMIN_TOKEN, 'dev-admin-token'),
    tokenPepper: env.TOKEN_PEPPER,
    seedDev: env.SEED_DEV === 'true',
    demoStarters: env.DEMO_STARTERS === 'true',
    seed: {
      spaceId: env.SEED_SPACE_ID ?? 'space-1',
      environmentId: env.SEED_ENV_ID ?? 'main',
      defaultLocale: env.SEED_DEFAULT_LOCALE ?? 'en-US',
      locales: (env.SEED_LOCALES ?? 'en-US').split(',').map((s) => s.trim()),
      scale: Math.max(1, Math.floor(Number(env.SEED_SCALE ?? '1')) || 1),
    },
    sessionSecret: env.SESSION_SECRET ?? 'dev-session-secret-change-me-in-production',
    principalKeys: [env.PRINCIPAL_KEY, env.PRINCIPAL_KEY_PREVIOUS].filter((k): k is string =>
      Boolean(k),
    ),
    // The Worker configs declare both as "" (unset); an empty string must mean unset, or the
    // resource becomes "" instead of `${issuer}/mcp` and no authorization request can match it.
    oauthIssuer: env.OAUTH_ISSUER || undefined,
    oauthResource: env.OAUTH_RESOURCE || undefined,
    oauthAccessTokenTtlSeconds: Number(env.OAUTH_ACCESS_TOKEN_TTL_SECONDS ?? 3600),
    oauthRefreshTokenTtlSeconds: Number(env.OAUTH_REFRESH_TOKEN_TTL_SECONDS ?? 30 * 24 * 3600),
    maxBodyBytes: Number(env.MAX_BODY_BYTES ?? 5 * 1024 * 1024),
    trustedProxyCount: Number(env.TRUSTED_PROXY_COUNT ?? 1),
    moderateBeforePublish: env.AGENTS_MODERATE_BLOCKING === 'true',
    pluginSources: {
      ...(Number(env.PLUGIN_MIN_RELEASE_AGE_HOURS) > 0
        ? { minimumReleaseAgeHours: Number(env.PLUGIN_MIN_RELEASE_AGE_HOURS) }
        : {}),
      ...(env.PLUGIN_SOURCE_HOSTS
        ? {
            allowedHosts: env.PLUGIN_SOURCE_HOSTS.split(',')
              .map((h) => h.trim())
              .filter(Boolean),
          }
        : {}),
    },
    aiBudget: {
      maxRequests: Number(env.AI_MAX_REQUESTS_PER_WINDOW ?? 60),
      maxTokens: Number(env.AI_MAX_TOKENS_PER_WINDOW ?? 200_000),
      windowSeconds: Number(env.AI_BUDGET_WINDOW_SECONDS ?? 60),
    },
    rateLimit: {
      read: nonNegative(env.RATE_LIMIT_READ_PER_WINDOW),
      write: nonNegative(env.RATE_LIMIT_WRITE_PER_WINDOW),
      ai: nonNegative(env.RATE_LIMIT_AI_PER_WINDOW),
      windowSeconds: Math.max(1, Number(env.RATE_LIMIT_WINDOW_SECONDS ?? 60) || 60),
    },
  };
}

/** Parses a budget: absent, non-numeric, or negative all mean "no limit". */
function nonNegative(raw: string | undefined): number {
  const n = Math.floor(Number(raw ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
