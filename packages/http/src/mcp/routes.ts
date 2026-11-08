import { structuredImportSources } from '@commerceworker/adapters/import-structured';
import { authenticate, secureTokenEqual } from '@commerceworker/application';
import {
  bearerChallenge,
  type Principal,
  protectedResourceMetadata,
  resourceMetadataPaths,
  resourceMetadataUrl,
  scopesForKind,
} from '@commerceworker/domain';
import { preloadSchemas } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import type { McpDeps } from './deps';
import { authInfoFor, createHandler } from './http';

// Module scope runs during isolate warm-up, which is not billed per request;
// left lazy, building the SDK's wire schemas would land on the first MCP
// request of every fresh isolate.
preloadSchemas();

const ADMIN: Principal = { spaceId: '*', kind: 'admin', scopes: [...scopesForKind('cma')] };

/**
 * Stateless streamable-HTTP MCP endpoint at /mcp. Auth is the MCP root token,
 * a hashed API key, or an OAuth access token; the request is then served by
 * the shared handler in ./http.ts (tools in ./server.ts, skills in ./skills.ts).
 */
export function mcpRoutes(given: McpDeps, oauth?: { issuer: string; resource: string }): Hono {
  // The structured import parsers (JSON, CSV, WXR) are pure and need no configuration, so MCP
  // gets them by default exactly as the HTTP API does (createApp). Left to each caller, the api
  // Worker's wiring omitted them and `import_*` answered "no import sources" in production.
  const deps: McpDeps = given.importSources
    ? given
    : { ...given, importSources: structuredImportSources() };
  const app = new Hono();

  // RFC 9728: an MCP client that finds the resource before the authorization
  // server discovers where to authenticate from here. Both the path-suffixed
  // URL the RFC specifies and the bare well-known path are served, because
  // clients in the wild probe either.
  if (oauth) {
    for (const path of resourceMetadataPaths(oauth.resource)) {
      app.get(path, (c) => c.json(protectedResourceMetadata(oauth.resource, oauth.issuer)));
    }
  }

  app.all('/mcp', async (c) => {
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const principal = await resolvePrincipal(deps, token);
    if (!principal) {
      // Point the client at the metadata document so it can start the OAuth
      // flow itself rather than failing with an opaque 401.
      if (oauth) {
        c.header(
          'WWW-Authenticate',
          bearerChallenge(
            resourceMetadataUrl(oauth.resource),
            token ? 'The access token is invalid or expired' : undefined,
          ),
        );
      }
      return c.json({ error: 'invalid or missing bearer token' }, 401);
    }

    // Built here rather than in mcpRoutes: wiring is per request on the edge,
    // and this keeps non-MCP requests from paying for a handler they never use.
    return createHandler(deps, (err) => console.error('mcp: request failed', err)).fetch(
      c.req.raw,
      {
        authInfo: authInfoFor(principal, token),
      },
    );
  });
  return app;
}

async function resolvePrincipal(deps: McpDeps, token: string): Promise<Principal | null> {
  if (!token) return null;
  if (deps.adminToken && secureTokenEqual(token, deps.adminToken)) return ADMIN;
  try {
    return await authenticate(deps.ctx, deps.hasher, token);
  } catch {
    return null;
  }
}
