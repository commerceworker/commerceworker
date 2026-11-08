import type { Principal } from '@commerceworker/domain';
import { type AuthInfo, createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { SkillCatalog } from '@modelcontextprotocol/server/ext/skills';
import type { McpDeps } from './deps';
import { buildServer } from './server';
import { loadSkillCatalog } from './skills';

/**
 * Upper bound on an MCP request body. The importers cap a payload at 20 MB;
 * this leaves room for that payload's JSON escaping inside a tools/call.
 */
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/** Carries a resolved principal to the server factory through the SDK's pass-through auth. */
export function authInfoFor(principal: Principal, token: string): AuthInfo {
  return { token, clientId: principal.kind, scopes: [...principal.scopes], extra: { principal } };
}

/**
 * The streamable-HTTP MCP endpoint behind the Worker's /mcp route (and the
 * in-process tests). It serves both protocol eras: 2026-07-28 clients send
 * one self-contained request per call, and 2025-era clients get the stateless
 * fallback. Either way each request gets a fresh server bound to the caller's
 * principal; the expensive parts (tool schemas, the skill catalog) are built
 * once per process and shared.
 *
 * Authentication happens before this handler: pass the result of
 * `authInfoFor` as `authInfo`, or the request is refused.
 *
 * The SDK answers internal failures with a bare 500, so `onerror` is the only
 * place they surface — wire it to the logger.
 */
export function createHandler(deps: McpDeps, onerror?: (error: Error) => void): McpHttpHandler {
  return createMcpHandler(
    async ({ authInfo }) => {
      const principal = authInfo?.extra?.principal as Principal | undefined;
      if (!principal) throw new Error('mcp: request reached the handler unauthenticated');
      return buildServer(deps, principal, await skillsOrNone(onerror));
    },
    { maxRequestBodySize: MAX_REQUEST_BODY_BYTES, onerror },
  );
}

/**
 * Skills are guidance, not capability: if the catalog fails to load, serve the
 * tools without it rather than failing every request. The load is retried on
 * the next request.
 */
async function skillsOrNone(onerror?: (error: Error) => void): Promise<SkillCatalog | undefined> {
  try {
    return await loadSkillCatalog();
  } catch (err) {
    onerror?.(err instanceof Error ? err : new Error(String(err)));
    return undefined;
  }
}
