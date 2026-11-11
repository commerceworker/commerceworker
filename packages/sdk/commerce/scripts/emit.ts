/**
 * Turns the REST API's OpenAPI document into `src/generated/operations.ts`: a request and a result
 * type for every operation and a table of how to call each one. Pure (no web imports), so the
 * generator and its tests share it; `generate.ts` feeds it the live document.
 *
 * The JSON Schemas come from the web app's zod schemas, so the emitter covers what zod writes
 * (types, enums, unions, tuples, records, `$ref`s into `components` and one recursive `$defs`), and
 * throws on a keyword it doesn't know rather than guessing: a new one is a decision, not a default.
 */

type Schema = { [key: string]: unknown };

interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  schema?: Schema;
}

interface Operation {
  operationId?: string;
  summary?: string;
  security?: unknown[];
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<
    string,
    { description?: string; content?: { 'application/json'?: { schema?: Schema } } }
  >;
}

export interface OpenApiLike {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
}

const PAGE_PARAMS = ['cursor'];
const PAGE_NEXT = ['cursor', 'nextCursor'];
const METHODS = ['get', 'post', 'delete'];
const SUCCESS = ['200', '201', '202'];

const pascal = (id: string) =>
  id
    .split(/[_\-\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');

const isIdent = (s: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
const key = (s: string) => (isIdent(s) ? s : JSON.stringify(s));
const doc = (text: unknown, pad: string) =>
  typeof text === 'string' && text.trim()
    ? `${pad}/** ${text.replace(/\s+/g, ' ').replace(/\*\//g, '*\\/').trim()} */\n`
    : '';

/** What a schema's `$ref` names, and what an emission has pulled in from `components`. */
interface Ctx {
  components: Record<string, Schema>;
  used: Set<string>;
  /** `$defs` of the schema being emitted, by `$ref`, with the type name each gets. */
  defs: Map<string, string>;
}

const KNOWN = new Set([
  '$schema',
  '$ref',
  '$defs',
  'type',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  'items',
  'prefixItems',
  'properties',
  'required',
  'additionalProperties',
  // Constraints and annotations: they refine a value, not its TypeScript type.
  'description',
  'title',
  'default',
  'examples',
  'format',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'multipleOf',
  'propertyNames',
  'uniqueItems',
  'deprecated',
  'readOnly',
]);

const union = (parts: string[]) => [...new Set(parts)].join(' | ') || 'never';
const paren = (t: string) => (/[|&]/.test(t) ? `(${t})` : t);

function emitType(s: Schema | boolean, ctx: Ctx, pad: string): string {
  if (s === true) return 'unknown';
  if (s === false) return 'never';
  for (const k of Object.keys(s))
    if (!KNOWN.has(k)) throw new Error(`unsupported JSON Schema keyword "${k}"`);

  const ref = s.$ref;
  if (typeof ref === 'string') {
    const comp = /^#\/components\/schemas\/(.+)$/.exec(ref)?.[1];
    if (comp) {
      if (!ctx.components[comp]) throw new Error(`unknown component ${ref}`);
      ctx.used.add(comp);
      return comp;
    }
    const def = /^#\/\$defs\/(.+)$/.exec(ref)?.[1];
    const name = def && ctx.defs.get(def);
    if (!name) throw new Error(`unresolved ${ref}`);
    return name;
  }
  if ('const' in s) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return union(s.enum.map((v) => JSON.stringify(v)));
  const alt = (s.anyOf ?? s.oneOf) as Schema[] | undefined;
  if (alt) return union(alt.map((a) => emitType(a, ctx, pad)));
  if (Array.isArray(s.allOf))
    return (s.allOf as Schema[]).map((a) => paren(emitType(a, ctx, pad))).join(' & ');
  if (Array.isArray(s.type))
    return union((s.type as string[]).map((t) => emitType({ ...s, type: t }, ctx, pad)));

  const type = s.type ?? (s.properties || s.additionalProperties ? 'object' : undefined);
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      if (Array.isArray(s.prefixItems))
        return `[${(s.prefixItems as Schema[]).map((p) => emitType(p, ctx, pad)).join(', ')}]`;
      return `${paren(emitType((s.items ?? true) as Schema | boolean, ctx, pad))}[]`;
    }
    case 'object':
      return emitObject(s, ctx, pad);
    case undefined:
      return 'unknown';
    default:
      throw new Error(`unsupported JSON Schema type "${String(type)}"`);
  }
}

function emitObject(s: Schema, ctx: Ctx, pad: string): string {
  const props = (s.properties ?? {}) as Record<string, Schema | boolean>;
  const required = new Set((s.required ?? []) as string[]);
  const extra = s.additionalProperties;
  const extraType =
    extra === undefined || extra === false ? null : emitType(extra as Schema | boolean, ctx, pad);
  const names = Object.keys(props);
  if (!names.length)
    // An index signature, not `Record`: a recursive value type may name itself through one.
    return `{ [key: string]: ${extraType ?? 'unknown'} }`;
  const inner = `${pad}  `;
  const lines = names.map((name) => {
    const p = props[name] as Schema | boolean;
    const d = typeof p === 'object' ? doc(p.description, inner) : '';
    return `${d}${inner}${key(name)}${required.has(name) ? '' : '?'}: ${emitType(p, ctx, inner)};\n`;
  });
  const body = `{\n${lines.join('')}${pad}}`;
  return extraType ? `${body} & { [key: string]: ${extraType} }` : body;
}

interface Op {
  id: string;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  summary: string;
  pathParams: string[];
  input: 'query' | 'body' | 'raw' | 'none';
  /** A `raw` body's media types, the first being the default. */
  contentTypes: string[];
  idempotent: boolean;
  inputSchema: Schema;
  resultSchema: Schema | null;
}

/** Path params in the order the path names them. */
const pathParamsOf = (path: string) => [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? '');

function collect(openapi: OpenApiLike): Op[] {
  const ops: Op[] = [];
  for (const [path, item] of Object.entries(openapi.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const id = op.operationId;
      if (!id) throw new Error(`${method} ${path} has no operationId`);
      // A signed receiver (security: []) is called by a provider that holds a secret, not by a
      // client holding a token; verifying what it sends is `verifyCommerceWebhook`'s job.
      if (Array.isArray(op.security) && op.security.length === 0) continue;

      const params = op.parameters ?? [];
      const pathParams = pathParamsOf(path);
      const idempotent = params.some((p) => p.in === 'header' && p.name === 'Idempotency-Key');
      const bodySchema = op.requestBody?.content?.['application/json']?.schema;

      const properties: Record<string, Schema | boolean> = {};
      const required: string[] = [];
      for (const name of pathParams) {
        properties[name] = { type: 'string' };
        required.push(name);
      }
      const mediaTypes = Object.keys(op.requestBody?.content ?? {});
      const raw = method === 'post' && !bodySchema && mediaTypes.length > 0;
      let input: Op['input'];
      let inputSchema: Schema;
      if (raw) {
        // A file upload (a catalog feed, an EDI interchange): the text is the body, the media type
        // one of the operation's, and the rest of the input is its query string.
        input = 'raw';
        properties.body = { type: 'string' };
        required.push('body');
        properties.contentType = { enum: mediaTypes };
        for (const p of params) {
          if (p.in !== 'query') continue;
          properties[p.name] = p.schema ?? {};
          if (p.required) required.push(p.name);
        }
        inputSchema = { type: 'object', properties, required };
      } else if (method === 'post' && bodySchema) {
        input = 'body';
        const plain =
          bodySchema.type === 'object' &&
          bodySchema.properties &&
          !bodySchema.allOf &&
          !bodySchema.anyOf &&
          !bodySchema.oneOf;
        if (plain) {
          Object.assign(properties, bodySchema.properties as Record<string, Schema>);
          required.push(...((bodySchema.required ?? []) as string[]));
          inputSchema = { ...bodySchema, properties, required };
        } else {
          inputSchema = pathParams.length
            ? { allOf: [{ type: 'object', properties, required }, bodySchema] }
            : bodySchema;
        }
      } else {
        input = method === 'post' ? 'none' : 'query';
        for (const p of params) {
          if (p.in !== 'query') continue;
          properties[p.name] = p.schema ?? {};
          if (p.required) required.push(p.name);
        }
        inputSchema = { type: 'object', properties, required };
      }

      const ok = SUCCESS.map((c) => op.responses?.[c]).find(
        (r) => r?.content?.['application/json'],
      );
      ops.push({
        id,
        method: method.toUpperCase() as Op['method'],
        path,
        summary: op.summary ?? '',
        pathParams,
        input,
        contentTypes: raw ? mediaTypes : [],
        idempotent,
        inputSchema,
        resultSchema: ok?.content?.['application/json']?.schema ?? null,
      });
    }
  }
  const seen = new Set<string>();
  for (const o of ops) {
    if (seen.has(o.id)) throw new Error(`operationId ${o.id} is used twice`);
    seen.add(o.id);
  }
  return ops.sort((a, b) => a.id.localeCompare(b.id));
}

/** `{ items, next, param }` when the operation pages: a cursor in its input and one in its result. */
function pagination(o: Op, ctx: Ctx) {
  const props = (o.inputSchema.properties ?? {}) as Record<string, unknown>;
  const param = PAGE_PARAMS.find((p) => p in props);
  if (!param) return null;
  const result = resolve(o.resultSchema, ctx);
  const out = (result?.properties ?? {}) as Record<string, Schema>;
  const next = PAGE_NEXT.find((n) => n in out);
  if (!next) return null;
  const arrays = Object.entries(out).filter(([, v]) => v.type === 'array');
  if (arrays.length !== 1)
    throw new Error(`${o.id} pages, but its result has ${arrays.length} arrays: name its items`);
  return { param, items: arrays[0]?.[0] ?? '', next };
}

function resolve(s: Schema | null, ctx: Ctx): Schema | null {
  const name = typeof s?.$ref === 'string' && /^#\/components\/schemas\/(.+)$/.exec(s.$ref)?.[1];
  return name ? (ctx.components[name] ?? null) : s;
}

/** The generated module for `openapi`. */
export function emit(openapi: OpenApiLike): string {
  const ops = collect(openapi);
  const components = openapi.components?.schemas ?? {};
  const ctx: Ctx = { components, used: new Set(), defs: new Map() };
  const types: string[] = [];
  const names = new Map<string, string>();

  const declare = (name: string, body: string, summary?: string) => {
    if (names.has(name))
      throw new Error(`type name ${name} is declared twice (${names.get(name)})`);
    names.set(name, summary ?? name);
    types.push(`${doc(summary, '')}export type ${name} = ${body};\n`);
  };

  for (const o of ops) {
    const base = pascal(o.id);
    // A schema with `$defs` (the product body is recursive) names each def beside its input.
    const defs = (o.inputSchema.$defs ?? {}) as Record<string, Schema>;
    ctx.defs = new Map(
      Object.keys(defs).map((k) => [k, `${base}Input${pascal(k.replace(/^_+/, ''))}`]),
    );
    declare(`${base}Input`, emitType(o.inputSchema, ctx, ''), `${o.summary} (request)`.trim());
    for (const [k, def] of Object.entries(defs))
      declare(ctx.defs.get(k) ?? k, emitType(def, ctx, ''));
    ctx.defs = new Map();

    const result = o.resultSchema;
    const alias =
      typeof result?.$ref === 'string' && /^#\/components\/schemas\/(.+)$/.exec(result.$ref)?.[1];
    // A result that is exactly the component of its own name is that component, declared once.
    if (alias && alias === `${base}Result`) ctx.used.add(alias);
    else declare(`${base}Result`, result ? emitType(result, ctx, '') : 'unknown');
  }

  // Components reached from any schema, and those they reach in turn.
  const queue = [...ctx.used];
  const emitted = new Set<string>();
  while (queue.length) {
    const name = queue.shift() as string;
    if (emitted.has(name)) continue;
    emitted.add(name);
    const before = new Set(ctx.used);
    declare(name, emitType(components[name] as Schema, ctx, ''));
    for (const u of ctx.used) if (!before.has(u)) queue.push(u);
  }

  const table = ops.map((o) => {
    const p = o.pathParams.map((n) => JSON.stringify(n)).join(', ');
    const ct = o.contentTypes.length
      ? `, contentTypes: [${o.contentTypes.map((c) => JSON.stringify(c)).join(', ')}]`
      : '';
    return `  ${o.id}: { method: '${o.method}', path: '${o.path}', pathParams: [${p}], input: '${o.input}'${ct}${o.idempotent ? ', idempotent: true' : ''} },\n`;
  });
  const typeMap = ops.map((o) => {
    const base = pascal(o.id);
    return `${doc(o.summary, '  ')}  ${o.id}: { input: ${base}Input; result: ${base}Result };\n`;
  });
  const paged = ops.flatMap((o) => {
    const pg = pagination(o, ctx);
    return pg
      ? [`  ${o.id}: { param: '${pg.param}', items: '${pg.items}', next: '${pg.next}' },\n`]
      : [];
  });
  // A paging operation must name an items key that its result really has.
  for (const o of ops) {
    const pg = pagination(o, ctx);
    if (!pg) continue;
    const out = (resolve(o.resultSchema, ctx)?.properties ?? null) as Record<
      string,
      unknown
    > | null;
    if (out && !(pg.items in out)) throw new Error(`${o.id}: result has no ${pg.items}`);
  }

  return `// Generated by packages/sdk/commerce/scripts/generate.ts from the REST API's OpenAPI document.
// Do not edit by hand: run \`pnpm --filter @commerceworker/sdk-commerce generate:operations\`.

/** How to call one operation: its HTTP method and path, and where its input goes. */
export interface OperationSpec {
  readonly method: 'GET' | 'POST' | 'DELETE';
  /** Includes \`/api/v1\`; \`{name}\` placeholders are filled from the input. */
  readonly path: string;
  readonly pathParams: readonly string[];
  /**
   * \`query\`: the rest of the input is the query string; \`body\`: the JSON body; \`raw\`: the
   * input's \`body\` text is sent as it is, as its \`contentType\`, and the rest is the query
   * string; \`none\`: nothing.
   */
  readonly input: 'query' | 'body' | 'raw' | 'none';
  /** A \`raw\` body's media types, the first being the default. */
  readonly contentTypes?: readonly string[];
  /** The operation honors an \`Idempotency-Key\`. */
  readonly idempotent?: true;
}

export interface PaginationSpec {
  /** The input field that carries the cursor. */
  readonly param: string;
  /** The result field that holds a page's items. */
  readonly items: string;
  /** The result field that holds the next cursor (null or absent on the last page). */
  readonly next: string;
}

export const OPERATIONS = {
${table.join('')}} as const satisfies Record<string, OperationSpec>;

/** The operations that page by cursor. */
export const PAGINATION = {
${paged.join('')}} as const satisfies Record<string, PaginationSpec>;

${types.join('\n')}
export type OperationId = keyof typeof OPERATIONS;

/** Every operation's input and result. */
export interface OperationTypes {
${typeMap.join('')}}
`;
}
