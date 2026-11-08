import type { RemoteDocument, RemoteFetcher, RemoteFile } from '@commerceworker/ports';

/**
 * HTTP fetcher for operator-initiated downloads (plugin packages, oEmbed metadata, the files a
 * space export import copies).
 *
 * Three properties matter more than throughput here, because what comes back
 * is code someone is about to run:
 *
 * - **No redirects.** The caller screened the URL it asked for; a 3xx would
 *   move the request to a host nothing screened.
 * - **Bounded body.** Read incrementally and abandoned the moment it exceeds
 *   the cap, so a hostile origin cannot stream until memory runs out.
 * - **Bounded time.** A slow-loris origin holds a request, not the process.
 */
export function createRemoteFetcher(
  fetchImpl: typeof fetch = fetch,
  opts: { timeoutMs?: number } = {},
): RemoteFetcher {
  const defaultTimeout = opts.timeoutMs ?? 15_000;
  const request = async (
    url: string,
    options: { readonly maxBytes: number; readonly timeoutMs?: number },
  ): Promise<RemoteFile> => {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: '*/*' },
      signal: AbortSignal.timeout(options.timeoutMs ?? defaultTimeout),
    });
    const contentType = res.headers.get('content-type') ?? undefined;
    if (!res.ok) {
      return {
        status: res.status,
        ...(contentType ? { contentType } : {}),
        bytes: new Uint8Array(),
      };
    }

    // Content-Length is a claim, not a fact; enforce the cap on what actually
    // arrives. Checked first anyway, so an honest oversized response is
    // rejected without transferring it.
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      throw new Error(`Response declares ${declared} bytes, over the ${options.maxBytes} limit`);
    }

    const bytes = await readBounded(res, options.maxBytes);
    return { status: res.status, ...(contentType ? { contentType } : {}), bytes };
  };
  return {
    async get(url, options): Promise<RemoteDocument> {
      const { bytes, ...rest } = await request(url, options);
      return { ...rest, body: new TextDecoder().decode(bytes) };
    },
    getBytes: request,
  };
}

async function readBounded(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) {
    const whole = new Uint8Array(await res.arrayBuffer());
    if (whole.byteLength > maxBytes) throw new Error(`Response exceeds the ${maxBytes} byte limit`);
    return whole;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeds the ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return joined;
}
