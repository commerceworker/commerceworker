import { MAX_MENU_DEPTH, MAX_MENU_ITEMS } from '@commerceworker/domain';
import { z } from 'zod';

// --- menus --------------------------------------------------------------------

/**
 * Menu items nest (an item's children are items), so the nested shapes are described as open
 * objects rather than repeating this one: `z.lazy` would emit a `$ref` cycle the reference
 * renderer does not draw well, and the domain validates the deep shape anyway.
 */
const nestedItems = (what: string) =>
  z
    .array(z.object({}).loose())
    .describe(`${what} (this same shape), at most ${MAX_MENU_DEPTH} deep`);

export const menuLink = z
  .union([
    z.object({ type: z.literal('entry'), entryId: z.string() }),
    z.object({
      type: z.literal('term'),
      termKind: z.enum(['tag', 'concept']),
      termId: z.string(),
    }),
    z.object({
      type: z.literal('url'),
      url: z.string().describe('A path, #fragment, ?query, http(s):// URL, mailto: or tel:'),
    }),
  ])
  .describe('An entry (resolved to its URL pattern at delivery), a taxonomy term, or a URL');

export const menuItem = z.object({
  id: z.string(),
  label: z
    .string()
    .optional()
    .describe('Required for a URL link; absent, an entry’s display field or a term’s label'),
  link: menuLink,
  target: z.literal('_blank').optional(),
  attrs: z
    .record(z.string(), z.string())
    .optional()
    .describe('rel, title, class, aria-label or data-* for the front end to set'),
  children: nestedItems('Child items'),
});

export const menu = z.object({
  id: z.uuid(),
  handle: z.string().describe('Unique in the environment: what Delivery names the menu by'),
  name: z.string(),
  description: z.string().optional(),
  items: z.array(menuItem).describe(`At most ${MAX_MENU_ITEMS} items at every depth together`),
  revision: z.int().describe('Bumped by every save; send it back to refuse a stale save'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const menuSummary = z.object({
  id: z.uuid(),
  handle: z.string(),
  name: z.string(),
  description: z.string().optional(),
  itemCount: z.int(),
  revision: z.int(),
  updatedAt: z.iso.datetime(),
});

export const menuList = z.object({ items: z.array(menuSummary), total: z.int() });

const itemPreview = z.object({
  id: z.string(),
  link: menuLink,
  label: z.string(),
  url: z.string().nullable(),
  status: z
    .enum(['live', 'unpublished', 'missing', 'no_url', 'hidden'])
    .describe('live: Delivery serves it. Otherwise it is dropped and its children lifted'),
  children: nestedItems('Child previews'),
});

export const menuPreview = z.object({
  menu,
  locale: z.string(),
  items: z.array(itemPreview),
});

const deliveredItem = z.object({
  id: z.string(),
  label: z.string(),
  url: z.string().nullable().describe('null for a term link: route a term by its slug'),
  target: z.literal('_blank').optional(),
  attrs: z.record(z.string(), z.string()).optional(),
  entry: z.object({ id: z.string(), contentType: z.string() }).optional(),
  term: z
    .object({
      kind: z.enum(['tag', 'concept']),
      id: z.string(),
      slug: z.string(),
      schemeId: z.string().optional(),
    })
    .optional(),
  children: nestedItems('Child items'),
});

export const deliveredMenu = z.object({
  handle: z.string(),
  name: z.string(),
  description: z.string().optional(),
  locale: z.string(),
  items: z.array(deliveredItem),
});

export const deliveredMenuList = z.object({
  items: z.array(
    z.object({ handle: z.string(), name: z.string(), description: z.string().optional() }),
  ),
  total: z.int(),
});
