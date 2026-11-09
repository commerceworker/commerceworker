import {
  approvePluginCapabilities,
  getPlugin,
  getPluginSettings,
  inspectPluginPackage,
  installPlugin,
  installPluginFromUrl,
  listPlugins,
  setPluginEnabled,
  setPluginSettings,
  uninstallPlugin,
  upgradePlugin,
  upgradePluginFromUrl,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as pluginDocs from '../../docs/schemas/plugins';
import {
  inspectPluginBody,
  installPluginBody,
  installPluginFromUrlBody,
  parseBody,
  pluginCapabilitiesBody,
  pluginEnabledBody,
  pluginSettingsBody,
  upgradePluginFromUrlBody,
} from '../../validation';
import { pluginSummary } from './shared';

export function pluginsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, blob } = deps;
  const app = new Hono<AuthVars>();

  // --- plugins (install, consent, lifecycle) -------------------------------
  // Gated on space:admin throughout: installing code that runs on the write
  // path is an administrative act, not an editorial one. The capability grant
  // is additionally intersected with the installer's own scopes.
  app.get('/spaces/:space/plugins', requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json({ items: (await listPlugins(ctx, c.req.param('space'))).map(pluginSummary) }),
  );
  app.get('/spaces/:space/plugins/:id', requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(pluginSummary(await getPlugin(ctx, c.req.param('space'), c.req.param('id')))),
  );
  app.post(
    '/spaces/:space/plugins',
    doc('Apps', 'Install a plugin', {
      body: installPluginBody,
      status: 201,
      description:
        'Installs DISABLED. `approvedCapabilities` is the human consent and may be narrower ' +
        'than the manifest requests, never wider; each capability is also checked against the ' +
        'installer’s own scopes.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, installPluginBody);
      const plugin = await installPlugin(ctx, blob, c.get('principal'), c.req.param('space'), {
        manifest: body.manifest as unknown as Parameters<typeof installPlugin>[4]['manifest'],
        bundle: body.bundle,
        approvedCapabilities: body.approvedCapabilities as never,
      });
      return c.json(pluginSummary(plugin), 201);
    },
  );
  app.put(
    '/spaces/:space/plugins/:id',
    doc('Apps', 'Upgrade a plugin', {
      body: installPluginBody,
      description:
        'A version requesting capabilities beyond the current grant requires ' +
        '`approvedCapabilities` and lands disabled, so an upgrade can never widen authority quietly.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, installPluginBody.partial({ approvedCapabilities: true }));
      const plugin = await upgradePlugin(ctx, blob, c.get('principal'), c.req.param('space'), {
        manifest: body.manifest as unknown as Parameters<typeof upgradePlugin>[4]['manifest'],
        bundle: body.bundle,
        approvedCapabilities: body.approvedCapabilities as never,
      });
      return c.json(pluginSummary(plugin));
    },
  );
  app.post(
    '/spaces/:space/plugins/from-url/inspect',
    doc('Apps', 'Inspect a plugin package without installing it', {
      body: inspectPluginBody,
      description:
        'Fetches and verifies a package exactly as install would, and returns what it found — ' +
        'so a consent screen can show the manifest before anything is approved. Install with ' +
        '`expectedChecksum` set to the checksum returned here, and a release swapped in ' +
        'between the two calls is refused rather than installed under the wrong approval.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, inspectPluginBody);
      return c.json(
        await inspectPluginPackage(
          ctx,
          deps.remoteFetcher,
          body as unknown as Parameters<typeof inspectPluginPackage>[2],
          deps.pluginSources ?? {},
        ),
      );
    },
  );
  app.post(
    '/spaces/:space/plugins/from-url',
    doc('Apps', 'Install a plugin from a URL', {
      body: installPluginFromUrlBody,
      status: 201,
      description:
        'Fetches a package descriptor over HTTPS, verifies the bundle against the SHA-256 it ' +
        'declares, and installs it DISABLED. `expectedChecksum` pins the release, so bytes ' +
        'that changed since the approval are refused rather than installed.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, installPluginFromUrlBody);
      const plugin = await installPluginFromUrl(
        ctx,
        blob,
        deps.remoteFetcher,
        c.get('principal'),
        c.req.param('space'),
        body as unknown as Parameters<typeof installPluginFromUrl>[5],
        deps.pluginSources ?? {},
      );
      return c.json(pluginSummary(plugin), 201);
    },
  );
  app.put(
    '/spaces/:space/plugins/:id/from-url',
    doc('Apps', 'Upgrade a plugin from a URL', {
      body: upgradePluginFromUrlBody,
      description:
        'Same verification as install. A version requesting more than the current grant needs ' +
        '`approvedCapabilities` and lands disabled.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, upgradePluginFromUrlBody);
      const plugin = await upgradePluginFromUrl(
        ctx,
        blob,
        deps.remoteFetcher,
        c.get('principal'),
        c.req.param('space'),
        { ...body, expectedId: body.expectedId ?? c.req.param('id') } as unknown as Parameters<
          typeof upgradePluginFromUrl
        >[5],
        deps.pluginSources ?? {},
      );
      return c.json(pluginSummary(plugin));
    },
  );
  app.post(
    '/spaces/:space/plugins/:id/capabilities',
    doc('Apps', 'Approve a plugin’s capabilities', {
      body: pluginCapabilitiesBody,
      description:
        'Records a fresh capability decision without changing the code: re-approves a plugin ' +
        'flagged `needsReapproval`, narrows a grant, or grants something the manifest requested ' +
        'that was declined earlier. Never wider than the manifest or the approver’s own scopes; ' +
        'a grant that grows disables the plugin until it is re-enabled.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, pluginCapabilitiesBody);
      return c.json(
        pluginSummary(
          await approvePluginCapabilities(
            ctx,
            c.get('principal'),
            c.req.param('space'),
            c.req.param('id'),
            body.approvedCapabilities as never,
          ),
        ),
      );
    },
  );
  app.post('/spaces/:space/plugins/:id/enabled', requireScope(SCOPES.spaceAdmin), async (c) => {
    const body = await parseBody(c, pluginEnabledBody);
    return c.json(
      pluginSummary(
        await setPluginEnabled(ctx, c.req.param('space'), c.req.param('id'), body.enabled),
      ),
    );
  });
  app.get(
    '/spaces/:space/plugins/:id/settings',
    doc('Apps', 'Read a plugin’s settings', {
      ok: pluginDocs.pluginSettingsView,
      description:
        'The fields the manifest declares, the non-secret values (defaults applied) and ' +
        '`secretsSet`, the secret fields that hold a value. A secret’s value is never returned.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => c.json(await getPluginSettings(ctx, c.req.param('space'), c.req.param('id'))),
  );
  app.patch(
    '/spaces/:space/plugins/:id/settings',
    doc('Apps', 'Change a plugin’s settings', {
      body: pluginSettingsBody,
      ok: pluginDocs.pluginSettingsView,
      description:
        'Sets each key in `values` (null clears it); keys left out keep their value, so a ' +
        'secret need not be retyped. Checked against the manifest’s fields; secret values are ' +
        'sealed at rest and never echoed. Pass the `version` you read as `expectedVersion` and ' +
        'a concurrent change is refused (409) instead of overwritten. A refused value is a 422 whose ' +
        '`issues[].field` names the setting (`apiKey`, or `values.apiKey` from body parsing).',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, pluginSettingsBody);
      return c.json(
        await setPluginSettings(ctx, c.get('principal'), c.req.param('space'), c.req.param('id'), {
          values: body.values,
          ...(body.expectedVersion !== undefined ? { expectedVersion: body.expectedVersion } : {}),
        }),
      );
    },
  );
  app.delete('/spaces/:space/plugins/:id', requireScope(SCOPES.spaceAdmin), async (c) => {
    await uninstallPlugin(ctx, blob, c.req.param('space'), c.req.param('id'));
    return c.body(null, 204);
  });

  return app;
}
