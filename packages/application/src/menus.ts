import {
  type Concept,
  ConflictError,
  type ContentType,
  canAccessContentType,
  checkMenuDescription,
  checkMenuHandle,
  checkMenuItems,
  checkMenuName,
  countMenuItems,
  type DeliveredMenuItem,
  deniedFieldsFor,
  entryUrlPath,
  type LocaleConfig,
  MAX_MENUS,
  type Menu,
  type MenuItem,
  type MenuItemMove,
  type MenuLink,
  menuTargets,
  moveMenuItem as moveItem,
  NotFoundError,
  type Principal,
  type ResolvedMenuLink,
  resolveFieldsForLocale,
  resolveMenuItems,
  resolveTermLabel,
  type Scope,
  type Tag,
  type TermKind,
  urlPatternSlugFields,
  ValidationError,
} from '@commerceworker/domain';
import { type PublishedEntry, TransactionConflictError } from '@commerceworker/ports';
import type { AppContext } from './context';
import { assertDeliveredLocale, type DeliveryReads, deliveryReads } from './delivery-reads';

/**
 * Navigation menus: an environment's named trees of links (`main`, `footer`), managed here and
 * served resolved by Delivery. Menus are live, not versioned: a saved change is what Delivery
 * serves next, and what keeps a menu from leaking unpublished work is that an entry link resolves
 * only against published entries (see `@commerceworker/domain`'s menu module).
 *
 * Every write reads the menu, changes it, and commits it with its revision's compare-and-set and
 * a `menus.changed` event in one unit. A caller that names the revision it read (the admin, an
 * agent that read first) is refused with a conflict when someone saved since; one that doesn't
 * has its change applied to the menu as it now stands.
 */

/** Times a write reads, changes and commits a menu before giving up to a busier writer. */
const WRITE_ATTEMPTS = 3;

export interface MenuInput {
  readonly handle: string;
  readonly name: string;
  readonly description?: string | null;
  readonly items?: unknown;
}

export interface MenuPatch {
  readonly handle?: string;
  readonly name?: string;
  /** `null` clears it. */
  readonly description?: string | null;
  /** The whole tree, replacing the menu's items (ids given are kept, so a move keeps its item). */
  readonly items?: unknown;
  /** The revision the change was made against; a menu saved since is a conflict. */
  readonly revision?: number;
}

/** A menu without its items: what a list shows. */
export interface MenuSummary {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  readonly description?: string;
  readonly itemCount: number;
  readonly revision: number;
  readonly updatedAt: string;
}

const summary = (m: Menu): MenuSummary => ({
  id: m.id,
  handle: m.handle,
  name: m.name,
  ...(m.description ? { description: m.description } : {}),
  itemCount: countMenuItems(m.items),
  revision: m.revision,
  updatedAt: m.updatedAt,
});

const stale = (id: string) =>
  new ConflictError(`Menu "${id}" was saved by someone else since it was read: read it again`);

/**
 * Who is asking, for a caller limited to some content types (`contentGrants`): an entry of a type
 * they can't read is reported as if it didn't exist, and a field their grant denies never shapes
 * a label or a URL. Absent, the caller reads every type.
 */
export interface MenuAccess {
  readonly principal?: Principal;
}

const canRead = (access: MenuAccess, contentType: string): boolean =>
  !access.principal || canAccessContentType(access.principal, 'read', contentType);

const deniedOf = (access: MenuAccess, contentType: string): ReadonlySet<string> =>
  new Set(access.principal ? deniedFieldsFor(access.principal, contentType) : []);

/**
 * Checks that the entries and terms `items` link to exist, and that each linked entry's type has
 * a URL pattern (without one an entry link could never resolve). Links `before` already held are
 * not checked again: removing a type's pattern later doesn't stop the rest of a menu being saved.
 */
async function checkLinks(
  ctx: AppContext,
  scope: Scope,
  items: readonly MenuItem[],
  before: readonly MenuItem[],
  access: MenuAccess,
): Promise<void> {
  const held = menuTargets(before);
  const heldEntries = new Set(held.entryIds);
  const heldTerms = new Set(held.terms.map((t) => `${t.kind}:${t.id}`));
  const targets = menuTargets(items);
  const entryIds = targets.entryIds.filter((id) => !heldEntries.has(id));
  const terms = targets.terms.filter((t) => !heldTerms.has(`${t.kind}:${t.id}`));
  if (entryIds.length === 0 && terms.length === 0) return;
  const wants = (kind: TermKind) => terms.some((t) => t.kind === kind);
  const [entries, types, kept, tags, concepts] = await Promise.all([
    entryIds.length > 0 ? ctx.store.entries.getMany(scope, entryIds) : [],
    entryIds.length > 0 ? ctx.store.contentTypes.list(scope) : [],
    entryIds.length > 0 ? ctx.store.contentTypes.publishedDefinitions(scope) : new Map(),
    wants('tag') ? ctx.store.taxonomy.listTags(scope) : [],
    wants('concept') ? ctx.store.taxonomy.listConcepts(scope) : [],
  ]);
  // An entry of a type the caller can't read doesn't exist for them: no oracle for its type.
  const typeOf = new Map(
    entries
      .filter((e) => canRead(access, e.entry.contentTypeApiId))
      .map((e) => [e.entry.id, e.entry.contentTypeApiId]),
  );
  // A pattern Delivery serves, or one still in a draft: a menu may be built ahead of a publish, and
  // `previewMenu` says the link has no URL yet. A draft clearing the served one refuses nothing.
  const patterned = new Set(
    types.filter((t) => t.urlPattern || kept.get(t.apiId)?.urlPattern).map((t) => t.apiId),
  );
  const termIds = new Set([
    ...tags.map((t) => `tag:${t.id}`),
    ...concepts.map((c) => `concept:${c.id}`),
  ]);
  const issues: { field: string; message: string }[] = [];
  const walk = (list: readonly MenuItem[], path: string) =>
    list.forEach((item, i) => {
      const at = `${path}[${i}].link`;
      const { link } = item;
      if (link.type === 'entry' && entryIds.includes(link.entryId)) {
        const type = typeOf.get(link.entryId);
        if (!type) issues.push({ field: at, message: `Entry ${link.entryId} does not exist` });
        else if (!patterned.has(type)) {
          issues.push({
            field: at,
            message: `Content type ${type} has no URL pattern, so its entries have no URL to link to`,
          });
        }
      }
      if (
        link.type === 'term' &&
        terms.some((t) => t.kind === link.termKind && t.id === link.termId) &&
        !termIds.has(`${link.termKind}:${link.termId}`)
      ) {
        issues.push({ field: at, message: `${link.termKind} ${link.termId} does not exist` });
      }
      walk(item.children, `${path}[${i}].children`);
    });
  walk(items, 'items');
  if (issues.length > 0) throw new ValidationError(issues);
}

/** Commits `next` over `current` with the compare-and-set and the event that announces it. */
async function commit(ctx: AppContext, scope: Scope, next: Menu, current: Menu | null) {
  await ctx.store.withTransaction(async (tx) => {
    await tx.menus.save(scope, next, current?.revision);
    await tx.outbox.append({
      id: ctx.ids.newId(),
      type: 'menus.changed',
      scope,
      occurredAt: ctx.clock.now().toISOString(),
      menuId: next.id,
      handle: next.handle,
    });
  });
}

/** A handle another menu in the environment already holds is a conflict, said plainly. */
async function assertHandleFree(ctx: AppContext, scope: Scope, handle: string, id?: string) {
  const holder = await ctx.store.menus.getByHandle(scope, handle);
  if (holder && holder.id !== id) {
    throw new ConflictError(`Another menu already has the handle "${handle}"`);
  }
}

/**
 * Reads the menu, asks `change` for its next state, checks it and commits it. With `expected`, a
 * menu at another revision (now, or by commit) is a conflict; without, a lost race is retried.
 */
async function writeMenu(
  ctx: AppContext,
  scope: Scope,
  id: string,
  expected: number | undefined,
  access: MenuAccess,
  change: (current: Menu) => Omit<Menu, 'revision' | 'updatedAt'>,
): Promise<Menu> {
  for (let attempt = 1; ; attempt++) {
    // Reads first: the unit in `commit` only writes.
    const current = await ctx.store.menus.get(scope, id);
    if (!current) throw new NotFoundError('Menu', id);
    if (expected !== undefined && current.revision !== expected) throw stale(id);
    const changed = change(current);
    if (changed.handle !== current.handle) await assertHandleFree(ctx, scope, changed.handle, id);
    await checkLinks(ctx, scope, changed.items, current.items, access);
    const next: Menu = {
      ...changed,
      revision: current.revision + 1,
      updatedAt: ctx.clock.now().toISOString(),
    };
    try {
      await commit(ctx, scope, next, current);
      return next;
    } catch (err) {
      if (!(err instanceof TransactionConflictError)) throw err;
      if (expected !== undefined) throw stale(id);
      if (attempt >= WRITE_ATTEMPTS) throw err;
    }
  }
}

// --- reads ----------------------------------------------------------------

/** Every menu in the environment, by handle, without items. */
export async function listMenus(ctx: AppContext, scope: Scope): Promise<MenuSummary[]> {
  return (await ctx.store.menus.all(scope)).map(summary);
}

export async function getMenu(ctx: AppContext, scope: Scope, id: string): Promise<Menu> {
  const menu = await ctx.store.menus.get(scope, id);
  if (!menu) throw new NotFoundError('Menu', id);
  return menu;
}

// --- writes ---------------------------------------------------------------

export async function createMenu(
  ctx: AppContext,
  scope: Scope,
  input: MenuInput,
  access: MenuAccess = {},
): Promise<Menu> {
  const handle = checkMenuHandle(input.handle);
  const name = checkMenuName(input.name);
  const description = checkMenuDescription(input.description);
  const items = checkMenuItems(input.items ?? [], () => ctx.ids.newId());
  const existing = await ctx.store.menus.all(scope);
  // A cap on what an environment holds, not a guarantee under a race: two creates at once may
  // both pass it, which costs a menu over, never a broken one.
  if (existing.length >= MAX_MENUS) {
    throw new ValidationError([
      { field: 'handle', message: `An environment holds at most ${MAX_MENUS} menus` },
    ]);
  }
  if (existing.some((m) => m.handle === handle)) {
    throw new ConflictError(`Another menu already has the handle "${handle}"`);
  }
  await checkLinks(ctx, scope, items, [], access);
  const at = ctx.clock.now().toISOString();
  const menu: Menu = {
    id: ctx.ids.newId(),
    handle,
    name,
    ...(description ? { description } : {}),
    items,
    revision: 1,
    createdAt: at,
    updatedAt: at,
  };
  await commit(ctx, scope, menu, null);
  return menu;
}

/** Changes a menu; a field left out keeps its value, `items` replaces the whole tree. */
export async function updateMenu(
  ctx: AppContext,
  scope: Scope,
  id: string,
  patch: MenuPatch,
  access: MenuAccess = {},
): Promise<Menu> {
  const handle = patch.handle === undefined ? undefined : checkMenuHandle(patch.handle);
  const name = patch.name === undefined ? undefined : checkMenuName(patch.name);
  const description = checkMenuDescription(patch.description);
  const items =
    patch.items === undefined ? undefined : checkMenuItems(patch.items, () => ctx.ids.newId());
  return writeMenu(ctx, scope, id, patch.revision, access, (current) => {
    const { description: _d, revision: _r, updatedAt: _u, ...kept } = current;
    const nextDescription = patch.description === undefined ? current.description : description;
    return {
      ...kept,
      handle: handle ?? current.handle,
      name: name ?? current.name,
      ...(nextDescription ? { description: nextDescription } : {}),
      items: items ?? current.items,
    };
  });
}

/**
 * Moves one item (and everything under it) to `index` under `parentId` (null: the top level).
 * The reorder a keyboard or a drag makes, without sending the whole tree back.
 */
export async function moveMenuItem(
  ctx: AppContext,
  scope: Scope,
  id: string,
  move: MenuItemMove & { readonly revision?: number },
): Promise<Menu> {
  const { revision, ...where } = move;
  // A move adds no link, so it checks none: anyone who may change the menu may reorder it.
  return writeMenu(ctx, scope, id, revision, {}, (current) => {
    const { revision: _r, updatedAt: _u, ...kept } = current;
    return { ...kept, items: moveItem(current.items, where) };
  });
}

export async function deleteMenu(
  ctx: AppContext,
  scope: Scope,
  id: string,
  revision?: number,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const current = await ctx.store.menus.get(scope, id);
    if (!current) throw new NotFoundError('Menu', id);
    if (revision !== undefined && current.revision !== revision) throw stale(id);
    try {
      await ctx.store.withTransaction(async (tx) => {
        await tx.menus.delete(scope, id, current.revision);
        await tx.outbox.append({
          id: ctx.ids.newId(),
          type: 'menus.changed',
          scope,
          occurredAt: ctx.clock.now().toISOString(),
          menuId: id,
          handle: current.handle,
        });
      });
      return;
    } catch (err) {
      if (!(err instanceof TransactionConflictError)) throw err;
      if (revision !== undefined) throw stale(id);
      if (attempt >= WRITE_ATTEMPTS) throw err;
    }
  }
}

// --- resolution -----------------------------------------------------------

interface LinkSources {
  readonly config: LocaleConfig;
  readonly locale: string;
  /** Published types with a URL pattern, by apiId. */
  readonly types: ReadonlyMap<string, ContentType>;
  readonly entries: ReadonlyMap<string, PublishedEntry>;
  readonly tags: ReadonlyMap<string, Tag>;
  readonly concepts: ReadonlyMap<string, Concept>;
  readonly access: MenuAccess;
}

/** Why a link doesn't resolve, for a preview; null when it does. */
type Dangling = 'unpublished' | 'missing' | 'no_url' | 'hidden';

function resolveLink(
  link: MenuLink,
  src: LinkSources,
): { resolved: ResolvedMenuLink } | { dangling: Dangling } {
  switch (link.type) {
    case 'url':
      return { resolved: { url: link.url, label: link.url } };
    case 'entry': {
      const entry = src.entries.get(link.entryId);
      if (!entry) return { dangling: 'unpublished' };
      // A key limited to some types never learns that the others' entries exist.
      if (!canRead(src.access, entry.contentTypeApiId)) return { dangling: 'hidden' };
      const type = src.types.get(entry.contentTypeApiId);
      const denied = deniedOf(src.access, entry.contentTypeApiId);
      // A URL built from a slug the caller's grant denies would hand them its value.
      if (type?.urlPattern && urlPatternSlugFields(type.urlPattern).some((f) => denied.has(f))) {
        return { dangling: 'hidden' };
      }
      const url = type?.urlPattern
        ? entryUrlPath(
            type.urlPattern,
            { id: entry.entryId, fields: entry.fields },
            src.config,
            src.locale,
          )
        : null;
      if (!type || url === null) return { dangling: 'no_url' };
      const title = denied.has(type.displayField)
        ? undefined
        : resolveFieldsForLocale(entry.fields, src.config, src.locale)[type.displayField];
      return {
        resolved: {
          url,
          label: typeof title === 'string' && title.trim() ? title.trim() : entry.entryId,
          entry: { id: entry.entryId, contentType: entry.contentTypeApiId },
        },
      };
    }
    case 'term': {
      if (link.termKind === 'tag') {
        const tag = src.tags.get(link.termId);
        if (!tag) return { dangling: 'missing' };
        return {
          resolved: {
            url: null,
            label: resolveTermLabel(tag.name, tag.labels, src.config, src.locale),
            term: { kind: 'tag', id: tag.id, slug: tag.slug },
          },
        };
      }
      const concept = src.concepts.get(link.termId);
      if (!concept) return { dangling: 'missing' };
      return {
        resolved: {
          url: null,
          label: resolveTermLabel(concept.prefLabel, concept.labels, src.config, src.locale),
          term: { kind: 'concept', id: concept.id, slug: concept.slug, schemeId: concept.schemeId },
        },
      };
    }
  }
}

const sourcesOf = (
  config: LocaleConfig,
  locale: string | undefined,
  read: {
    contentTypes: readonly ContentType[];
    entries: readonly PublishedEntry[];
    tags: readonly Tag[];
    concepts: readonly Concept[];
  },
  access: MenuAccess,
): LinkSources => ({
  config,
  locale: locale || config.defaultLocale,
  // As `GET …/routes` serves them: a front end routes by the published type's pattern.
  types: new Map(
    read.contentTypes
      .filter((t) => t.status === 'published' && t.urlPattern)
      .map((t) => [t.apiId, t]),
  ),
  entries: new Map(read.entries.map((e) => [e.entryId, e])),
  tags: new Map(read.tags.map((t) => [t.id, t])),
  concepts: new Map(read.concepts.map((c) => [c.id, c])),
  access,
});

// --- delivery -------------------------------------------------------------

/** A menu as Delivery serves it: resolved for one locale. */
export interface DeliveredMenu {
  readonly handle: string;
  readonly name: string;
  readonly description?: string;
  readonly locale: string;
  readonly items: DeliveredMenuItem[];
}

/** A menu as Delivery lists it: enough to know which to ask for. */
export interface DeliveredMenuSummary {
  readonly handle: string;
  readonly name: string;
  readonly description?: string;
}

export interface MenuDeliveryOptions extends MenuAccess {
  /** Labels, slugs and paths in this locale (with the space's fallbacks); default the default. */
  readonly locale?: string;
  readonly reads?: DeliveryReads;
}

/** Every menu's handle and name, by handle. */
export async function listDeliveredMenus(
  ctx: AppContext,
  scope: Scope,
): Promise<DeliveredMenuSummary[]> {
  return (await ctx.store.menus.all(scope)).map((m) => ({
    handle: m.handle,
    name: m.name,
    ...(m.description ? { description: m.description } : {}),
  }));
}

/**
 * One menu resolved for delivery, in one store read: entry links become the published entry's
 * path (its type's URL pattern), term links the term's label and slug, and an item whose link
 * doesn't resolve (unpublished, deleted, no URL in the locale, a type the key can't read) is
 * dropped with its children lifted into its place. A handle no menu has is a NotFoundError.
 */
export async function getDeliveredMenu(
  ctx: AppContext,
  scope: Scope,
  handle: string,
  opts: MenuDeliveryOptions = {},
): Promise<DeliveredMenu> {
  const read = await (opts.reads ?? deliveryReads(ctx)).read(scope, {
    config: true,
    contentTypes: true,
    menu: { handle },
  });
  if (!read.config) throw new NotFoundError('Space', scope.spaceId);
  assertDeliveredLocale(read.config, opts.locale);
  if (!read.menu) throw new NotFoundError('Menu', handle);
  const { menu, entries, tags, concepts } = read.menu;
  const src = sourcesOf(
    read.config,
    opts.locale,
    { contentTypes: read.contentTypes ?? [], entries, tags, concepts },
    opts,
  );
  return {
    handle: menu.handle,
    name: menu.name,
    ...(menu.description ? { description: menu.description } : {}),
    locale: src.locale,
    items: resolveMenuItems(menu.items, (link) => {
      const r = resolveLink(link, src);
      return 'resolved' in r ? r.resolved : null;
    }),
  };
}

// --- preview --------------------------------------------------------------

/** An item as the editor sees it: what Delivery would serve, or why it serves nothing. */
export interface MenuItemPreview {
  readonly id: string;
  readonly link: MenuLink;
  /** The label Delivery serves, or (for an item it drops) the best one known. */
  readonly label: string;
  readonly url: string | null;
  /**
   * `live`: Delivery serves it. Otherwise it is dropped (its children lifted): `unpublished`
   * (the entry isn't published), `missing` (the entry or term is gone), `no_url` (its type has no
   * published URL pattern, or the slug has no value in this locale), `hidden` (a content type,
   * or a field its URL names, the caller's grants don't let them read).
   */
  readonly status: 'live' | 'unpublished' | 'missing' | 'no_url' | 'hidden';
  readonly children: readonly MenuItemPreview[];
}

export interface MenuPreview {
  readonly menu: Menu;
  readonly locale: string;
  readonly items: readonly MenuItemPreview[];
}

/**
 * A menu with each item checked as Delivery would resolve it now, without dropping anything: what
 * an editor (or an agent) reads to see why an item isn't showing.
 */
export async function previewMenu(
  ctx: AppContext,
  scope: Scope,
  id: string,
  locale?: string,
  access: MenuAccess = {},
): Promise<MenuPreview> {
  const menu = await getMenu(ctx, scope, id);
  const targets = menuTargets(menu.items);
  const wants = (kind: TermKind) => targets.terms.some((t) => t.kind === kind);
  const hasEntries = targets.entryIds.length > 0;
  const [config, contentTypes, published, current, tags, concepts] = await Promise.all([
    ctx.store.spaces.getConfig(scope),
    // As Delivery resolves it: the published view, or a live type's draft would say `no_url`.
    hasEntries
      ? deliveryReads(ctx)
          .read(scope, { contentTypes: true })
          .then((read) => read.contentTypes ?? [])
      : [],
    hasEntries ? ctx.store.entries.getPublishedMany(scope, targets.entryIds) : [],
    hasEntries ? ctx.store.entries.getMany(scope, targets.entryIds) : [],
    wants('tag') ? ctx.store.taxonomy.listTags(scope) : [],
    wants('concept') ? ctx.store.taxonomy.listConcepts(scope) : [],
  ]);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  const src = sourcesOf(
    config,
    locale,
    { contentTypes, entries: published, tags, concepts },
    access,
  );
  const drafts = new Map(current.map((e) => [e.entry.id, e]));
  const typeByApiId = new Map(contentTypes.map((t) => [t.apiId, t]));
  const draftTitle = (entryId: string): string | undefined => {
    const e = drafts.get(entryId);
    const type = e && typeByApiId.get(e.entry.contentTypeApiId);
    if (!e || !type || !canRead(access, type.apiId)) return undefined;
    if (deniedOf(access, type.apiId).has(type.displayField)) return undefined;
    const title = resolveFieldsForLocale(e.fields, config, src.locale)[type.displayField];
    return typeof title === 'string' && title.trim() ? title.trim() : undefined;
  };
  const walk = (items: readonly MenuItem[]): MenuItemPreview[] =>
    items.map((item) => {
      const r = resolveLink(item.link, src);
      const children = walk(item.children);
      if ('resolved' in r) {
        return {
          id: item.id,
          link: item.link,
          label: item.label ?? r.resolved.label,
          url: r.resolved.url,
          status: 'live' as const,
          children,
        };
      }
      const entryId = item.link.type === 'entry' ? item.link.entryId : undefined;
      const draft = entryId ? drafts.get(entryId) : undefined;
      const status: MenuItemPreview['status'] =
        r.dangling !== 'unpublished'
          ? r.dangling
          : !draft
            ? 'missing'
            : canRead(access, draft.entry.contentTypeApiId)
              ? 'unpublished'
              : 'hidden';
      return {
        id: item.id,
        link: item.link,
        label: item.label ?? (entryId ? (draftTitle(entryId) ?? entryId) : ''),
        url: null,
        status,
        children,
      };
    });
  return { menu, locale: src.locale, items: walk(menu.items) };
}
