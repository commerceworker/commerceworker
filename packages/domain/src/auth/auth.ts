import { DomainError } from '../errors';
import { ANY_FIELD, type QueryNode, queryNodeFilters } from '../query/query';
import type { RolePreset } from './team';

/** The kind of API key — the CMA/CDA/CPA (management/delivery/preview) split. */
export type ApiKeyKind = 'cma' | 'cda' | 'cpa';

/** Permission scopes. A principal's scopes are checked per operation. */
export const SCOPES = {
  contentWrite: 'content:write',
  contentPublish: 'content:publish',
  contentManage: 'content:manage', // content type definitions
  deliveryRead: 'delivery:read', // published content
  previewRead: 'preview:read', // draft/current content
  searchRead: 'search:read',
  spaceAdmin: 'space:admin', // manage API keys
  /** Decide workflow approvals (the Approver preset and up). */
  workflowApprove: 'workflow:approve',
} as const;
export type PermissionScope = (typeof SCOPES)[keyof typeof SCOPES];

/** Default scope set granted to each key kind. */
export function scopesForKind(kind: ApiKeyKind): PermissionScope[] {
  switch (kind) {
    case 'cma':
      return [
        SCOPES.contentWrite,
        SCOPES.contentPublish,
        SCOPES.contentManage,
        SCOPES.deliveryRead,
        SCOPES.previewRead,
        SCOPES.searchRead,
        SCOPES.spaceAdmin,
        SCOPES.workflowApprove,
      ];
    case 'cda':
      return [SCOPES.deliveryRead, SCOPES.searchRead];
    case 'cpa':
      return [SCOPES.previewRead, SCOPES.deliveryRead, SCOPES.searchRead];
  }
}

/**
 * Content-level actions a role can grant per content type. `read`, `write` and `publish` are listed
 * on a grant; `delete` (trash and purge) and `unpublish` are finer actions a grant holds by
 * implication and can withhold ({@link ContentTypeGrant.deniedActions}).
 */
export type ContentAction = 'read' | 'write' | 'publish' | 'delete' | 'unpublish';

/** The actions a grant lists. */
export type ListedContentAction = 'read' | 'write' | 'publish';

/** The actions a grant holds by implication unless it withholds them. */
export type ImpliedContentAction = 'delete' | 'unpublish';

export const LISTED_CONTENT_ACTIONS: readonly ListedContentAction[] = ['read', 'write', 'publish'];
export const IMPLIED_CONTENT_ACTIONS: readonly ImpliedContentAction[] = ['delete', 'unpublish'];
export const CONTENT_ACTIONS: readonly ContentAction[] = [
  ...LISTED_CONTENT_ACTIONS,
  ...IMPLIED_CONTENT_ACTIONS,
];

/**
 * What each entry operation asks of the grant on the entry's type, all together. Trashing and
 * purging stay a write and a publish (as they were before `delete` existed) and also need `delete`;
 * unpublishing needs `unpublish`, which a grant only holds with `publish`.
 */
export const ENTRY_OPERATION_ACTIONS = {
  trash: ['write', 'delete'],
  purge: ['publish', 'delete'],
  unpublish: ['unpublish'],
} as const satisfies Record<string, readonly ContentAction[]>;

/**
 * Per-content-type grant inside a role. `contentTypeApiId: '*'` matches any
 * type; an exact apiId wins over the wildcard. Field rules refine access:
 * denied fields are masked on read and rejected on write; read-only fields
 * are readable but rejected on write.
 */
export interface ContentTypeGrant {
  readonly contentTypeApiId: string;
  readonly actions: readonly ListedContentAction[];
  /**
   * The finer actions this grant withholds. A grant holds `delete` with `write` or `publish`, and
   * `unpublish` with `publish`, unless it names them here: so every grant stored before these
   * actions existed (none names any) authorizes exactly what it did, and a role can write but not
   * delete, or publish but not unpublish. See {@link grantedActions}.
   */
  readonly deniedActions?: readonly ImpliedContentAction[];
  readonly deniedFields?: readonly string[];
  readonly readOnlyFields?: readonly string[];
}

/** The listed actions each finer one comes with: a grant holds it only beside one of these. */
export const IMPLIED_BY: Readonly<Record<ImpliedContentAction, readonly ListedContentAction[]>> = {
  delete: ['write', 'publish'],
  unpublish: ['publish'],
};

/**
 * True when a grant listing `listed` can hold `action` at all: always for a listed action, and for
 * a finer one only beside an action in {@link IMPLIED_BY}.
 */
export function canHoldAction(
  listed: ReadonlySet<ContentAction> | readonly ContentAction[],
  action: ContentAction,
): boolean {
  const has = (a: ContentAction) =>
    Array.isArray(listed) ? listed.includes(a) : (listed as ReadonlySet<ContentAction>).has(a);
  return action === 'delete' || action === 'unpublish' ? IMPLIED_BY[action].some(has) : true;
}

/**
 * Every action `grant` holds: the ones it lists, plus `delete` (with `write` or `publish`) and
 * `unpublish` (with `publish`) unless it withholds them. The one place grant actions resolve.
 */
export function grantedActions(grant: ContentTypeGrant): ReadonlySet<ContentAction> {
  const held = new Set<ContentAction>(grant.actions);
  const withheld = new Set<ContentAction>(grant.deniedActions ?? []);
  for (const action of IMPLIED_CONTENT_ACTIONS) {
    if (canHoldAction(grant.actions, action) && !withheld.has(action)) held.add(action);
  }
  return held;
}

/**
 * A named, space-scoped permission set assignable to API keys. Roles are the
 * live source of truth: a key with a role resolves the role's scopes and
 * content grants on every request, so editing a role updates every key.
 */
export interface Role {
  readonly id: string;
  readonly spaceId: string;
  readonly name: string;
  readonly description?: string;
  readonly scopes: readonly string[];
  readonly contentGrants: readonly ContentTypeGrant[];
  /**
   * Set on the built-in roles seeded into every space (`viewer` … `admin`, see
   * `ROLE_PRESETS`). A preset role is edited like any other but can't be deleted; a clone of
   * one is an ordinary custom role.
   */
  readonly preset?: RolePreset;
}

/**
 * How a token was issued. All are stored, authenticated and revoked
 * identically — this only records provenance, so the admin can tell an
 * operator-minted key from one an OAuth client obtained. `setup` is the
 * administrator credential first-run setup (or a recovery code) created for a
 * person; it stops authenticating while the space requires SSO sign-in.
 */
export type TokenIssuance = 'key' | 'oauth' | 'pat' | 'setup';

/** A stored API key. The raw token is never persisted — only its hash. */
export interface ApiKey {
  readonly id: string;
  readonly spaceId: string;
  readonly kind: ApiKeyKind;
  /** Optional human-readable label. */
  readonly name?: string;
  readonly hashedToken: string;
  readonly scopes: readonly string[];
  readonly revoked: boolean;
  /** When set, the key's permissions come from this role (live-resolved). */
  readonly roleId?: string;
  /** ISO timestamp of the last successful authentication (optional). */
  readonly lastUsedAt?: string;
  /** ISO timestamp after which the key no longer authenticates (optional). */
  readonly expiresAt?: string;
  /** How this token came into existence. Defaults to `key` when absent. */
  readonly issuance?: TokenIssuance;
  /**
   * The human this token acts for (OIDC subject / PAT owner). Its presence is
   * what makes the resolved principal a `user` rather than a bare key.
   */
  readonly subject?: string;
  /** The OAuth client that obtained this token, when `issuance` is `oauth`. */
  readonly clientId?: string;
}

/** The resolved identity of a request. `spaceId === '*'` is the admin/root scope. */
export interface Principal {
  readonly spaceId: string;
  readonly kind: ApiKeyKind | 'admin' | 'user';
  readonly scopes: readonly string[];
  /**
   * Content-level grants from the principal's role. `undefined` means
   * unrestricted (kind-based keys and the admin token) — every content type
   * and field is allowed at the coarse-scope level.
   */
  readonly contentGrants?: readonly ContentTypeGrant[];
  /** Human identity (OIDC subject or email) when kind is `user`. */
  readonly subject?: string;
  /** Session id for revocation when kind is `user`. */
  readonly sessionId?: string;
  /** The OAuth client acting on the subject's behalf, for audit attribution. */
  readonly clientId?: string;
  /**
   * How a person's bearer token was issued (`oauth`, `pat`, `setup`), when the principal came from
   * one; absent for an operator key, the admin token and a signed-in person.
   */
  readonly issuance?: Exclude<TokenIssuance, 'key'>;
}

/**
 * A bearer a person handed to a program: an OAuth access token or a personal access token. It may
 * act for them, but never mint (or widen) a credential that outlives it.
 */
export function isDelegatedBearer(principal: Principal): boolean {
  return (
    principal.clientId !== undefined ||
    principal.issuance === 'oauth' ||
    principal.issuance === 'pat'
  );
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Invalid or missing credentials') {
    super('unauthorized', message);
  }
}

export class ForbiddenError extends DomainError {
  /**
   * `details` say what was refused where a client can act on it without parsing the message (a
   * field its role makes read-only, how many it can't read); absent, the scope says it all.
   */
  constructor(scope: string, details?: Readonly<Record<string, unknown>>) {
    super('forbidden', `Missing required scope "${scope}"`, details);
  }
}

/**
 * A delegated bearer (see {@link isDelegatedBearer}) tried to mint an API key or widen one. A 403,
 * like a missing scope, but saying what to use instead.
 */
export class DelegatedKeyMintError extends DomainError {
  constructor() {
    super(
      'forbidden',
      "An OAuth or personal access token can't mint an API key or widen one; sign in to the " +
        'admin, or use an operator key',
    );
  }
}

/** True if the principal may act in `targetSpace`. Admin (`*`) may act anywhere. */
export function inScope(principal: Principal, targetSpaceId: string): boolean {
  return principal.spaceId === '*' || principal.spaceId === targetSpaceId;
}

/**
 * Enforces that the principal holds `scope` and is acting within its space.
 * Throws ForbiddenError otherwise. The single authorization decision point.
 */
export function authorize(
  principal: Principal,
  scope: PermissionScope,
  targetSpaceId: string,
): void {
  if (!inScope(principal, targetSpaceId) || !principal.scopes.includes(scope)) {
    throw new ForbiddenError(scope);
  }
}

/** The grant governing `contentTypeApiId` — an exact match wins over `'*'`. */
export function grantFor(
  principal: Principal,
  contentTypeApiId: string,
): ContentTypeGrant | undefined {
  const grants = principal.contentGrants;
  if (!grants) return undefined;
  return (
    grants.find((g) => g.contentTypeApiId === contentTypeApiId) ??
    grants.find((g) => g.contentTypeApiId === '*')
  );
}

/**
 * True when the principal may perform `action` (or every one of `actions`) on the content type.
 */
export function canAccessContentType(
  principal: Principal,
  action: ContentAction | readonly ContentAction[],
  contentTypeApiId: string,
): boolean {
  return missingContentAction(principal, action, contentTypeApiId) === undefined;
}

/** The first of `action` the principal's grant on the type doesn't hold, if any. */
function missingContentAction(
  principal: Principal,
  action: ContentAction | readonly ContentAction[],
  contentTypeApiId: string,
): ContentAction | undefined {
  const wanted: readonly ContentAction[] = typeof action === 'string' ? [action] : action;
  if (!principal.contentGrants) return undefined; // unrestricted principal
  const grant = grantFor(principal, contentTypeApiId);
  const held = grant ? grantedActions(grant) : new Set<ContentAction>();
  return wanted.find((a) => !held.has(a));
}

/**
 * Enforces a content-level grant on top of the coarse scopes. Unrestricted
 * principals (no role) always pass — coarse `authorize` already ran. Given several actions (an
 * {@link ENTRY_OPERATION_ACTIONS} entry), every one must be held.
 */
export function authorizeContent(
  principal: Principal,
  action: ContentAction | readonly ContentAction[],
  contentTypeApiId: string,
): void {
  const missing = missingContentAction(principal, action, contentTypeApiId);
  if (missing) throw new ForbiddenError(`content:${missing}:${contentTypeApiId}`);
}

/**
 * Authorizes moving an entry to the trash: `write` and `delete` on its type. Trashing a live entry
 * also unpublishes it, so a grant that withholds `unpublish` can't take a live entry offline this
 * way either. (A grant without `publish` never held `unpublish`, and trashes live entries as it
 * always has: only an explicit withhold closes this door.)
 */
export function authorizeTrash(
  principal: Principal,
  entry: { readonly contentTypeApiId: string; readonly publishedVersion: number | null },
): void {
  authorizeContent(principal, ENTRY_OPERATION_ACTIONS.trash, entry.contentTypeApiId);
  if (entry.publishedVersion === null || !principal.contentGrants) return;
  if (grantFor(principal, entry.contentTypeApiId)?.deniedActions?.includes('unpublish')) {
    throw new ForbiddenError(`content:unpublish:${entry.contentTypeApiId}`);
  }
}

/**
 * What a bulk job over entries asks of the grant on every type it may touch: the same actions the
 * single-entry operation does (`ENTRY_OPERATION_ACTIONS`), restore being a write.
 */
export const BULK_JOB_CONTENT_ACTIONS = {
  publish: ['publish'],
  unpublish: ['unpublish'],
  trash: ENTRY_OPERATION_ACTIONS.trash,
  restore: ['write'],
  purge: ENTRY_OPERATION_ACTIONS.purge,
} as const satisfies Record<string, readonly ContentAction[]>;

export type EntryBulkJobKind = keyof typeof BULK_JOB_CONTENT_ACTIONS;

export const ENTRY_BULK_JOB_KINDS = Object.keys(BULK_JOB_CONTENT_ACTIONS) as EntryBulkJobKind[];

/**
 * Whether `principal` may start (cancel, or read the report of) a bulk job of `kind` over entries.
 *
 * A job runs over ids of any content type, too many to authorize one by one, and its report names
 * entries of every type; so the role must hold the job's actions on every type alike. That is a
 * principal with no per-type grants at all, or one whose grants are exactly one `*` grant that
 * holds every action `kind` needs (`grantedActions`, so a withheld `delete` counts) and restricts
 * no field: a field rule is per type and per field, which a job can't honour. A trash job is also
 * refused to a grant that withholds `unpublish`, as one trashed entry is (`authorizeTrash`). Any
 * narrower role, or one with an extra type-specific grant, is refused.
 */
export function canRunEntryBulkJob(principal: Principal, kind: EntryBulkJobKind): boolean {
  if (!holdsOnEveryContentType(principal, BULK_JOB_CONTENT_ACTIONS[kind])) return false;
  // As `authorizeTrash`: trashing takes a live entry offline, so a grant that explicitly withholds
  // `unpublish` can't trash in bulk either (a job meets live entries it can't tell apart up front).
  return !(kind === 'trash' && grantFor(principal, '*')?.deniedActions?.includes('unpublish'));
}

/**
 * Whether `principal` holds every one of `actions` on every content type alike: no per-type
 * grants at all, or exactly one `*` grant that holds them (`grantedActions`) and restricts no
 * field. What an operation over the whole environment needs (a bulk job, a snapshot import or
 * export, a clone), since it touches types and fields it can't authorize one by one.
 */
export function holdsOnEveryContentType(
  principal: Principal,
  actions: readonly ContentAction[],
): boolean {
  const grants = principal.contentGrants;
  if (!grants) return true;
  if (grants.length !== 1) return false;
  const [grant] = grants;
  if (!grant || grant.contentTypeApiId !== '*') return false;
  if (grant.deniedFields?.length || grant.readOnlyFields?.length) return false;
  const held = grantedActions(grant);
  return actions.every((a) => held.has(a));
}

/**
 * Enforces {@link holdsOnEveryContentType}: an environment-wide operation (a snapshot export,
 * import or clone, a space export import) reads or writes every type and field there is, the
 * ones it creates included, so a role limited to some types or with field rules is refused.
 */
export function authorizeEveryContentType(
  principal: Principal,
  actions: readonly ContentAction[],
): void {
  if (!holdsOnEveryContentType(principal, actions)) {
    throw new ForbiddenError(`content:${actions.join('+')}:* (on every content type, every field)`);
  }
}

/** The bulk jobs over entries `principal` may run (see {@link canRunEntryBulkJob}). */
export function entryBulkJobsFor(principal: Principal): EntryBulkJobKind[] {
  return ENTRY_BULK_JOB_KINDS.filter((kind) => canRunEntryBulkJob(principal, kind));
}

/** Whether `principal`'s grant on `contentTypeApiId` denies a field or makes one read-only. */
export function hasFieldRules(principal: Principal, contentTypeApiId: string): boolean {
  if (!principal.contentGrants) return false;
  const grant = grantFor(principal, contentTypeApiId);
  return Boolean(grant?.deniedFields?.length || grant?.readOnlyFields?.length);
}

/** The fields `principal` may not read on `contentTypeApiId` (empty when unrestricted). */
export function deniedFieldsFor(principal: Principal, contentTypeApiId: string): readonly string[] {
  if (!principal.contentGrants) return [];
  return grantFor(principal, contentTypeApiId)?.deniedFields ?? [];
}

/** Every field name any of `principal`'s grants denies (for queries that name no type). */
function anyDeniedFields(principal: Principal): ReadonlySet<string> {
  return new Set((principal.contentGrants ?? []).flatMap((g) => g.deniedFields ?? []));
}

/**
 * Refuses a query that would reveal fields the principal may not read. Masking only hides values in
 * the response; a filter (`fields.salary[gt]=100000`), an ordering, a projection or a full-text
 * search evaluated over a hidden field still answers questions about it. So a query naming a
 * denied field is refused, and so is full-text search over a type with denied fields (the match
 * runs over every field and can't be masked per caller), and so is `links_to_entry` for the same
 * reason. Filters inside a `where` tree count like top-level ones, and a component path
 * (`seo.title`) names its top-level field. `sys.*` fields are never field-restricted. No-op
 * for principals without field rules.
 */
export function assertQueryRespectsFieldRules(
  principal: Principal,
  query: {
    readonly contentTypeApiId?: string;
    readonly filters?: readonly { readonly field: string }[];
    readonly where?: QueryNode;
    readonly order?: readonly { readonly field: string }[];
    readonly select?: readonly string[];
    readonly search?: string;
  },
): void {
  if (!principal.contentGrants) return;
  const type = query.contentTypeApiId;
  const denied = type ? new Set(deniedFieldsFor(principal, type)) : anyDeniedFields(principal);
  if (denied.size === 0) return;
  const filtered = [...(query.filters ?? []), ...queryNodeFilters(query.where)].map((f) => f.field);
  // `links_to_entry` looks in every field, the denied ones too: refused like search.
  if (filtered.includes(ANY_FIELD)) throw new ForbiddenError(`content:read:${type ?? '*'}.*`);
  const named = [...filtered, ...(query.order ?? []).map((o) => o.field), ...(query.select ?? [])]
    .filter((f) => !f.startsWith('sys.'))
    .map((f) => f.replace(/^fields\./, '').split('.')[0] as string);
  const hit = named.find((f) => denied.has(f));
  if (hit) throw new ForbiddenError(`content:read:${type ?? '*'}.${hit}`);
  if (query.search) throw new ForbiddenError(`content:search:${type ?? '*'}`);
}

/** The `sys.*` fields that name a person or key: who created an entry and who changed it last. */
export const AUTHOR_ID_FIELDS: readonly string[] = ['sys.createdBy', 'sys.updatedBy'];

/**
 * Whether a principal may read who wrote an entry (`createdBy`, `updatedBy`): a teammate signed in
 * (whatever their role), the admin token, or a key holding a management scope. A preview key (and
 * a preview token) reads drafts for a front end, and a person's or key's id is not its business.
 */
export function seesAuthorIds(principal: Pick<Principal, 'kind' | 'scopes'>): boolean {
  if (principal.kind === 'user' || principal.kind === 'admin') return true;
  return [SCOPES.contentWrite, SCOPES.contentPublish, SCOPES.contentManage, SCOPES.spaceAdmin].some(
    (s) => principal.scopes.includes(s),
  );
}

/**
 * Refuses a query that filters (in `filters` or anywhere in a `where` tree) or orders on
 * {@link AUTHOR_ID_FIELDS} for a principal that doesn't see them (a 400): the answer would reveal
 * what the response leaves out.
 */
export function assertAuthorIdQuery(
  principal: Pick<Principal, 'kind' | 'scopes'>,
  query: {
    readonly filters?: readonly { readonly field: string }[];
    readonly where?: QueryNode;
    readonly order?: readonly { readonly field: string }[];
  },
): void {
  if (seesAuthorIds(principal)) return;
  const named = [...(query.filters ?? []), ...queryNodeFilters(query.where), ...(query.order ?? [])]
    .map((f) => f.field)
    .find((f) => AUTHOR_ID_FIELDS.includes(f));
  if (named) {
    throw new DomainError(
      'author_ids_not_served',
      `${named} is not served to this key: filter and sort on it with a management key`,
    );
  }
}

/** An entry without who wrote it, for a principal that doesn't see that ({@link seesAuthorIds}). */
export function withAuthorIdsFor<
  T extends { readonly createdBy?: unknown; readonly updatedBy?: unknown },
>(principal: Pick<Principal, 'kind' | 'scopes'>, entry: T): T | Omit<T, 'createdBy' | 'updatedBy'> {
  if (seesAuthorIds(principal)) return entry;
  const { createdBy: _c, updatedBy: _u, ...rest } = entry;
  return rest;
}

/**
 * Strips the fields this principal may not read from an entry's field map.
 * Returns the input unchanged for unrestricted principals.
 */
export function maskDeniedFields<T>(
  principal: Principal,
  contentTypeApiId: string,
  fields: Record<string, T>,
): Record<string, T> {
  const denied = grantFor(principal, contentTypeApiId)?.deniedFields;
  if (!principal.contentGrants || !denied?.length) return fields;
  return Object.fromEntries(Object.entries(fields).filter(([apiId]) => !denied.includes(apiId)));
}

/**
 * The fields of a type this principal may not write: those its role denies or makes read-only.
 * Empty for an unrestricted principal.
 */
export function unwritableFieldsFor(
  principal: Principal,
  contentTypeApiId: string,
): readonly string[] {
  if (!principal.contentGrants) return [];
  const grant = grantFor(principal, contentTypeApiId);
  return [...new Set([...(grant?.deniedFields ?? []), ...(grant?.readOnlyFields ?? [])])];
}

/**
 * Enforces field-level write rules: writing a denied or read-only field
 * throws ForbiddenError. No-op for unrestricted principals.
 */
export function assertWritableFields(
  principal: Principal,
  contentTypeApiId: string,
  fields: Record<string, unknown>,
): void {
  const [blocked] = unwritableFields(principal, contentTypeApiId, fields);
  if (blocked) throw new ForbiddenError(`content:write:${contentTypeApiId}.${blocked}`);
}

/**
 * The keys of `fields` that `principal` may not write on `contentTypeApiId` (its grant's denied
 * and read-only fields), in order; empty for unrestricted principals. For a caller that reports a
 * blocked field rather than refusing the call (an import, per record).
 */
export function unwritableFields(
  principal: Principal,
  contentTypeApiId: string,
  fields: Record<string, unknown>,
): string[] {
  if (!principal.contentGrants) return [];
  const grant = grantFor(principal, contentTypeApiId);
  const blocked = new Set([...(grant?.deniedFields ?? []), ...(grant?.readOnlyFields ?? [])]);
  return Object.keys(fields).filter((apiId) => blocked.has(apiId));
}

/**
 * Authorizes deciding an approval whose node asks for `requiredScope`, and returns the content
 * action the decider's role must also grant on the entry's type: `read` for `workflow:approve`
 * (an approver decides what they can see), `publish` for `content:publish`, else `write`.
 */
export function authorizeApproval(
  principal: Principal,
  requiredScope: PermissionScope,
  targetSpaceId: string,
): ContentAction {
  authorize(principal, requiredScope, targetSpaceId);
  if (requiredScope === SCOPES.workflowApprove) return 'read';
  return requiredScope === SCOPES.contentPublish ? 'publish' : 'write';
}
