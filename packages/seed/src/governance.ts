import {
  createEnvironment,
  createHasher,
  createRole,
  listAuditLog,
  listEnvironmentAliases,
  listEnvironments,
  listRoles,
  setEnvironmentAlias,
} from '@commerceworker/application';
import { backdated, pick } from './helpers';
import type { SeedConfig, SeedRun } from './types';

/**
 * Governance surfaces: custom roles, a role-bound API key, a second
 * environment with a blue/green alias, and a backdated audit trail. The audit
 * entries exist because use-case seeding bypasses the route middleware that
 * normally records them — without these the audit UI is empty on a fresh stack.
 */
export async function seedGovernance(run: SeedRun, config: SeedConfig): Promise<void> {
  const { ctx, scope } = run;
  const spaceId = scope.spaceId;

  const roles = await listRoles(ctx, spaceId);
  let editorRoleId = roles.find((r) => r.name === 'Editor')?.id;
  if (!editorRoleId) {
    const editor = await createRole(ctx, spaceId, {
      name: 'Editor',
      description: 'Writes and previews articles; cannot publish.',
      scopes: ['content:write', 'preview:read', 'search:read'],
      contentGrants: [
        { contentTypeApiId: 'article', actions: ['read', 'write'] },
        { contentTypeApiId: 'page', actions: ['read', 'write'], readOnlyFields: ['slug'] },
      ],
    });
    editorRoleId = editor.id;
  }
  if (!roles.some((r) => r.name === 'Publisher')) {
    await createRole(ctx, spaceId, {
      name: 'Publisher',
      description: 'Publishes reviewed content across all types.',
      scopes: ['content:publish', 'delivery:read', 'preview:read'],
    });
  }
  if (!roles.some((r) => r.name === 'Translator')) {
    await createRole(ctx, spaceId, {
      name: 'Translator',
      description: 'Edits localized fields only; structural fields are off-limits.',
      scopes: ['content:write', 'preview:read'],
      contentGrants: [
        {
          contentTypeApiId: '*',
          actions: ['read', 'write'],
          readOnlyFields: ['slug', 'author', 'category'],
          deniedFields: ['views'],
        },
      ],
    });
  }

  // A CMA key bound to the Editor role: exercises granular-RBAC resolution.
  const hasher = createHasher(config.tokenPepper);
  const editorToken = 'dev-editor-key';
  const hashedToken = hasher.hash(editorToken);
  if (!(await ctx.store.auth.findByHash(hashedToken))) {
    await ctx.store.auth.createApiKey({
      id: ctx.ids.newId(),
      spaceId,
      kind: 'cma',
      name: 'dev-editor',
      hashedToken,
      scopes: [],
      roleId: editorRoleId,
      revoked: false,
    });
  }

  const envs = await listEnvironments(ctx, spaceId);
  // The in-memory store's seedSpace() registers locale config but not the
  // environment row itself, so ensure the default environment exists before
  // pointing an alias at it (aliases validate their target).
  if (!envs.some((e) => e.id === config.environmentId)) {
    await createEnvironment(ctx, spaceId, config.environmentId);
  }
  if (!envs.some((e) => e.id === 'staging')) {
    await createEnvironment(ctx, spaceId, 'staging');
  }
  const aliases = await listEnvironmentAliases(ctx, spaceId);
  if (!aliases.some((a) => a.alias === 'live')) {
    await setEnvironmentAlias(ctx, spaceId, 'live', config.environmentId);
  }

  if ((await listAuditLog(ctx, spaceId, { limit: 1 })).items.length === 0) {
    await seedAuditTrail(run);
  }
}

const AUDIT_ACTIONS = [
  { action: 'POST /entries', targetType: 'entry', status: 201 },
  { action: 'POST /entries/:id/published', targetType: 'entry', status: 200 },
  { action: 'PUT /entries/:id', targetType: 'entry', status: 200 },
  { action: 'POST /content-types/:apiId/published', targetType: 'content_type', status: 200 },
  { action: 'POST /releases', targetType: 'release', status: 201 },
  { action: 'POST /assets/:id/published', targetType: 'asset', status: 200 },
  { action: 'DELETE /entries/:id/published', targetType: 'entry', status: 403 },
  { action: 'POST /entries/:id/workflow/transition', targetType: 'entry', status: 200 },
  { action: 'PUT /entries/:id/metadata', targetType: 'entry', status: 200 },
  { action: 'POST /api-keys', targetType: 'api_key', status: 201 },
  { action: 'DELETE /webhooks/:id', targetType: 'webhook', status: 404 },
  { action: 'POST /releases/:id/published', targetType: 'release', status: 200 },
] as const;

/**
 * ~60 backdated entries over 30 days, mirroring realistic mutating traffic
 * (mostly 2xx with occasional 403/404s). Appends through the store port
 * because `recordAudit` stamps the current clock time — backdating is exactly
 * what makes the demo trail useful.
 */
async function seedAuditTrail(run: SeedRun): Promise<void> {
  const { ctx, scope } = run;
  const now = ctx.clock.now();
  // A few targets, each changed many times, so filtering by one shows a history.
  const targets = Array.from({ length: 8 }, () => ctx.ids.newId());
  let n = 0;
  for (let day = 29; day >= 0; day--) {
    const count = day % 3 === 0 ? 4 : 1;
    for (let k = 0; k < count; k++) {
      const a = pick(AUDIT_ACTIONS, n);
      await ctx.store.audit.append({
        id: ctx.ids.newId(),
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        actor: pick(['dev-cma-key', 'dev-editor', 'admin'] as const, n),
        action: a.action,
        targetType: a.targetType,
        targetId: pick(targets, n),
        status: a.status,
        at: backdated(now, day, 8 + ((k * 4) % 10)),
      });
      n++;
    }
  }
}
