import {
  approvePluginCapabilities,
  getPluginSettings,
  listPlugins,
  setPluginEnabled,
  setPluginSettings,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerPluginTools(server: McpServer, t: ToolContext): void {
  const { ctx, principal, guard } = t;
  // --- plugins -------------------------------------------------------------
  // Read and lifecycle only. Installing is deliberately absent: uploading code
  // that runs on the write path is a human act behind a consent screen, not
  // something an agent should be able to do on its own authority.
  server.registerTool(
    'plugins_list',
    {
      description:
        'List the plugins installed in a space, with the capabilities each was ' +
        'granted and whether it is enabled.',
      inputSchema: toolSchema('plugins_list', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await listPlugins(ctx, scopeOf(args).spaceId));
    },
  );

  // No install-from-URL tool, deliberately. Installing a plugin introduces new
  // executable code and turns on a consent screen a human is meant to read;
  // an agent that could do it could grant itself capabilities its own
  // principal was never given. Listing and toggling what a human already
  // approved is the line.
  server.registerTool(
    'plugin_set_enabled',
    {
      description: 'Turn an installed plugin on or off. Does not change what it was granted.',
      inputSchema: toolSchema('plugin_set_enabled', () =>
        z.object({ id: z.string(), enabled: z.boolean(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await setPluginEnabled(ctx, scopeOf(args).spaceId, args.id, args.enabled));
    },
  );

  // The same capability-approval use-case as the admin's approve step, in
  // narrow-only mode: an agent may confirm what a human granted (clearing a
  // legacy plugin's re-approval flag) or reduce it, never widen it — granting
  // authority to code stays a human decision on the consent screen.
  server.registerTool(
    'plugin_approve_capabilities',
    {
      description:
        'Confirm or narrow the capabilities an installed plugin is granted. Can re-approve a ' +
        'plugin flagged needsReapproval or drop capabilities; cannot grant anything beyond the ' +
        'current grant (that needs a human in the admin).',
      inputSchema: toolSchema('plugin_approve_capabilities', () =>
        z.object({
          id: z.string(),
          approvedCapabilities: z.array(z.string()).max(32),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(
        await approvePluginCapabilities(
          ctx,
          principal,
          scopeOf(args).spaceId,
          args.id,
          args.approvedCapabilities as never,
          { narrowOnly: true },
        ),
      );
    },
  );

  // Settings are configuration an operator fills in, not authority: the same
  // use-cases as the admin's settings form, and a secret is reported as set,
  // never read back.
  server.registerTool(
    'plugin_get_settings',
    {
      description:
        'Read an installed plugin’s settings: the fields its manifest declares, the non-secret ' +
        'values, and which secret fields are set (secret values are never returned).',
      inputSchema: toolSchema('plugin_get_settings', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await getPluginSettings(ctx, scopeOf(args).spaceId, args.id));
    },
  );

  server.registerTool(
    'plugin_set_settings',
    {
      description:
        'Change an installed plugin’s settings. `values` maps a setting key to its new value, ' +
        'or null to clear it; keys left out keep their value. Values are checked against the ' +
        'manifest’s fields. Pass `expectedVersion` (from plugin_get_settings) to refuse a ' +
        'concurrent change instead of overwriting it.',
      inputSchema: toolSchema('plugin_set_settings', () =>
        z.object({
          id: z.string(),
          values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
          expectedVersion: z.number().int().min(0).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(
        await setPluginSettings(ctx, principal, scopeOf(args).spaceId, args.id, {
          values: args.values,
          ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}),
        }),
      );
    },
  );
}
