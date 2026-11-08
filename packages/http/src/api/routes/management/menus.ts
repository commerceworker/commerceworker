import {
  createMenu,
  deleteMenu,
  getDeliveredMenu,
  getMenu,
  listMenus,
  moveMenuItem,
  previewMenu,
  updateMenu,
} from '@commerceworker/application';
import { MAX_MENU_DEPTH, MAX_MENU_ITEMS, SCOPES, ValidationError } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as menuDocs from '../../docs/schemas/menus';
import { menuBody, menuMoveBody, menuPatchBody, parseBody } from '../../validation';
import { BASE, scopeOf } from './shared';

/** `?revision=` on a delete: absent, or a positive integer. */
function revisionOf(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError([{ field: 'revision', message: 'A revision is a positive integer' }]);
  }
  return n;
}

export function menusRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- menus (delivery data: a front end renders them) ---------------------
  app.get(
    `${BASE}/menus`,
    doc('Menus', 'List menus', {
      ok: menuDocs.menuList,
      description: 'Every menu in the environment, by handle, without its items.',
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const items = await listMenus(ctx, scopeOf(c));
      return c.json({ items, total: items.length });
    },
  );
  app.post(
    `${BASE}/menus`,
    doc('Menus', 'Create a menu', {
      body: menuBody,
      ok: menuDocs.menu,
      status: 201,
      description:
        `A named tree of links, at most ${MAX_MENU_ITEMS} items and ${MAX_MENU_DEPTH} levels ` +
        'deep. 409 when another menu has the handle; 422 naming each bad item ' +
        '(`items[0].children[1].link`), including a link to an entry or term that doesn’t ' +
        'exist or to an entry whose type has no URL pattern.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) =>
      c.json(
        await createMenu(ctx, scopeOf(c), await parseBody(c, menuBody), {
          principal: c.get('principal'),
        }),
        201,
      ),
  );
  // Before `/menus/:id/preview`, which would take `resolve` for an id (and a handle `preview`).
  app.get(
    `${BASE}/menus/resolve/:handle`,
    doc('Menus', 'Resolve a menu as Delivery serves it', {
      ok: menuDocs.deliveredMenu,
      description:
        'What Delivery’s `menus/:handle` answers now, with this caller’s grants: published ' +
        'entries only, dangling items dropped with their children lifted. 404 for no such handle.',
      query: { locale: 'Resolve in this locale (with the space’s fallbacks); default the default' },
    }),
    requireScope(SCOPES.previewRead),
    async (c) =>
      c.json(
        await getDeliveredMenu(ctx, scopeOf(c), c.req.param('handle'), {
          ...(c.req.query('locale') ? { locale: c.req.query('locale') } : {}),
          principal: c.get('principal'),
        }),
      ),
  );
  app.get(
    `${BASE}/menus/:id`,
    doc('Menus', 'Get a menu', { ok: menuDocs.menu }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(await getMenu(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.get(
    `${BASE}/menus/:id/preview`,
    doc('Menus', 'Preview a menu as Delivery resolves it', {
      ok: menuDocs.menuPreview,
      description:
        'Every item with the label and URL Delivery would serve, or why it serves nothing ' +
        '(`unpublished`, `missing`, `no_url`): nothing is dropped, so an editor sees why.',
      query: { locale: 'Resolve in this locale (with the space’s fallbacks); default the default' },
    }),
    requireScope(SCOPES.previewRead),
    async (c) =>
      c.json(
        await previewMenu(ctx, scopeOf(c), c.req.param('id'), c.req.query('locale') || undefined, {
          principal: c.get('principal'),
        }),
      ),
  );
  app.patch(
    `${BASE}/menus/:id`,
    doc('Menus', 'Change a menu', {
      body: menuPatchBody,
      ok: menuDocs.menu,
      description:
        'Fields left out keep their value; `items` replaces the whole tree (ids given are kept). ' +
        'With `revision`, a menu saved since is a 409; without, the change applies to the menu ' +
        'as it now stands.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) =>
      c.json(
        await updateMenu(ctx, scopeOf(c), c.req.param('id'), await parseBody(c, menuPatchBody), {
          principal: c.get('principal'),
        }),
      ),
  );
  app.post(
    `${BASE}/menus/:id/move`,
    doc('Menus', 'Move a menu item', {
      body: menuMoveBody,
      ok: menuDocs.menu,
      description:
        'Moves one item, and everything under it, to `index` under `parentId` (null: the top ' +
        'level): a reorder without sending the tree back. 422 for a move under itself or past ' +
        `${MAX_MENU_DEPTH} levels; 404 for an item or parent not in the menu.`,
    }),
    requireScope(SCOPES.contentManage),
    async (c) =>
      c.json(
        await moveMenuItem(ctx, scopeOf(c), c.req.param('id'), await parseBody(c, menuMoveBody)),
      ),
  );
  app.delete(
    `${BASE}/menus/:id`,
    doc('Menus', 'Delete a menu', {
      status: 204,
      query: { revision: 'The revision read: a menu saved since is a 409' },
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      await deleteMenu(ctx, scopeOf(c), c.req.param('id'), revisionOf(c.req.query('revision')));
      return c.body(null, 204);
    },
  );

  return app;
}
