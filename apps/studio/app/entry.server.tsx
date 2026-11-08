import { isbot } from 'isbot';
import { renderToReadableStream } from 'react-dom/server';
import type { EntryContext, RouterContextProvider } from 'react-router';
import { ServerRouter } from 'react-router';
import {
  contentSecurityPolicy,
  EMBED_HEADER,
  FRAME_HEADER,
  NonceContext,
  newNonce,
  parseEmbed,
  parseFrames,
} from './lib/csp';

export const streamTimeout = 5_000;

/** React Router's default web entry, plus a per-response CSP nonce for every inline script. */
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: RouterContextProvider,
) {
  // What a route says about its policy (lib/csp.ts) goes into the CSP, never out: a HEAD answer
  // drops it too. An embeddable page names who frames it and where its form posts.
  const embed = parseEmbed(responseHeaders.get(EMBED_HEADER));
  responseHeaders.delete(EMBED_HEADER);
  // A page that frames a customer's frontend (a live preview) names its origins the same way.
  const frames = parseFrames(responseHeaders.get(FRAME_HEADER));
  responseHeaders.delete(FRAME_HEADER);
  if (request.method.toUpperCase() === 'HEAD') {
    return new Response(null, { status: responseStatusCode, headers: responseHeaders });
  }

  const nonce = newNonce();
  let shellRendered = false;
  const userAgent = request.headers.get('user-agent');

  const body = await renderToReadableStream(
    <NonceContext.Provider value={nonce}>
      <ServerRouter context={routerContext} url={request.url} nonce={nonce} />
    </NonceContext.Provider>,
    {
      nonce,
      signal: AbortSignal.timeout(streamTimeout + 1000),
      onError(error: unknown) {
        responseStatusCode = 500;
        // Errors before the shell rendered reject and are logged by handleDocumentRequest.
        if (shellRendered) console.error(error);
      },
    },
  );
  shellRendered = true;

  // Bots and SPA mode get the whole document at once.
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) await body.allReady;

  responseHeaders.set('Content-Type', 'text/html');
  // The route's embed and frame policies were read off its headers at the top.
  // Vite's dev server injects its own inline scripts, which carry no nonce.
  if (!import.meta.env.DEV)
    responseHeaders.set('Content-Security-Policy', contentSecurityPolicy(nonce, embed, frames));
  return new Response(body, { headers: responseHeaders, status: responseStatusCode });
}
