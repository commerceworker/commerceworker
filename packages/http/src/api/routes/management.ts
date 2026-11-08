import { Hono } from 'hono';
import {
  type AuthDeps,
  type AuthVars,
  auditMiddleware,
  environmentMiddleware,
  principalMiddleware,
} from '../auth';
import { agentActionsRoutes } from './management/agent-actions';
import { agentRunsRoutes } from './management/agent-runs';
import { agentsRoutes } from './management/agents';
import { aiActionsRoutes } from './management/ai-actions';
import { aiContentRoutes } from './management/ai-content';
import { apiKeysRoutes } from './management/api-keys';
import { appExtensionsRoutes } from './management/app-extensions';
import { assetCollectionsRoutes } from './management/asset-collections';
import { assetFoldersRoutes } from './management/asset-folders';
import { assetItemRoutes } from './management/asset-item';
import { assetRenditionsRoutes } from './management/asset-renditions';
import { assetZipsRoutes } from './management/asset-zips';
import { assetsRoutes } from './management/assets';
import { auditLogRoutes } from './management/audit-log';
import { blocksRoutes } from './management/blocks';
import { bulkRoutes } from './management/bulk';
import { collaborationRoutes } from './management/collaboration';
import { contentTypesRoutes } from './management/content-types';
import { deploymentRoutes } from './management/deployment';
import { docsRoutes } from './management/docs';
import { entriesRoutes } from './management/entries';
import { entryTaxonomyRoutes } from './management/entry-taxonomy';
import { environmentAliasesRoutes } from './management/environment-aliases';
import { environmentMergeRoutes } from './management/environment-merge';
import { functionsRoutes } from './management/functions';
import { importsRoutes } from './management/imports';
import { menusRoutes } from './management/menus';
import { oauthConnectionsRoutes } from './management/oauth-connections';
import { pluginsRoutes } from './management/plugins';
import { promotionsRoutes } from './management/promotions';
import { provisioningRoutes } from './management/provisioning';
import { redirectsRoutes } from './management/redirects';
import { releasesRoutes } from './management/releases';
import { rolesRoutes } from './management/roles';
import { savedViewsRoutes } from './management/saved-views';
import { semanticsRoutes } from './management/semantics';
import { seoRoutes } from './management/seo';
import { shareLinksRoutes } from './management/share-links';
import { snapshotsRoutes } from './management/snapshots';
import { spaceExportRoutes } from './management/space-export';
import { taxonomyRoutes } from './management/taxonomy';
import { trashRoutes } from './management/trash';
import { uploadsRoutes } from './management/uploads';
import { versionsRoutes } from './management/versions';
import { webhooksRoutes } from './management/webhooks';
import { workflowManagementRoutes } from './management/workflows';

/**
 * Every management area, in mount order (the order the routes match in and the OpenAPI
 * document lists them in). A new area adds its own file under `management/` and one line here.
 */
const AREAS: readonly ((deps: AuthDeps) => Hono<AuthVars>)[] = [
  deploymentRoutes,
  docsRoutes,
  provisioningRoutes,
  environmentAliasesRoutes,
  auditLogRoutes,
  environmentMergeRoutes,
  promotionsRoutes,
  apiKeysRoutes,
  oauthConnectionsRoutes,
  snapshotsRoutes,
  importsRoutes,
  spaceExportRoutes,
  pluginsRoutes,
  rolesRoutes,
  contentTypesRoutes,
  entriesRoutes,
  trashRoutes,
  aiContentRoutes,
  functionsRoutes,
  appExtensionsRoutes,
  bulkRoutes,
  agentActionsRoutes,
  semanticsRoutes,
  versionsRoutes,
  assetsRoutes,
  assetCollectionsRoutes,
  shareLinksRoutes,
  uploadsRoutes,
  assetZipsRoutes,
  assetItemRoutes,
  assetRenditionsRoutes,
  assetFoldersRoutes,
  aiActionsRoutes,
  agentRunsRoutes,
  webhooksRoutes,
  releasesRoutes,
  agentsRoutes,
  collaborationRoutes,
  workflowManagementRoutes,
  taxonomyRoutes,
  redirectsRoutes,
  seoRoutes,
  blocksRoutes,
  menusRoutes,
  savedViewsRoutes,
  entryTaxonomyRoutes,
];

/** Management API (CMA): authoring + publishing, gated by RBAC scopes. */
export function managementRoutes(deps: AuthDeps): Hono<AuthVars> {
  const app = new Hono<AuthVars>();
  // Authenticated, but unscoped: the product's own documentation is identical
  // for every space and discloses nothing about anyone's content. Requiring a
  // token anyway keeps a deployment from unintentionally serving a public docs
  // site, and matches the MCP tools.
  // `/guides/*` covers the bare `/guides` too — verified, not assumed.
  app.use('/guides/*', principalMiddleware(deps));
  app.use('/deployment/*', principalMiddleware(deps));
  app.use('/spaces', principalMiddleware(deps));
  app.use('/starters', principalMiddleware(deps));
  app.use('/spaces/*', principalMiddleware(deps));
  // Resolve environment aliases for any scoped (:env) route.
  app.use('/spaces/:space/environments/:env/*', environmentMiddleware(deps));
  // Record successful mutations to the append-only audit trail.
  app.use('/spaces/:space/*', auditMiddleware(deps));
  for (const routes of AREAS) app.route('/', routes(deps));
  return app;
}
