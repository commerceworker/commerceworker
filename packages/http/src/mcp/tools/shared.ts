import {
  type Asset,
  AssetRightsError,
  type ContentAction,
  DATE_FORMATS,
  FIELD_GUIDANCE_LIMITS,
  FIELD_TYPES,
  PATTERN_PRESETS,
  type PermissionScope,
  type Principal,
  type Scope,
} from '@commerceworker/domain';
import { z } from 'zod';
import { assetPageResponse, assetResponse } from '../../api/asset-response';
import { toHttpError } from '../../api/http';
import type { McpDeps } from '../deps';

/**
 * What every area's tools share: the scope arguments and their defaults, the result shape, the
 * schemas more than one area takes, and the per-process schema cache. `ToolContext` is what
 * `buildServer` hands each area's `register…Tools`: the request's deps and principal and the
 * guards bound to them.
 */

export const DEFAULT_SPACE = process.env.SEED_SPACE_ID ?? 'space-1';
export const DEFAULT_ENV = process.env.SEED_ENV_ID ?? 'main';

export const scopeArgs = {
  space: z.string().optional().describe('Space id (defaults to the server default).'),
  environment: z.string().optional().describe('Environment id (defaults to "main").'),
};
export const scopeOf = (a: { space?: string; environment?: string }): Scope => ({
  spaceId: a.space ?? DEFAULT_SPACE,
  environmentId: a.environment ?? DEFAULT_ENV,
});

export const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

export const fieldSchema = z.object({
  apiId: z.string(),
  name: z.string(),
  type: z.enum(FIELD_TYPES as unknown as [string, ...string[]]),
  localized: z.boolean().default(false),
  required: z.boolean().default(false),
  position: z.number().int(),
  // Listed explicitly: this schema strips unknown keys, so an omitted
  // attribute would be silently dropped rather than rejected.
  unique: z.boolean().optional().describe('no two entries may share a value (per locale)'),
  defaultValue: z.any().optional().describe('applied on create when the field is omitted'),
  // Untyped and uncapped here, as on the route: the domain checks them, and lets a value stored
  // before guidance was checked through unchanged.
  help: z
    .unknown()
    .optional()
    .describe(
      `how to fill the field (text, at most ${FIELD_GUIDANCE_LIMITS.help} characters): shown ` +
        'under the editor input; follow it when writing values',
    ),
  placeholder: z
    .unknown()
    .optional()
    .describe(
      `an example shown in the empty input (text, at most ${FIELD_GUIDANCE_LIMITS.placeholder} ` +
        'characters); never stored',
    ),
  description: z
    .unknown()
    .optional()
    .describe(
      `what the field means, for agents and API readers (text, at most ` +
        `${FIELD_GUIDANCE_LIMITS.description} characters)`,
    ),
  format: z
    .enum(DATE_FORMATS)
    .optional()
    .describe(
      'Date only: "date" (YYYY-MM-DD), "datetime" (YYYY-MM-DDThh:mm, optional seconds and ' +
        'offset) or "time" (hh:mm); absent, any ISO-8601 string',
    ),
  validations: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      '{ in?: allowed values, each bare or { value, label } (entries store the value), ' +
        `regexp?: { pattern, flags? } or { preset: ${Object.keys(PATTERN_PRESETS).join('|')} }, ` +
        'range?: { min?, max? }, size?: { min?, max? }, linkContentTypes?, ' +
        'dateRange?: { min?, max? } (a Date, in its format), ' +
        'assetMimeTypes?: ["image/*", "application/pdf"] (an asset Link or list of them), ' +
        'messages?: { in|regexp|range|size|dateRange|assetMimeTypes: error text replacing the default } }',
    ),
  // Shaped by the domain, which names what is wrong with a rule; described here so an agent can
  // write one.
  rules: z
    .array(z.record(z.string(), z.any()))
    .optional()
    .describe(
      'hide or disable this field while a sibling matches: [{ action: "hide"|"disable", when: ' +
        '{ field: sibling apiId or dot path into a sibling component, operator: ' +
        'eq|ne|in|empty|notEmpty|gt|lt, value? } }]. A hidden field is not required; a disabled ' +
        'one keeps its stored value, and a write that changes it is refused',
    ),
  linkType: z.enum(['Entry', 'Asset']).optional(),
  items: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      'Array: { type: Symbol|Text|Integer|Number|Date|Link|Component, format? (Date), ' +
        'linkType?, validations?, fields? } — or, for a blocks field, { type: "Component", ' +
        'variants: [{ apiId, name, fields }] } instead of fields',
    ),
  fields: z
    .array(z.record(z.string(), z.any()))
    .optional()
    .describe('Component: the nested field definitions'),
});
export const entryFields = z
  .record(z.string(), z.record(z.string(), z.any()))
  .describe('fieldApiId -> { locale: value }');

export const grantShape = z.object({
  contentTypeApiId: z.string().describe("content type apiId, or '*' for all"),
  actions: z
    .array(z.enum(['read', 'write', 'publish']))
    .describe('write also grants delete (trash, purge); publish also grants delete and unpublish'),
  deniedActions: z
    .array(z.enum(['delete', 'unpublish']))
    .optional()
    .describe('withhold delete or unpublish, e.g. ["delete"] to write without deleting'),
  deniedFields: z.array(z.string()).optional(),
  readOnlyFields: z.array(z.string()).optional(),
});

export const importMapping = {
  contentTypeApiId: z.string(),
  fields: z.record(z.string(), z.string()).describe('target field apiId -> source field name'),
  identityField: z
    .string()
    .optional()
    .describe('target field holding the source id; without it a re-run duplicates everything'),
  locale: z.string().optional(),
  conflicts: z.enum(['skip', 'update', 'fail']).optional().describe('default skip'),
  sourceOptions: z
    .record(z.string().max(64), z.unknown())
    .optional()
    .describe('per-source options, e.g. { postType: "page" } for wxr'),
};
export const importArgs = {
  source: z.string(),
  payload: z.string(),
  ...importMapping,
  ...scopeArgs,
};

/**
 * Tool input schemas, built once per process and reused by every request.
 * buildServer runs per request (the transport is stateless), and constructing
 * ~100 Zod schemas — then converting each to JSON Schema on every tools/list —
 * was nearly all of its cost; registering prebuilt schemas is ~50x cheaper.
 * A schema must therefore never depend on the principal or deps.
 */
const schemaCache = new Map<string, z.ZodType>();
export function toolSchema<T extends z.ZodType>(tool: string, build: () => T): T {
  let schema = schemaCache.get(tool) as T | undefined;
  if (!schema) {
    schema = memoizeJsonSchema(build());
    schemaCache.set(tool, schema);
  }
  return schema;
}

/**
 * Memoizes a schema's Standard JSON Schema conversion, which the SDK otherwise
 * repeats on every tools/list. Results are deep-frozen because every request
 * now shares them.
 */
function memoizeJsonSchema<T extends z.ZodType>(schema: T): T {
  const std = schema['~standard'];
  const convert = std.jsonSchema;
  if (!convert) return schema;
  const memo = new Map<string, Record<string, unknown>>();
  const cached =
    (io: 'input' | 'output') =>
    (options: Parameters<typeof convert.input>[0]): Record<string, unknown> => {
      const key = `${io}:${options.target}`;
      let json = memo.get(key);
      if (!json) {
        json = deepFreeze(convert[io](options));
        memo.set(key, json);
      }
      return json;
    };
  Object.defineProperty(schema, '~standard', {
    value: { ...std, jsonSchema: { input: cached('input'), output: cached('output') } },
    configurable: true,
  });
  return schema;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A read's MCP annotations: changes nothing, and the same call answers the same way. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

/**
 * Every asset goes out through REST's serializer: a short-lived signed URL, never the stored
 * non-expiring one, and none of the server's own fields (r2Key). Without a blob store (local
 * fakes) there is nothing to sign with.
 */
export function signedAssets(deps: McpDeps) {
  const signedOne = (s: Scope, asset: Asset) => assetResponse(deps.blob, s, asset);
  const signedPage = <P extends { items: Asset[] }>(s: Scope, page: P) =>
    assetPageResponse(deps.blob, s, page);
  return { signedOne, signedPage };
}

/**
 * An asset's rights refusing it (an embargo not yet lifted, rights expired) as REST's 409 body:
 * the code and the instant that decides it, which a thrown error's message alone would drop.
 */
export async function rightsRefusal(run: () => Promise<ReturnType<typeof ok>>) {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof AssetRightsError)) throw err;
    return { ...ok(toHttpError(err).body), isError: true };
  }
}

/** What `buildServer` binds per request and every area's tools close over. */
export interface ToolContext {
  readonly deps: McpDeps;
  readonly ctx: McpDeps['ctx'];
  readonly ai: McpDeps['ai'];
  readonly rag: McpDeps['rag'];
  readonly agents: McpDeps['agents'];
  readonly principal: Principal;
  /** Authorizes `scope` in the target space; throws `ForbiddenError`. */
  readonly guard: (scope: PermissionScope, s: Scope) => void;
  /** Granular RBAC on one entry, for role-bound principals: every one of `action` is needed. */
  readonly guardEntry: (
    s: Scope,
    id: string,
    action: ContentAction | readonly ContentAction[],
  ) => Promise<void>;
  /** Granular RBAC for trashing one entry (`authorizeTrash`), for role-bound principals. */
  readonly guardTrash: (s: Scope, id: string) => Promise<void>;
  /** Authorizes read on an entry and returns its content type, to mask denied fields. */
  readonly authorizeEntryRead: (s: Scope, id: string) => Promise<string>;
  /** The `environment` each call named, before alias resolution, keyed by the resolved args. */
  readonly requestedEnvironment: WeakMap<object, string>;
  /** What a call created, keyed by its args, for the audit row's target (when args can't say). */
  readonly auditTarget: WeakMap<object, string>;
}
