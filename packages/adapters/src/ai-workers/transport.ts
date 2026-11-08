/**
 * How the adapter reaches Workers AI: an injected `run(model, input, opts)`.
 * The edge passes the `AI` binding's own method (`env.AI.run.bind(env.AI)`);
 * tests pass a fake. The package imports no Cloudflare types — `run` is all it
 * knows about the transport.
 */

/** Options the adapter passes to `run`: the AI Gateway route, when configured. */
export interface WorkersAiRunOptions {
  gateway?: { id: string };
  extraHeaders?: Record<string, string>;
}

/** The Workers AI call. Resolves with the model's raw output object. */
export type WorkersAiRun = (
  model: string,
  input: Record<string, unknown>,
  opts?: WorkersAiRunOptions,
) => Promise<unknown>;

/**
 * Hard ceiling on one call. Callers that need a tighter bound (the 20 s
 * `AI_TIMEOUT_MS` in `generateJson`) apply it themselves; this one only makes
 * sure nothing waits forever, and leaves room for long calls such as the
 * copilot's 120 s.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Sent on every gateway call: with request logs on, the gateway keeps the
 * model, tokens and cost, but never the prompt or answer — those carry customer
 * content that the platform's retention cannot erase from the gateway.
 */
export const NO_LOG_PAYLOAD = { 'cf-aig-collect-log-payload': 'false' } as const;

/** Why a Workers AI call failed. Thrown as {@link WorkersAIError}. */
export type WorkersAIErrorReason =
  /** The adapter was built without what it needs (e.g. a known embedding width). */
  | 'config'
  /** The call exceeded its cap and was abandoned. */
  | 'timeout'
  /** Workers AI / the gateway / the network returned an error. */
  | 'upstream'
  /** A response arrived but was unusable (wrong shape, cut off at max_tokens). */
  | 'bad_response';

export class WorkersAIError extends Error {
  override readonly name = 'WorkersAIError';
  constructor(
    readonly reason: WorkersAIErrorReason,
    message: string,
    /** HTTP-like status, when the failure carried one. */
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Rejects with a `timeout` error after `ms` (aborting `controller`) unless `p` settles first. */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  controller?: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new WorkersAIError('timeout', `Workers AI call timed out after ${ms}ms`));
      }, ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Normalizes anything a `run` throws into a {@link WorkersAIError}. */
export function asWorkersAIError(err: unknown): WorkersAIError {
  if (err instanceof WorkersAIError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new WorkersAIError('upstream', `Workers AI call failed: ${message}`);
}

/** Run options routing a call through AI Gateway, or none to call Workers AI directly. */
export function gatewayRunOptions(
  gatewayId: string | undefined,
  collectLogs: boolean | undefined,
): WorkersAiRunOptions | undefined {
  if (!gatewayId) return undefined;
  return {
    gateway: { id: gatewayId },
    extraHeaders: {
      ...NO_LOG_PAYLOAD,
      ...(collectLogs === undefined ? {} : { 'cf-aig-collect-log': String(collectLogs) }),
    },
  };
}
