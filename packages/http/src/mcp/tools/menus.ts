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
import {
  MAX_MENU_DEPTH,
  MAX_MENU_DESCRIPTION_LENGTH,
  MAX_MENU_HANDLE_LENGTH,
  MAX_MENU_ITEMS,
  MAX_MENU_LABEL_LENGTH,
  MAX_MENU_NAME_LENGTH,
  SCOPES,
} from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, READ_ONLY, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerMenuTools(server: McpServer, t: ToolContext): void {
  const { ctx, guard } = t;
  // The caller's grants apply as on the routes: types they can't read stay hidden.
  const access = { principal: t.principal };
  // --- menus -------------------------------------------------------------
  // One level of an item described; its children are the same shape (the domain checks every
  // level and names a bad item by its path, e.g. items[0].children[1].link).
  const menuItem = z
    .object({
      id: z.string().optional().describe('Kept when given (a move names it); made when not'),
      label: z
        .string()
        .max(MAX_MENU_LABEL_LENGTH)
        .nullable()
        .optional()
        .describe('Required for a url link; absent, the entry’s display field or term’s label'),
      link: z
        .union([
          z.object({ type: z.literal('entry'), entryId: z.string() }),
          z.object({
            type: z.literal('term'),
            termKind: z.enum(['tag', 'concept']),
            termId: z.string(),
          }),
          z.object({
            type: z.literal('url'),
            url: z.string().describe('/path, #fragment, ?query, http(s)://…, mailto: or tel:'),
          }),
        ])
        .describe(
          'An entry (its type needs a urlPattern; served only while published), a taxonomy term, or a URL',
        ),
      target: z.enum(['_self', '_blank']).nullable().optional(),
      attrs: z
        .record(z.string(), z.string())
        .nullable()
        .optional()
        .describe('rel, title, class, aria-label or data-*'),
      children: z
        .array(z.object({}).loose())
        .optional()
        .describe(`Child items, this same shape; at most ${MAX_MENU_DEPTH} levels in all`),
    })
    .loose();
  const items = z
    .array(menuItem)
    .max(MAX_MENU_ITEMS)
    .describe(`The whole item tree, at most ${MAX_MENU_ITEMS} items`);
  const menuArgs = {
    handle: z
      .string()
      .max(MAX_MENU_HANDLE_LENGTH)
      .describe('Unique in the environment, lowercase: main, footer-legal'),
    name: z.string().max(MAX_MENU_NAME_LENGTH),
    description: z.string().max(MAX_MENU_DESCRIPTION_LENGTH).nullable().optional(),
    items: items.optional(),
  };

  server.registerTool(
    'menus_list',
    {
      description:
        "List an environment's navigation menus by handle, with each one's item count and revision (no items).",
      inputSchema: toolSchema('menus_list', () => z.object({ ...scopeArgs })),
      annotations: READ_ONLY,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      const list = await listMenus(ctx, scopeOf(args));
      return ok({ items: list, total: list.length });
    },
  );

  server.registerTool(
    'menus_get',
    {
      description: 'Get one menu by id: its item tree as stored, and its revision.',
      inputSchema: toolSchema('menus_get', () => z.object({ id: z.string(), ...scopeArgs })),
      annotations: READ_ONLY,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getMenu(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'menus_preview',
    {
      description:
        'A menu with every item checked as Delivery would resolve it now: its label and URL, or ' +
        'why Delivery drops it (unpublished, missing, no_url). Use it to see why an item is not showing.',
      inputSchema: toolSchema('menus_preview', () =>
        z.object({ id: z.string(), locale: z.string().optional(), ...scopeArgs }),
      ),
      annotations: READ_ONLY,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await previewMenu(ctx, scopeOf(args), args.id, args.locale, access));
    },
  );

  server.registerTool(
    'menus_resolve',
    {
      description:
        'A menu by handle exactly as Delivery serves it to a front end (GET …/menus/resolve/:handle): ' +
        'published entries only, resolved to their URLs, dangling items dropped with their children lifted.',
      inputSchema: toolSchema('menus_resolve', () =>
        z.object({ handle: z.string(), locale: z.string().optional(), ...scopeArgs }),
      ),
      annotations: READ_ONLY,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(
        await getDeliveredMenu(ctx, scopeOf(args), args.handle, {
          ...(args.locale ? { locale: args.locale } : {}),
          ...access,
        }),
      );
    },
  );

  server.registerTool(
    'menus_create',
    {
      description:
        'Create a navigation menu: a handle, a name and an item tree. Refused when the handle is ' +
        'taken, or (naming each bad item) for a link to an entry or term that does not exist or ' +
        'to an entry whose content type has no urlPattern.',
      inputSchema: toolSchema('menus_create', () => z.object({ ...menuArgs, ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      const { space: _s, environment: _e, ...input } = args;
      return ok(await createMenu(ctx, scopeOf(args), input, access));
    },
  );

  server.registerTool(
    'menus_update',
    {
      description:
        'Change a menu. Fields left out keep their value; items replaces the whole tree (keep ' +
        'item ids to keep items). Pass the revision you read to be refused rather than ' +
        'overwrite a save made since.',
      inputSchema: toolSchema('menus_update', () =>
        z.object({
          id: z.string(),
          ...z.object(menuArgs).partial().shape,
          revision: z.int().min(1).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      const { space: _s, environment: _e, id, ...patch } = args;
      return ok(await updateMenu(ctx, scopeOf(args), id, patch, access));
    },
  );

  server.registerTool(
    'menus_move_item',
    {
      description:
        'Move one menu item, with everything under it, to index under parentId (null for the ' +
        'top level): reorder or re-nest without sending the tree back.',
      inputSchema: toolSchema('menus_move_item', () =>
        z.object({
          id: z.string().describe('The menu'),
          itemId: z.string(),
          parentId: z.string().nullable(),
          index: z.int().min(0),
          revision: z.int().min(1).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      const { space: _s, environment: _e, id, ...move } = args;
      return ok(await moveMenuItem(ctx, scopeOf(args), id, move));
    },
  );

  server.registerTool(
    'menus_delete',
    {
      description: 'Delete a menu. Delivery stops serving its handle.',
      inputSchema: toolSchema('menus_delete', () =>
        z.object({ id: z.string(), revision: z.int().min(1).optional(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      await deleteMenu(ctx, scopeOf(args), args.id, args.revision);
      return ok({ deleted: args.id });
    },
  );
}
