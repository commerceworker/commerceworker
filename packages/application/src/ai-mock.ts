import type {
  DecisionAnswer,
  DecisionRequest,
  DecisionResult,
  GenerateRequest,
  GenerateResult,
} from '@commerceworker/ports';

interface JsonSchema {
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly items?: JsonSchema;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
}

/** A placeholder value of `schema`'s shape, so the caller's parsing runs as it would live. */
function sample(schema: JsonSchema | undefined, name: string, depth = 0): unknown {
  if (!schema || depth > 6) return `Sample ${name}`;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  const variant = schema.anyOf?.[0] ?? schema.oneOf?.[0];
  if (variant) return sample(variant, name, depth + 1);
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, def] of Object.entries(schema.properties ?? {})) {
        out[key] = sample(def, key, depth + 1);
      }
      return out;
    }
    case 'array':
      return [sample(schema.items, name, depth + 1)];
    case 'integer':
    case 'number':
      // Inside the schema's range, as a model told the range would answer.
      return Math.min(Math.max(0, schema.minimum ?? 0), schema.maximum ?? Number.POSITIVE_INFINITY);
    case 'boolean':
      return false;
    default:
      if (/ISO-8601|date/i.test(schema.description ?? '')) return '2024-01-01';
      return fitLength(`Sample ${schema.description ?? name}`, schema);
  }
}

/** `text` padded or cut to the schema's length bounds. */
function fitLength(text: string, schema: JsonSchema): string {
  const padded = text.padEnd(schema.minLength ?? 0, '.');
  return schema.maxLength !== undefined ? padded.slice(0, schema.maxLength) : padded;
}

/**
 * What AI_MODE=mock answers instead of calling a model: a placeholder shaped by the request's
 * output schema (or a line of text when it has none), with no token usage. Every generation goes
 * through `generateWithBudget`, so mock mode holds for all of them, and local development never
 * spends model calls.
 */
export function mockGenerate(req: GenerateRequest): GenerateResult {
  if (!req.outputSchema) {
    return { text: 'Sample response (AI_MODE=mock).', usage: { inputTokens: 0, outputTokens: 0 } };
  }
  const object = sample({ type: 'object', ...(req.outputSchema as JsonSchema) }, 'value');
  return { text: JSON.stringify(object), object, usage: { inputTokens: 0, outputTokens: 0 } };
}

/**
 * A decision without a model (AI_MODE=mock): deterministic, from the state's text. A `choice`
 * picks the option whose id or description appears in the state, else the first; a `noul` is a
 * confident no; a `score` is the lowest level. Enough to drive every caller's code path.
 */
export function mockDecide(req: DecisionRequest): DecisionResult {
  const text = (
    typeof req.state === 'string' ? req.state : JSON.stringify(req.state)
  ).toLowerCase();
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, q] of Object.entries(req.questions)) {
    if (q.type === 'noul') {
      answers[id] = { type: 'noul', probability: 0.1 };
    } else if (q.type === 'choice') {
      const options = Object.keys(q.options);
      const hit =
        options.find(
          (o) =>
            text.includes(o.replace(/_/g, ' ').toLowerCase()) ||
            text.includes((q.options[o] ?? '').toLowerCase()),
        ) ?? (options[0] as string);
      const probabilities = Object.fromEntries(
        options.map((o) => [o, o === hit ? 0.8 : 0.2 / Math.max(1, options.length - 1)]),
      );
      answers[id] = { type: 'choice', choice: hit, confidence: 0.8, probabilities };
    } else {
      answers[id] = {
        type: 'score',
        score: 0,
        probabilities: q.levels.map((_, i) => (i === 0 ? 1 : 0)),
      };
    }
  }
  return { answers, model: 'mock', usage: { inputTokens: 0 } };
}
