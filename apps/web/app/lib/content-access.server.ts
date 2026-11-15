import { env } from 'cloudflare:workers';
import {
  PRINCIPAL_HEADER,
  principalTarget,
  signPrincipal,
} from '@commerceworker/security/principal';
import { principalKey } from './principal.server';
import { contentAuthStore } from './wire.server';

/** End delegated content credentials along with commerce access, including a migrated identity. */
export async function revokeContentAccess(
  userId: string,
): Promise<{ apps: number; tokens: number }> {
  const api = (env as { CONTENT_API?: Fetcher }).CONTENT_API;
  const ended = { apps: 0, tokens: 0 };
  if (!api) return ended;
  const subject = `commerce:${userId}`;
  const legacy = await contentAuthStore()?.userByCommerceSubject(subject);
  for (const id of new Set([subject, ...(legacy ? [legacy.id] : [])])) {
    const path = `/deployment/people/${encodeURIComponent(id)}/credentials`;
    const headers = new Headers({
      [PRINCIPAL_HEADER]: await signPrincipal(
        principalKey(),
        {
          sub: 'system:commerce',
          email: '',
          name: 'CommerceWorker admin',
          role: 'admin',
        },
        principalTarget('DELETE', path),
      ),
    });
    const response = await api.fetch(`https://api${path}`, { method: 'DELETE', headers });
    if (!response.ok)
      throw new Error(
        `Content credential revocation failed (${response.status}). Retry this action.`,
      );
    const body = (await response.json()) as { revokedTokens: number; revokedGrants: number };
    ended.tokens += body.revokedTokens;
    ended.apps += body.revokedGrants;
  }
  return ended;
}
