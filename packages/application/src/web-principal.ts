import { ForbiddenError, type Principal, scopesForKind } from '@commerceworker/domain';
import type { AppContext } from './context';
import { findMemberForSignIn } from './team';

/** A person signed in to the admin web app, as the web Worker vouches for them. */
export interface WebUser {
  /** Stable user id from the web app (`usr_…`). */
  readonly sub: string;
  readonly email: string;
  /** Deployment role: `admin` runs the deployment (people, SSO, spaces); `member` uses it. */
  readonly role: 'admin' | 'member';
}

/** What a person may do in one space: their role (bound live by grants) and its scopes. */
export interface WebUserAccess {
  readonly spaceId: string;
  /** The team role, when they are on the space's team; absent for a deployment admin who is not. */
  readonly roleId?: string;
  readonly scopes: readonly string[];
  readonly contentGrants?: Principal['contentGrants'];
}

/**
 * A person's access to one space: their team role when they are on its team (refused when
 * disabled), else the full management scope set for a deployment admin, else ForbiddenError.
 */
export async function webUserAccess(
  ctx: AppContext,
  spaceId: string,
  user: WebUser,
): Promise<WebUserAccess> {
  await assertRealSpace(ctx, spaceId);
  const member = await findMemberForSignIn(ctx, spaceId, user.sub, user.email);
  if (member?.disabled) throw new ForbiddenError(`Your access to space ${spaceId} is disabled`);
  if (member?.roleId) {
    const role = await ctx.store.roles.get(spaceId, member.roleId);
    if (role) {
      return {
        spaceId,
        roleId: role.id,
        scopes: role.scopes,
        ...(role.contentGrants ? { contentGrants: role.contentGrants } : {}),
      };
    }
  }
  if (user.role === 'admin') return { spaceId, scopes: [...scopesForKind('cma')] };
  throw new ForbiddenError(`You are not on the team for space ${spaceId}`);
}

/**
 * Refuses the reserved `*` and any space that doesn't exist. Only the deployment's root tokens
 * (ADMIN_TOKEN, MCP_TOKEN) ever act as `*`; a person, and any credential a person mints, is always
 * bound to one real space, so ending their access can find everything they hold.
 */
export async function assertRealSpace(ctx: AppContext, spaceId: string): Promise<void> {
  if (!spaceId || spaceId === '*') throw new ForbiddenError('A space is required');
  const space = await ctx.store.spaces.getConfig({ spaceId, environmentId: 'main' });
  if (!space) throw new ForbiddenError(`No such space ${spaceId}`);
}

/**
 * What a person may grant a long-lived credential (an OAuth grant, a personal access token) in a
 * space: only what their team role holds, and only while they are an enabled member. A deployment
 * admin who is not on the space's team can act there in the admin, but can't mint credentials for
 * it: credentials are re-checked against the team on every use (see `authenticate`), so one that
 * isn't backed by a membership would never work anyway.
 */
export async function memberAccess(
  ctx: AppContext,
  spaceId: string,
  user: WebUser,
): Promise<WebUserAccess & { roleId: string }> {
  const access = await webUserAccess(ctx, spaceId, user);
  if (!access.roleId) {
    throw new ForbiddenError(`Join space ${spaceId}'s team to connect applications to it`);
  }
  return access as WebUserAccess & { roleId: string };
}

/** The spaces a person can act in, for a picker (consent screens, switchers). */
export async function spacesForWebUser(
  ctx: AppContext,
  user: WebUser,
  opts: { membersOnly?: boolean } = {},
): Promise<string[]> {
  const spaces = await ctx.store.spaces.list();
  const out: string[] = [];
  for (const space of spaces) {
    try {
      await (opts.membersOnly ? memberAccess : webUserAccess)(ctx, space.spaceId, user);
      out.push(space.spaceId);
    } catch (err) {
      if (!(err instanceof ForbiddenError)) throw err;
    }
  }
  return out;
}

/**
 * The principal a signed-in person acts as in one space (or across the deployment when the route
 * names no space).
 *
 * Content permissions come from the person's team membership in that space: their role's scopes
 * and per-type/per-field grants, resolved live, exactly as for a delegated API token. A disabled
 * member is refused. A deployment admin who is not on a space's team still administers it, with
 * the full management scope set: someone has to be able to create the first space and add people
 * to it. Everyone else not on the team is refused.
 */
export async function principalForWebUser(
  ctx: AppContext,
  spaceId: string | undefined,
  user: WebUser,
): Promise<Principal> {
  if (!spaceId) {
    // A deployment admin acts across the deployment (creating spaces, people's credentials). A
    // member gets a principal with no space and no scopes: enough to list their own spaces
    // (`spacesForSubject`), refused by every scope check.
    if (user.role !== 'admin') return { spaceId: '', kind: 'user', subject: user.sub, scopes: [] };
    return { spaceId: '*', kind: 'user', subject: user.sub, scopes: [...scopesForKind('cma')] };
  }
  const access = await webUserAccess(ctx, spaceId, user);
  return {
    spaceId,
    kind: 'user',
    subject: user.sub,
    scopes: access.scopes,
    ...(access.contentGrants ? { contentGrants: access.contentGrants } : {}),
  };
}

/** The spaces where `subject` is an enabled team member (a member's space switcher). */
export async function spacesForSubject(ctx: AppContext, subject: string): Promise<string[]> {
  const out: string[] = [];
  for (const space of await ctx.store.spaces.list()) {
    const members = await ctx.store.members.list(space.spaceId);
    if (members.some((m) => m.subject === subject && !m.disabled)) out.push(space.spaceId);
  }
  return out;
}
