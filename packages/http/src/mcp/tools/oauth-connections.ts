import { listConnectedApps, revokeConnectedApp } from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, scopeArgs, type ToolContext, toolSchema } from './shared';

export function registerOAuthConnectionTools(server: McpServer, t: ToolContext): void {
  const { scopeOf } = t;
  const { ctx, guard } = t;
  // --- connected OAuth applications --------------------------------------
  // Minting a personal access token is deliberately absent here: a delegated
  // token that expires in an hour must not be able to issue itself one that
  // never does. That stays an HTTP-only, human-initiated action.
  server.registerTool(
    'oauth_connections_list',
    {
      description:
        'List the applications currently holding OAuth access to a space, with the ' +
        'person who approved each and the scopes it was granted.',
      inputSchema: toolSchema('oauth_connections_list', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await listConnectedApps(ctx, scopeOf(args).spaceId));
    },
  );

  server.registerTool(
    'oauth_connection_revoke',
    {
      description:
        'Disconnect an application: revokes every access token it holds for that ' +
        'person and the grants behind them, so it cannot refresh back in.',
      inputSchema: toolSchema('oauth_connection_revoke', () =>
        z.object({
          clientId: z.string(),
          subject: z.string().describe('the identity that approved the connection'),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await revokeConnectedApp(ctx, scopeOf(args).spaceId, args.clientId, args.subject));
    },
  );
}
