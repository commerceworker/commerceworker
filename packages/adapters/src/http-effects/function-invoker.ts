import type { DomainEvent } from '@commerceworker/domain';
import type { FunctionInvoker } from '@commerceworker/ports';

/**
 * HTTP function invoker. POSTs the triggering event as JSON to the function's
 * URL; network/HTTP errors surface as `ok: false` (logged, never fatal).
 */
export function createHttpFunctionInvoker(
  fetchImpl: typeof fetch = fetch,
  opts: { timeoutMs?: number } = {},
): FunctionInvoker {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    async invoke(url: string, event: DomainEvent) {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-commerceworker-event': event.type },
          body: JSON.stringify(event),
          // Never follow redirects — a 3xx to an internal host would be an SSRF.
          redirect: 'manual',
          // Bound a hung function endpoint the same way as a webhook receiver.
          signal: AbortSignal.timeout(timeoutMs),
        });
        return { ok: res.ok, statusCode: res.status };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
