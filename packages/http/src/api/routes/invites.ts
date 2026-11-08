/**
 * Invitations to the admin (deployment-wide, so under `/deployment`, whose principal middleware
 * `managementRoutes` mounts). Managing them needs `space:admin` across the deployment: a deployment
 * administrator signed in to the admin, or the root tokens. The same use-cases back the MCP tools
 * (`invites_list`, `invite_create`, `invite_resend`, `invite_revoke`).
 *
 * `lookup` and `accept` are the web app's sign-up handshake: it calls them as the deployment, for
 * someone holding a link at `/invite/:token`, after its own throttling. The token rides in the
 * body, never a path or query, so the api's own request logs don't carry it (the web Worker moves
 * it out of its URL on the first request, see `routes/invite.tsx`).
 */
import {
  acceptInvite,
  createInvite,
  getInvite,
  listInvites,
  previewInvite,
  resendInvite,
  revokeInvite,
} from '@commerceworker/application';
import { INVITE_MAX_TTL_DAYS, MAX_INVITE_GRANTS } from '@commerceworker/domain';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthDeps, AuthVars } from '../auth';
import { doc } from '../docs/openapi';
import { parseBody, zId } from '../validation';

const zDays = z.number().int().min(1).max(INVITE_MAX_TTL_DAYS);
const zToken = z.string().min(1).max(128);

export const createInviteBody = z.object({
  email: z.string().min(3).max(320),
  role: z.enum(['member', 'admin']).optional(),
  grants: z
    .array(z.object({ space: zId, role: zId }))
    .max(MAX_INVITE_GRANTS)
    .optional()
    .describe(
      'Roles in spaces: a role id or preset name (viewer, approver, editor, manager, admin)',
    ),
  expiresInDays: zDays.optional(),
});
export const resendInviteBody = z.object({ expiresInDays: zDays.optional() });
export const inviteTokenBody = z.object({ token: zToken });
export const acceptInviteBody = z.object({
  token: zToken,
  person: z.object({ subject: zId, email: z.string().min(3).max(320) }),
});

const STATUSES = new Set(['pending', 'accepted', 'revoked', 'expired']);

export function inviteRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, hasher } = deps;
  const link = { ...(deps.inviteOrigin ? { origin: deps.inviteOrigin } : {}) };
  const app = new Hono<AuthVars>();

  app.get(
    '/deployment/invites',
    doc('Auth', 'List invitations to the admin', {
      description:
        'Newest first. `status` narrows them: pending, accepted, revoked or expired (a pending ' +
        'invitation past its expiry). Deployment administrators only. Never includes a token.',
      query: { status: 'pending | accepted | revoked | expired', limit: '1–500 (default 100)' },
    }),
    async (c) => {
      const status = c.req.query('status');
      const limit = Number(c.req.query('limit'));
      const items = await listInvites(ctx, c.get('principal'), {
        ...(status && STATUSES.has(status) ? { status: status as 'pending' } : {}),
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      });
      return c.json({ items });
    },
  );

  app.post(
    '/deployment/invites',
    doc('Auth', 'Invite someone to the admin', {
      body: createInviteBody,
      status: 201,
      description:
        'Invites an email with a deployment role (`member` by default, or `admin`) and roles in ' +
        'spaces. Returns the link (`url`, and its `token`) once: it is stored only as a hash. ' +
        'When the deployment sends email, the link is also emailed. The link works once, for ' +
        '1–30 days (7 by default). Deployment administrators only, and only for what they hold ' +
        'themselves (403 otherwise); an `admin` invitation only from a person signed in to the ' +
        'admin, never a root token. 409 while the address has a pending invitation.',
    }),
    async (c) => {
      const body = await parseBody(c, createInviteBody);
      return c.json(await createInvite(ctx, hasher, c.get('principal'), body, link), 201);
    },
  );

  app.post(
    '/deployment/invites/lookup',
    doc('Auth', 'Read the invitation a link opens', {
      body: inviteTokenBody,
      description:
        'For the page that accepts it: the invitation and the spaces it grants roles in. Any ' +
        'link that no longer works (unknown, used, revoked, expired, resent) is the same 400 ' +
        '`invalid_invite`. Called by the admin web app, as the deployment.',
    }),
    async (c) => {
      const { token } = await parseBody(c, inviteTokenBody);
      return c.json(await previewInvite(ctx, hasher, c.get('principal'), token));
    },
  );

  app.post(
    '/deployment/invites/accept',
    doc('Auth', 'Accept an invitation for a person', {
      body: acceptInviteBody,
      description:
        'Redeems the link for `person` (the web user the admin web app made or signed in, with ' +
        'the address it was sent to): the invitation is accepted and they join each space’s ' +
        'team with its role, at once. Works once; any failure is the same 400 `invalid_invite`.',
    }),
    async (c) => {
      const { token, person } = await parseBody(c, acceptInviteBody);
      return c.json(await acceptInvite(ctx, hasher, c.get('principal'), token, person));
    },
  );

  app.get(
    '/deployment/invites/:id',
    doc('Auth', 'Read one invitation', {
      description: 'Its role, grants and status. Deployment administrators only; never a token.',
    }),
    async (c) => c.json(await getInvite(ctx, c.get('principal'), c.req.param('id'))),
  );

  app.post(
    '/deployment/invites/:id/resend',
    doc('Auth', 'Send a new link for an invitation', {
      body: resendInviteBody,
      description:
        'Issues a new link with a fresh expiry; the old one (shown or emailed) stops working. ' +
        'Returns it once, as creation does.',
    }),
    async (c) => {
      const body = await parseBody(c, resendInviteBody);
      return c.json(
        await resendInvite(ctx, hasher, c.get('principal'), c.req.param('id'), body, link),
      );
    },
  );

  app.post(
    '/deployment/invites/:id/revoke',
    doc('Auth', 'Revoke an invitation', {
      description:
        'Its links stop working. An accepted invitation can’t be revoked (400 `invalid_state`).',
    }),
    async (c) => c.json(await revokeInvite(ctx, c.get('principal'), c.req.param('id'))),
  );

  return app;
}
