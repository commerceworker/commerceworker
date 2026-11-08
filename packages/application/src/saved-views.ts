import {
  assertAuthorIdQuery,
  assertQueryRespectsFieldRules,
  authorize,
  authorizeContent,
  ConflictError,
  type ContentType,
  canAccessContentType,
  canSeeSavedView,
  checkSavedViewColumns,
  checkSavedViewName,
  checkSavedViewQuery,
  checkSavedViewVisibility,
  isPersonPrincipal,
  MAX_PERSONAL_VIEWS,
  MAX_SHARED_VIEWS,
  maskDeniedFields,
  NotFoundError,
  ownsSavedView,
  type Principal,
  type SavedView,
  type SavedViewVisibility,
  SCOPES,
  type Scope,
  type ServedSavedView,
  savedViewColumnsAfter,
  savedViewEntryQuery,
  savedViewFor,
  ValidationError,
  withAuthorIdsFor,
} from '@commerceworker/domain';
import { TransactionConflictError } from '@commerceworker/ports';
import { auditActor } from './audit';
import { type AppContext, actingAs } from './context';
import { listPreviewEntryPage, type PreviewEntryPage } from './preview';

/**
 * Saved views of the entries list (see `@commerceworker/domain`'s saved-view module): a person's
 * own, or shared with the space. Every use-case takes the caller's principal, because what a
 * view is depends on who asks: a personal view exists only for its owner (anyone else gets a 404,
 * never a 403 that would say it exists), a view over a type the caller can't read, or naming a
 * field their role hides, exists for no one under that role, and a run is the caller's own query.
 *
 * Reading, running and keeping personal views needs only what reading the entries list needs
 * (`preview:read`, checked by the surfaces). A shared view changes what everyone's views menu
 * offers, so creating one, changing one, or sharing or unsharing a view needs `content:manage`,
 * the scope that shapes the space's model and menus.
 *
 * A view keeps its creator for life. Stopping sharing is therefore the creator's alone: it makes
 * the view theirs again, and it can't be anyone else's, so nobody can take a view from the space
 * for themselves (they can save a copy), and one a key created stays shared until it's deleted.
 */

/** Times an update without a revision reads and saves before giving up to a busier writer. */
const WRITE_ATTEMPTS = 3;

export interface SavedViewInput {
  readonly name: string;
  /** The content type whose entries it lists; absent or null for every type's. */
  readonly contentTypeApiId?: string | null;
  /** Default personal. Only a person has personal views; an API key saves shared ones. */
  readonly visibility?: SavedViewVisibility;
  readonly query?: unknown;
  readonly columns?: unknown;
}

/** A view's changes. Its content type is fixed: a view of another type is another view. */
export interface SavedViewPatch {
  readonly name?: string;
  readonly visibility?: SavedViewVisibility;
  /** Replaces the whole query. */
  readonly query?: unknown;
  /** Replaces the columns; `null` goes back to the default. */
  readonly columns?: unknown;
  /** The revision the change was made against; a view saved since is a conflict. */
  readonly revision?: number;
}

const stale = (id: string) =>
  new ConflictError(
    `Saved view "${id}" was saved by someone else since it was read: read it again`,
  );

/** The view, if `principal` may see it; a 404 otherwise, whatever the reason. */
async function visibleView(
  ctx: AppContext,
  scope: Scope,
  principal: Principal,
  id: string,
): Promise<SavedView> {
  const view = await ctx.store.savedViews.get(scope, id);
  if (!view || !canSeeSavedView(principal, view)) throw new NotFoundError('Saved view', id);
  return view;
}

/** The content type a view names, from this environment; a 422 when it has none of that name. */
async function typeNamed(
  ctx: AppContext,
  scope: Scope,
  apiId: string | null,
): Promise<ContentType | null> {
  if (apiId === null) return null;
  const type = await ctx.store.contentTypes.get(scope, apiId);
  if (!type) {
    throw new ValidationError([
      { field: 'contentTypeApiId', message: `No content type "${apiId}" in this environment` },
    ]);
  }
  return type;
}

/**
 * What a write must hold beyond `preview:read`: a person for a personal view; `content:manage`
 * whenever a shared view is involved (before or after); read on the type; and a query the
 * writer's own field rules allow. A view no one under the writer's role could see is refused.
 */
function authorizeWrite(
  principal: Principal,
  scope: Scope,
  next: Pick<SavedView, 'visibility' | 'contentTypeApiId' | 'query'>,
  before?: SavedView,
): void {
  if (next.visibility === 'shared' || before?.visibility === 'shared') {
    authorize(principal, SCOPES.contentManage, scope.spaceId);
  }
  if (next.visibility === 'personal' && !isPersonPrincipal(principal)) {
    throw new ValidationError([
      {
        field: 'visibility',
        message: 'Only a person has personal views; an API key saves shared views',
      },
    ]);
  }
  if (next.contentTypeApiId) authorizeContent(principal, 'read', next.contentTypeApiId);
  const query = savedViewEntryQuery(next);
  assertQueryRespectsFieldRules(principal, query);
  assertAuthorIdQuery(principal, query);
}

/**
 * Refuses what would take a person past their personal views, or the space past its shared ones.
 * A cap on what they hold, not a guarantee under a race: two writes at once may both pass it,
 * which costs a view over, never a broken one.
 */
async function assertRoomFor(
  ctx: AppContext,
  scope: Scope,
  visibility: SavedViewVisibility,
  owner: string,
): Promise<void> {
  const held = await ctx.store.savedViews.list(scope, visibility === 'personal' ? { owner } : {});
  const count = held.filter(
    (v) => v.visibility === visibility && (visibility === 'shared' || v.createdBy === owner),
  ).length;
  const cap = visibility === 'personal' ? MAX_PERSONAL_VIEWS : MAX_SHARED_VIEWS;
  if (count >= cap) {
    throw new ValidationError([
      {
        field: 'visibility',
        message:
          visibility === 'personal'
            ? `A person keeps at most ${MAX_PERSONAL_VIEWS} personal views in a space`
            : `A space holds at most ${MAX_SHARED_VIEWS} shared views`,
      },
    ]);
  }
}

// --- reads ----------------------------------------------------------------

/**
 * The views `principal` can pick from: the space's shared views and their own, by name, those
 * over a type they can't read or naming a field their role hides left out. With
 * `contentTypeApiId`, that type's views and the views over every type.
 */
export async function listSavedViews(
  ctx: AppContext,
  scope: Scope,
  principal: Principal,
  opts: { readonly contentTypeApiId?: string } = {},
): Promise<ServedSavedView[]> {
  const owner = isPersonPrincipal(principal) ? principal.subject : undefined;
  const views = await ctx.store.savedViews.list(scope, owner ? { owner } : {});
  return views
    .filter(
      (v) =>
        (opts.contentTypeApiId === undefined ||
          v.contentTypeApiId === null ||
          v.contentTypeApiId === opts.contentTypeApiId) &&
        canSeeSavedView(principal, v),
    )
    .map((v) => savedViewFor(principal, v));
}

export async function getSavedView(
  ctx: AppContext,
  scope: Scope,
  principal: Principal,
  id: string,
): Promise<ServedSavedView> {
  return savedViewFor(principal, await visibleView(ctx, scope, principal, id));
}

/** One page of a view's entries, and the query keys it kept but didn't apply. */
export interface SavedViewRun extends Omit<PreviewEntryPage, 'items'> {
  /** The Preview list's rows, without who wrote them for a key that isn't served that. */
  readonly items: readonly (
    | PreviewEntryPage['items'][number]
    | Omit<PreviewEntryPage['items'][number], 'createdBy' | 'updatedBy'>
  )[];
  readonly view: Pick<SavedView, 'id' | 'name' | 'contentTypeApiId' | 'revision'> & {
    readonly columns?: readonly string[];
  };
  /** `query.extra` keys this version doesn't apply: the list is wider than they'd make it. */
  readonly ignored?: readonly string[];
  /**
   * The view's content type isn't in this environment (deleted, or never there): the page is
   * empty for that reason, not because nothing matched.
   */
  readonly typeMissing?: true;
}

/**
 * Runs a view as the caller's own entries query: through the Preview list, with the caller's
 * grants narrowing the types and the caller's field rules masking the fields, never the view
 * creator's. A shared view can therefore show two people two different lists, each what they
 * could have filtered for themselves. Where its content type is missing there is nothing to query:
 * an empty page with `typeMissing`, a fact about this environment rather than a failure, as the
 * same view may run elsewhere.
 */
export async function runSavedView(
  ctx: AppContext,
  scope: Scope,
  principal: Principal,
  id: string,
  opts: { readonly cursor?: string; readonly limit?: number; readonly locale?: string } = {},
): Promise<SavedViewRun> {
  const view = savedViewFor(principal, await visibleView(ctx, scope, principal, id));
  const query = savedViewEntryQuery(view);
  // `visibleView` already checked this; asked again where the query is made, so the gate sits
  // beside what it guards.
  assertQueryRespectsFieldRules(principal, query);
  assertAuthorIdQuery(principal, query);
  const ignored = Object.keys(view.query.extra ?? {});
  const ran = {
    id: view.id,
    name: view.name,
    contentTypeApiId: view.contentTypeApiId,
    revision: view.revision,
    ...(view.columns ? { columns: view.columns } : {}),
  };
  if (view.contentTypeApiId && !(await ctx.store.contentTypes.get(scope, view.contentTypeApiId))) {
    return { view: ran, items: [], typeMissing: true, ...(ignored.length ? { ignored } : {}) };
  }
  const page = await listPreviewEntryPage(
    // Acting as the caller, so a shared view's `sys.createdBy=me` is each reader's own entries.
    actingAs(ctx, principal),
    scope,
    {
      ...query,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.locale ? { locale: opts.locale } : {}),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    },
    {
      ...(opts.locale ? { locale: opts.locale } : {}),
      ...(principal.contentGrants
        ? { readable: (t: string) => canAccessContentType(principal, 'read', t) }
        : {}),
    },
  );
  return {
    view: ran,
    items: page.items
      .filter((e) => canAccessContentType(principal, 'read', e.contentType))
      .map((e) =>
        withAuthorIdsFor(principal, {
          ...e,
          fields: maskDeniedFields(principal, e.contentType, e.fields),
        }),
      ),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(ignored.length ? { ignored } : {}),
  };
}

// --- writes ---------------------------------------------------------------

export async function createSavedView(
  ctx: AppContext,
  scope: Scope,
  principal: Principal,
  input: SavedViewInput,
): Promise<ServedSavedView> {
  const name = checkSavedViewName(input.name);
  const visibility = checkSavedViewVisibility(input.visibility ?? 'personal');
  const contentTypeApiId = input.contentTypeApiId ?? null;
  const query = checkSavedViewQuery(input.query);
  authorizeWrite(principal, scope, { visibility, contentTypeApiId, query });
  const type = await typeNamed(ctx, scope, contentTypeApiId);
  const columns = savedViewColumnsAfter(
    principal,
    { contentTypeApiId },
    checkSavedViewColumns(input.columns, type),
  );
  const createdBy = auditActor(principal);
  await assertRoomFor(ctx, scope, visibility, createdBy);
  const at = ctx.clock.now().toISOString();
  const view: SavedView = {
    id: ctx.ids.newId(),
    name,
    contentTypeApiId,
    visibility,
    createdBy,
    query,
    ...(columns ? { columns } : {}),
    revision: 1,
    createdAt: at,
    updatedAt: at,
  };
  await ctx.store.savedViews.save(scope, view);
  return savedViewFor(principal, view);
}

/**
 * Changes a view: its name, its query, its columns, or who sees it. Fields left out keep their
 * value. Sharing a personal view (or making a shared one personal again) needs `content:manage`,
 * and only the view's creator, a person, can make a shared view personal again. The new visibility
 * has to fit the same caps a new view does. Columns the caller's role hides stay where they are
 * ({@link savedViewColumnsAfter}); `columns: null` needs no content type, so it works where the
 * view's is missing, and any other columns are refused there, with nothing to check them against.
 */
export async function updateSavedView(
  ctx: AppContext,
  scope: Scope,
  principal: Principal,
  id: string,
  patch: SavedViewPatch,
): Promise<ServedSavedView> {
  const name = patch.name === undefined ? undefined : checkSavedViewName(patch.name);
  const visibility =
    patch.visibility === undefined ? undefined : checkSavedViewVisibility(patch.visibility);
  const query = patch.query === undefined ? undefined : checkSavedViewQuery(patch.query);
  for (let attempt = 1; ; attempt++) {
    const current = await visibleView(ctx, scope, principal, id);
    if (patch.revision !== undefined && current.revision !== patch.revision) throw stale(id);
    const nextVisibility = visibility ?? current.visibility;
    const nextQuery = query ?? current.query;
    authorizeWrite(
      principal,
      scope,
      {
        visibility: nextVisibility,
        contentTypeApiId: current.contentTypeApiId,
        query: nextQuery,
      },
      current,
    );
    if (
      current.visibility === 'shared' &&
      nextVisibility === 'personal' &&
      !ownsSavedView(principal, current)
    ) {
      throw new ValidationError([
        {
          field: 'visibility',
          message:
            'Only the person who created a shared view can stop sharing it; save a copy to keep your own',
        },
      ]);
    }
    if (nextVisibility !== current.visibility) {
      await assertRoomFor(ctx, scope, nextVisibility, current.createdBy);
    }
    let columns = current.columns;
    if (patch.columns !== undefined) {
      const given =
        patch.columns === null
          ? undefined
          : checkSavedViewColumns(
              patch.columns,
              await typeNamed(ctx, scope, current.contentTypeApiId),
            );
      columns = savedViewColumnsAfter(principal, current, given);
    }
    const { columns: _c, ...kept } = current;
    const next: SavedView = {
      ...kept,
      name: name ?? current.name,
      visibility: nextVisibility,
      query: nextQuery,
      ...(columns ? { columns } : {}),
      revision: current.revision + 1,
      updatedAt: ctx.clock.now().toISOString(),
    };
    try {
      await ctx.store.savedViews.save(scope, next, current.revision);
      return savedViewFor(principal, next);
    } catch (err) {
      if (!(err instanceof TransactionConflictError)) throw err;
      if (patch.revision !== undefined) throw stale(id);
      if (attempt >= WRITE_ATTEMPTS) throw err;
    }
  }
}

/** Deletes a view: the owner's personal view, or a shared one with `content:manage`. */
export async function deleteSavedView(
  ctx: AppContext,
  scope: Scope,
  principal: Principal,
  id: string,
  revision?: number,
): Promise<void> {
  const current = await visibleView(ctx, scope, principal, id);
  if (current.visibility === 'shared') authorize(principal, SCOPES.contentManage, scope.spaceId);
  if (revision !== undefined && current.revision !== revision) throw stale(id);
  try {
    await ctx.store.savedViews.delete(scope, id, current.revision);
  } catch (err) {
    if (err instanceof TransactionConflictError) throw stale(id);
    throw err;
  }
}
