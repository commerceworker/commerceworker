import {
  createApiKey,
  createPersonalAccessToken,
  listApiKeys,
  listPersonalAccessTokens,
  revokeApiKey,
} from '@commerceworker/application';
import { ForbiddenError, SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as authDocs from '../../docs/schemas/auth';
import { createApiKeyBody, createPatBody, parseBody } from '../../validation';
import { apiKeySummary } from './shared';

export function apiKeysRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, hasher } = deps;
  const app = new Hono<AuthVars>();

  // --- API key management (admin) ----------------------------------------
  app.get(
    '/spaces/:space/api-keys',
    doc('Auth', 'List API keys for a space'),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const keys = await listApiKeys(ctx, c.req.param('space'));
      return c.json({ items: keys.map(apiKeySummary) });
    },
  );
  app.post(
    '/spaces/:space/api-keys',
    doc('Auth', 'Mint an API key', {
      body: createApiKeyBody,
      ok: authDocs.apiKeyCreated,
      status: 201,
      description:
        'The raw token is returned once; only its SHA-256 hash is stored. 403 to a personal ' +
        'access token or an OAuth token: a delegated bearer never mints a key that outlives it.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, createApiKeyBody);
      // spaceId is taken ONLY from the authorized route param, so a caller-supplied
      // `spaceId` can never rebind the key to another space (the schema strips
      // unknown keys, so it never reaches here regardless).
      const created = await createApiKey(ctx, hasher, {
        spaceId: c.req.param('space'),
        kind: body.kind,
        name: body.name,
        scopes: body.scopes,
        roleId: body.roleId,
        issuer: c.get('principal'),
      });
      // Return the raw token once; only its hash is stored.
      return c.json(
        { id: created.apiKey.id, kind: created.apiKey.kind, token: created.token },
        201,
      );
    },
  );
  app.delete('/spaces/:space/api-keys/:id', requireScope(SCOPES.spaceAdmin), async (c) => {
    await revokeApiKey(ctx, c.req.param('space'), c.req.param('id'), deps.accessPolicy);
    return c.body(null, 204);
  });

  /**
   * Mints a personal access token for the caller — the non-interactive
   * counterpart to an OAuth grant, for CLI and CI clients that cannot run a
   * browser flow. It lists and revokes through the API-key routes above.
   *
   * Deliberately NOT exposed as an MCP tool, and refused to delegated bearers
   * (an OAuth or personal access token): a token that expires in an hour must
   * not be able to mint itself a credential that never expires. PATs are issued by a human at a
   * keyboard, or by an operator key.
   */
  app.post(
    '/spaces/:space/personal-access-tokens',
    doc('Auth', 'Mint a personal access token', {
      body: createPatBody,
      ok: authDocs.apiKeyCreated,
      status: 201,
      description: 'Scopes are intersected with the caller’s own. The raw token is returned once.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const principal = c.get('principal');
      // Minted by a person for themselves (it acts as them, checked against their membership on
      // every use), never by a key. A token a person handed out (OAuth, or another PAT) is
      // refused in the use-case.
      if (principal.kind !== 'user' || !principal.subject) {
        throw new ForbiddenError('personal-access-token:create');
      }
      const body = await parseBody(c, createPatBody);
      const created = await createPersonalAccessToken(ctx, hasher, {
        spaceId: c.req.param('space'),
        subject: principal.subject,
        name: body.name,
        scopes: body.scopes,
        expiresInDays: body.expiresInDays,
        issuerScopes: principal.scopes,
        issuer: principal,
      });
      return c.json({ id: created.id, token: created.token, expiresAt: created.expiresAt }, 201);
    },
  );
  app.get(
    '/spaces/:space/personal-access-tokens',
    doc('Auth', 'List personal access tokens'),
    requireScope(SCOPES.spaceAdmin),
    async (c) => c.json({ items: await listPersonalAccessTokens(ctx, c.req.param('space')) }),
  );

  return app;
}
