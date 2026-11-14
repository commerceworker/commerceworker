import { env } from 'cloudflare:workers';
import type { Principal } from '@commerceworker/core/roles';
import { deriveAssistantPrincipalKey } from '@commerceworker/security/assistant-key';
import { crossOrigin } from '@commerceworker/security/origin';
import {
  PRINCIPAL_HEADER,
  principalTarget,
  signPrincipal,
} from '@commerceworker/security/principal';
import { principal, sessionId, setupDue } from './auth.server';
import { contentOAuthResponse } from './content-oauth';
import { principalKey } from './principal.server';
import { contentAuthStore } from './wire.server';

export type ContentBindings = { CONTENT_API?: Fetcher; CONTENT_DB?: D1Database };
export const contentEnabled = () => Boolean((env as ContentBindings).CONTENT_API);

/** Reuse a legacy subject only after explicit linking. Emails never establish identity ownership. */
export async function contentPerson(person: Principal) {
  const store = contentAuthStore();
  const subject = person.kind === 'open' ? 'local' : `commerce:${person.id}`;
  const existing = store ? await store.userByCommerceSubject(subject) : undefined;
  if (existing?.disabledAt) return null;
  return {
    id: existing?.id ?? subject,
    name: person.name,
    email: person.email ?? '',
    role: person.role === 'admin' ? ('admin' as const) : ('member' as const),
  };
}

/** The content API has its own namespace; its OAuth issuer stays on the legacy host. */
export function contentApiPath(path: string): string | null {
  if (path.startsWith('/content-api/')) {
    const target = path.slice('/content-api'.length);
    return /^\/(spaces|starters|preview|delivery|media|auth|agents|oauth)(\/|$)/.test(target)
      ? target
      : null;
  }
  // Signed media links name this path. Their signatures cover it, so preserve it verbatim.
  return path.startsWith('/media/') ? path : null;
}

export async function forwardContent(request: Request): Promise<Response> {
  const api = (env as ContentBindings).CONTENT_API;
  const url = new URL(request.url);
  const path = contentApiPath(url.pathname);
  if (!api || !path) return new Response('Not found', { status: 404 });
  if (crossOrigin(request, url.origin))
    return Response.json({ error: 'Cross-site request refused' }, { status: 403 });
  const caller = await principal(request);
  if (!caller) {
    if (request.method === 'GET' && /^\/oauth\/(authorize|device)$/.test(path))
      return Response.redirect(
        new URL(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, url).href,
        302,
      );
    return new Response('Unauthorized', { status: 401 });
  }
  const due = setupDue(caller);
  if (due) return Response.json({ error: due }, { status: 403 });
  const person = await contentPerson(caller);
  if (!person) return new Response('Content access is disabled', { status: 403 });
  const headers = new Headers(request.headers);
  headers.delete('cookie');
  headers.delete('authorization');
  headers.delete(PRINCIPAL_HEADER);
  for (const name of [...headers.keys()])
    if (name.startsWith('x-agents-') || name.startsWith('x-partykit-')) headers.delete(name);
  const sid = caller.kind === 'user' ? await sessionId(request) : undefined;
  const key = path.startsWith('/agents/')
    ? await deriveAssistantPrincipalKey(principalKey())
    : principalKey();
  headers.set(
    PRINCIPAL_HEADER,
    await signPrincipal(
      key,
      {
        sub: person.id,
        email: person.email,
        name: person.name,
        role: person.role,
        ...(sid ? { sid } : {}),
      },
      principalTarget(request.method, path),
    ),
  );
  url.pathname = path;
  const response = await api.fetch(new Request(url, new Request(request, { headers })));
  if (!path.startsWith('/oauth/')) return response;
  return contentOAuthResponse(response);
}
