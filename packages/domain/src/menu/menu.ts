import { urlPath } from '../content-type/content-type';
import { type FieldIssue, NotFoundError, ValidationError } from '../errors';
import { type LocaleConfig, resolveFieldsForLocale } from '../locale';
import type { TermKind } from '../taxonomy/taxonomy';
import type { EntryFields } from '../types';

/**
 * Navigation menus: named, ordered trees of links a front end renders as its header, footer or
 * sidebar navigation. CommerceWorker serves no site, so a menu is delivery data, like redirects.
 *
 * A menu is live, not versioned: a saved change is what Delivery serves next. What keeps it from
 * pointing at unpublished work is resolution at delivery time: an item linking to an entry is
 * served only while that entry is published (with the URL its type's `urlPattern` gives it), and
 * one linking to a taxonomy term only while the term exists. An item that doesn't resolve is
 * dropped and its children take its place, so unpublishing a section page never hides the pages
 * under it.
 *
 * Items are structured data: a label, a typed link and a small set of attributes, never markup.
 */

/** Most menus an environment holds. */
export const MAX_MENUS = 100;
/** Most items one menu holds, at every depth together. */
export const MAX_MENU_ITEMS = 250;
/** Deepest a menu nests: top-level items are depth 1. */
export const MAX_MENU_DEPTH = 3;
export const MAX_MENU_HANDLE_LENGTH = 64;
export const MAX_MENU_NAME_LENGTH = 120;
export const MAX_MENU_DESCRIPTION_LENGTH = 500;
export const MAX_MENU_LABEL_LENGTH = 120;
export const MAX_MENU_URL_LENGTH = 2048;
/** Most attributes one item carries. */
export const MAX_MENU_ITEM_ATTRS = 8;
export const MAX_MENU_ATTR_LENGTH = 256;

/** Where an item points: an entry, a taxonomy term, or a URL written by hand. */
export type MenuLink =
  | { readonly type: 'entry'; readonly entryId: string }
  | { readonly type: 'term'; readonly termKind: TermKind; readonly termId: string }
  | { readonly type: 'url'; readonly url: string };

export type MenuLinkType = MenuLink['type'];

export interface MenuItem {
  /** Stable within its menu: what a move names. */
  readonly id: string;
  /**
   * What the item reads as. Required for a URL link; for an entry or a term, absent means the
   * entry's display field (or the term's label) in the requested locale.
   */
  readonly label?: string;
  readonly link: MenuLink;
  /** `_blank` opens the link in a new browsing context; absent, the same one. */
  readonly target?: '_blank';
  /** Attributes the front end sets on the link: `rel`, `title`, `class`, `aria-label`, `data-*`. */
  readonly attrs?: Readonly<Record<string, string>>;
  readonly children: readonly MenuItem[];
}

export interface Menu {
  readonly id: string;
  /** Unique in the environment: what Delivery and a front end name it by (`main`, `footer`). */
  readonly handle: string;
  readonly name: string;
  readonly description?: string;
  readonly items: readonly MenuItem[];
  /** Bumped by every write: a write naming an older one is refused (someone saved since). */
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** An item as a person, an agent or an import gives it. `id` is kept when given, made when not. */
export interface MenuItemInput {
  readonly id?: string;
  readonly label?: string | null;
  readonly link: unknown;
  readonly target?: '_self' | '_blank' | null;
  readonly attrs?: Readonly<Record<string, string>> | null;
  readonly children?: readonly MenuItemInput[];
}

const HANDLE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ATTR_KEY = /^(?:rel|title|class|aria-label|data-[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const CONTROL = /\p{Cc}/u;
const FORBIDDEN_IN_URL = /[\s\p{Cc}\\]/u;

const fail = (field: string, message: string): never => {
  throw new ValidationError([{ field, message }]);
};

export function checkMenuHandle(input: unknown): string {
  const handle = typeof input === 'string' ? input.trim() : '';
  if (!HANDLE.test(handle) || handle.length > MAX_MENU_HANDLE_LENGTH) {
    fail(
      'handle',
      `A handle is lowercase letters and digits joined by - or _ (e.g. main, footer-legal), at most ${MAX_MENU_HANDLE_LENGTH} characters`,
    );
  }
  return handle;
}

export function checkMenuName(input: unknown): string {
  const name = typeof input === 'string' ? input.trim() : '';
  if (name === '' || name.length > MAX_MENU_NAME_LENGTH || CONTROL.test(name)) {
    fail('name', `A name is 1 to ${MAX_MENU_NAME_LENGTH} characters`);
  }
  return name;
}

/** A description, or undefined for none (`null` or blank). */
export function checkMenuDescription(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'string') return fail('description', 'A description is text');
  const text = input.trim();
  if (text.length > MAX_MENU_DESCRIPTION_LENGTH) {
    fail('description', `A description is at most ${MAX_MENU_DESCRIPTION_LENGTH} characters`);
  }
  return text || undefined;
}

/**
 * A hand-written link's URL: a site path (`/about`, `/search?q=x`), a fragment or query on the
 * current page (`#top`, `?page=2`), an absolute `http(s)://` URL, or `mailto:` / `tel:`. Anything
 * else (`javascript:`, `data:`, a protocol-relative `//host`) is refused: a front end renders it
 * as a link without checking it again.
 */
export function checkMenuUrl(input: unknown, field = 'url'): string {
  const url = typeof input === 'string' ? input.trim() : '';
  if (url === '') return fail(field, 'A URL link needs a URL');
  if (url.length > MAX_MENU_URL_LENGTH) {
    fail(field, `A URL is at most ${MAX_MENU_URL_LENGTH} characters`);
  }
  if (FORBIDDEN_IN_URL.test(url)) fail(field, 'A URL cannot hold spaces, controls or \\');
  if (url.startsWith('/')) {
    if (url.startsWith('//')) fail(field, 'A site path starts with a single /');
    return url;
  }
  if (url.startsWith('#') || url.startsWith('?')) return url;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme === 'http' || scheme === 'https') {
    // The host, without any userinfo (a link never carries credentials).
    const authority = /^https?:\/\/([^/?#]*)/i.exec(url)?.[1] ?? '';
    if (!/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(authority) || !/[A-Za-z0-9]/.test(authority)) {
      fail(field, 'An absolute URL is http(s)://host/path');
    }
    return url;
  }
  if ((scheme === 'mailto' || scheme === 'tel') && url.length > scheme.length + 1) return url;
  return fail(field, 'A URL is a path (/about), #fragment, http(s)://, mailto: or tel: link');
}

function checkLink(input: unknown, at: string, issues: FieldIssue[]): MenuLink | undefined {
  const link = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 128;
  switch (link.type) {
    case 'entry':
      if (!id(link.entryId)) break;
      return { type: 'entry', entryId: link.entryId as string };
    case 'term':
      if ((link.termKind !== 'tag' && link.termKind !== 'concept') || !id(link.termId)) break;
      return { type: 'term', termKind: link.termKind, termId: link.termId as string };
    case 'url':
      try {
        return { type: 'url', url: checkMenuUrl(link.url, `${at}.link.url`) };
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        issues.push(...err.issues);
        return undefined;
      }
  }
  issues.push({
    field: `${at}.link`,
    message:
      'A link is { type: "entry", entryId }, { type: "term", termKind: "tag" | "concept", termId } or { type: "url", url }',
  });
  return undefined;
}

function checkAttrs(
  input: unknown,
  at: string,
  issues: FieldIssue[],
): Record<string, string> | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) {
    issues.push({ field: `${at}.attrs`, message: 'Attributes are a map of names to text' });
    return undefined;
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_MENU_ITEM_ATTRS) {
    issues.push({
      field: `${at}.attrs`,
      message: `An item carries at most ${MAX_MENU_ITEM_ATTRS} attributes`,
    });
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    // Named ones only: an item never carries an event handler, a style or its own href.
    if (!ATTR_KEY.test(key)) {
      issues.push({
        field: `${at}.attrs.${key}`,
        message: 'An attribute is rel, title, class, aria-label or data-*',
      });
      continue;
    }
    if (typeof value !== 'string' || value.length > MAX_MENU_ATTR_LENGTH || CONTROL.test(value)) {
      issues.push({
        field: `${at}.attrs.${key}`,
        message: `An attribute's value is text of at most ${MAX_MENU_ATTR_LENGTH} characters`,
      });
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Checks a menu's items and returns them normalized, or throws one `ValidationError` naming every
 * bad item by its path (`items[0].children[1].label`). Items without an id get one from `newId`;
 * an id is unique in the menu. At most {@link MAX_MENU_ITEMS} items, {@link MAX_MENU_DEPTH} deep.
 */
export function checkMenuItems(input: unknown, newId: () => string): MenuItem[] {
  if (!Array.isArray(input)) return fail('items', 'Items are an array');
  const issues: FieldIssue[] = [];
  const seen = new Set<string>();
  let count = 0;
  const walk = (list: readonly unknown[], path: string, depth: number): MenuItem[] => {
    const out: MenuItem[] = [];
    list.forEach((raw, i) => {
      const at = `${path}[${i}]`;
      count++;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        issues.push({ field: at, message: 'An item is an object' });
        return;
      }
      const item = raw as Record<string, unknown>;
      let id: string;
      if (item.id === undefined || item.id === null || item.id === '') id = newId();
      else if (typeof item.id === 'string' && ITEM_ID.test(item.id)) id = item.id;
      else {
        issues.push({ field: `${at}.id`, message: 'An item id is 1 to 64 of A-Z a-z 0-9 _ -' });
        return;
      }
      if (seen.has(id)) issues.push({ field: `${at}.id`, message: `Item id ${id} is used twice` });
      seen.add(id);

      const link = checkLink(item.link, at, issues);
      let label: string | undefined;
      if (item.label !== undefined && item.label !== null) {
        if (typeof item.label !== 'string' || CONTROL.test(item.label)) {
          issues.push({ field: `${at}.label`, message: 'A label is text' });
        } else {
          label = item.label.trim() || undefined;
          if (label && label.length > MAX_MENU_LABEL_LENGTH) {
            issues.push({
              field: `${at}.label`,
              message: `A label is at most ${MAX_MENU_LABEL_LENGTH} characters`,
            });
          }
        }
      }
      if (link?.type === 'url' && !label) {
        issues.push({ field: `${at}.label`, message: 'A URL link needs a label' });
      }
      const target = item.target;
      if (target !== undefined && target !== null && target !== '_self' && target !== '_blank') {
        issues.push({ field: `${at}.target`, message: 'A target is _self or _blank' });
      }
      const attrs = checkAttrs(item.attrs, at, issues);
      const rawChildren = item.children ?? [];
      let children: MenuItem[] = [];
      if (!Array.isArray(rawChildren)) {
        issues.push({ field: `${at}.children`, message: 'Children are an array' });
      } else if (rawChildren.length > 0 && depth >= MAX_MENU_DEPTH) {
        issues.push({
          field: `${at}.children`,
          message: `A menu nests at most ${MAX_MENU_DEPTH} levels deep`,
        });
      } else {
        children = walk(rawChildren, `${at}.children`, depth + 1);
      }
      if (!link) return;
      out.push({
        id,
        ...(label ? { label } : {}),
        link,
        ...(target === '_blank' ? { target: '_blank' as const } : {}),
        ...(attrs ? { attrs } : {}),
        children,
      });
    });
    return out;
  };
  const items = walk(input, 'items', 1);
  if (count > MAX_MENU_ITEMS) {
    issues.unshift({
      field: 'items',
      message: `A menu holds at most ${MAX_MENU_ITEMS} items (this has ${count})`,
    });
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return items;
}

/** Every item, parents before their children, in menu order. */
export function* menuItemsFlat(items: readonly MenuItem[]): Generator<MenuItem> {
  for (const item of items) {
    yield item;
    yield* menuItemsFlat(item.children);
  }
}

export const countMenuItems = (items: readonly MenuItem[]): number => {
  let n = 0;
  for (const _ of menuItemsFlat(items)) n++;
  return n;
};

/** What a menu's items link to: the entries and terms a write checks and Delivery resolves. */
export interface MenuTargets {
  readonly entryIds: readonly string[];
  readonly terms: readonly { readonly kind: TermKind; readonly id: string }[];
}

export function menuTargets(items: readonly MenuItem[]): MenuTargets {
  const entryIds = new Set<string>();
  const terms = new Map<string, { kind: TermKind; id: string }>();
  for (const { link } of menuItemsFlat(items)) {
    if (link.type === 'entry') entryIds.add(link.entryId);
    if (link.type === 'term') {
      terms.set(`${link.termKind}:${link.termId}`, { kind: link.termKind, id: link.termId });
    }
  }
  return { entryIds: [...entryIds], terms: [...terms.values()] };
}

/** Where a move puts an item: under `parentId` (null for the top level), at `index` there. */
export interface MenuItemMove {
  readonly itemId: string;
  readonly parentId: string | null;
  /** Position among the new siblings, 0-based; past the end appends. */
  readonly index: number;
}

/**
 * The items with one item (and everything under it) moved. Refused when the item or the parent
 * isn't in the menu, when the parent is the item itself or one of its descendants, or when the
 * move would nest the item's subtree past {@link MAX_MENU_DEPTH}.
 */
export function moveMenuItem(items: readonly MenuItem[], move: MenuItemMove): MenuItem[] {
  let moved: MenuItem | undefined;
  const without = (list: readonly MenuItem[]): MenuItem[] =>
    list.flatMap((item) => {
      if (item.id === move.itemId) {
        moved = item;
        return [];
      }
      return [{ ...item, children: without(item.children) }];
    });
  const rest = without(items);
  if (!moved) throw new NotFoundError('Menu item', move.itemId);
  const subtree = moved;
  if (move.parentId !== null && [...menuItemsFlat([subtree])].some((i) => i.id === move.parentId)) {
    fail('parentId', 'An item cannot move under itself');
  }
  const height = (item: MenuItem): number => 1 + Math.max(0, ...item.children.map(height));
  const index = Math.max(0, Math.trunc(move.index));
  const insert = (list: readonly MenuItem[]): MenuItem[] => {
    const out = [...list];
    out.splice(Math.min(index, out.length), 0, subtree);
    return out;
  };
  if (move.parentId === null) return insert(rest);
  let placed = false;
  const into = (list: readonly MenuItem[], depth: number): MenuItem[] =>
    list.map((item) => {
      if (item.id === move.parentId) {
        placed = true;
        if (depth + height(subtree) > MAX_MENU_DEPTH) {
          fail('parentId', `A menu nests at most ${MAX_MENU_DEPTH} levels deep`);
        }
        return { ...item, children: insert(item.children) };
      }
      return { ...item, children: into(item.children, depth + 1) };
    });
  const next = into(rest, 1);
  if (!placed) throw new NotFoundError('Menu item', move.parentId);
  return next;
}

// --- delivery ---------------------------------------------------------------

/** An item as Delivery serves it: resolved for one locale, ready to render. */
export interface DeliveredMenuItem {
  readonly id: string;
  readonly label: string;
  /** Where the item goes; null for a term link (the front end routes terms by slug). */
  readonly url: string | null;
  readonly target?: '_blank';
  readonly attrs?: Readonly<Record<string, string>>;
  /** The entry an entry link resolved to. */
  readonly entry?: { readonly id: string; readonly contentType: string };
  /** The term a term link resolved to. */
  readonly term?: {
    readonly kind: TermKind;
    readonly id: string;
    readonly slug: string;
    readonly schemeId?: string;
  };
  readonly children: readonly DeliveredMenuItem[];
}

/** What a link resolved to, or null when it dangles (the item is dropped). */
export interface ResolvedMenuLink {
  readonly url: string | null;
  /** The label to use when the item has none of its own. */
  readonly label: string;
  readonly entry?: DeliveredMenuItem['entry'];
  readonly term?: DeliveredMenuItem['term'];
}

/**
 * Resolves a menu's items for delivery. An item whose link `resolve` returns null for is dropped
 * and its resolved children take its place, so the tree never loses a reachable page because the
 * page above it went away.
 */
export function resolveMenuItems(
  items: readonly MenuItem[],
  resolve: (link: MenuLink) => ResolvedMenuLink | null,
): DeliveredMenuItem[] {
  return items.flatMap((item): DeliveredMenuItem[] => {
    const children = resolveMenuItems(item.children, resolve);
    const resolved = resolve(item.link);
    if (!resolved) return children;
    return [
      {
        id: item.id,
        label: item.label ?? resolved.label,
        url: resolved.url,
        ...(item.target ? { target: item.target } : {}),
        ...(item.attrs ? { attrs: item.attrs } : {}),
        ...(resolved.entry ? { entry: resolved.entry } : {}),
        ...(resolved.term ? { term: resolved.term } : {}),
        children,
      },
    ];
  });
}

/**
 * A published entry's path in `locale`, from its type's URL pattern, following the space's
 * fallback chain for each slug (a slug that isn't localized lives under the default locale).
 * Null when a slug the pattern names has no value.
 */
export function entryUrlPath(
  pattern: string,
  entry: { readonly id: string; readonly fields: EntryFields },
  config: LocaleConfig,
  locale: string,
): string | null {
  const resolved = resolveFieldsForLocale(entry.fields, config, locale);
  const fields: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(resolved)) fields[name] = { [locale]: value };
  return urlPath(pattern, { id: entry.id, fields }, locale);
}
