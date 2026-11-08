import {
  createInvite,
  getInvite,
  listInvites,
  resendInvite,
  revokeInvite,
} from '@commerceworker/application';
import { INVITE_MAX_TTL_DAYS, MAX_INVITE_GRANTS } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, type ToolContext, toolSchema } from './shared';

export function registerInviteTools(server: McpServer, t: ToolContext): void {
  const { deps, ctx, principal } = t;
  // --- invitations (deployment) -------------------------------------------
  // The same use-cases and checks as /deployment/invites: deployment administrators only, and
  // never for more than they hold. Redeeming a link is the web app's sign-up page, not a tool: an
  // agent never holds someone else's invitation.
  const inviteLink = deps.inviteOrigin ? { origin: deps.inviteOrigin } : {};
  const zInviteDays = z.number().int().min(1).max(INVITE_MAX_TTL_DAYS);
  server.registerTool(
    'invites_list',
    {
      description:
        'List invitations to the admin, newest first, optionally by status (pending, accepted, ' +
        'revoked, expired). Deployment administrators only. Never includes a token or link.',
      inputSchema: toolSchema('invites_list', () =>
        z.object({
          status: z.enum(['pending', 'accepted', 'revoked', 'expired']).optional(),
          limit: z.number().int().min(1).max(500).optional(),
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => ok({ items: await listInvites(ctx, principal, args) }),
  );

  server.registerTool(
    'invite_get',
    {
      description: 'Read one invitation (its role, grants and status). Never includes a token.',
      inputSchema: toolSchema('invite_get', () => z.object({ id: z.string() })),
      annotations: { readOnlyHint: true },
    },
    async (args) => ok(await getInvite(ctx, principal, args.id)),
  );

  server.registerTool(
    'invite_create',
    {
      description:
        'Invite an email to the admin with a deployment role (member, the default, or admin) and ' +
        'roles in spaces (a role id or preset name: viewer, approver, editor, manager, admin). ' +
        'Returns the link once (`url`, `token`): hand it to the person; it is also emailed when ' +
        'the deployment sends email. It works once, for 1–30 days (7 by default). Deployment ' +
        'administrators only, and only for roles you hold yourself; the admin role only from a ' +
        'person signed in to the admin, never a root token.',
      inputSchema: toolSchema('invite_create', () =>
        z.object({
          email: z.string().min(3).max(320),
          role: z.enum(['member', 'admin']).optional(),
          grants: z
            .array(
              z.object({ space: z.string().min(1).max(128), role: z.string().min(1).max(128) }),
            )
            .max(MAX_INVITE_GRANTS)
            .optional(),
          expiresInDays: zInviteDays.optional(),
        }),
      ),
    },
    async (args) => ok(await createInvite(ctx, deps.hasher, principal, args, inviteLink)),
  );

  server.registerTool(
    'invite_resend',
    {
      description:
        'Issue a new link for a pending or expired invitation (returned once); the old link stops ' +
        'working.',
      inputSchema: toolSchema('invite_resend', () =>
        z.object({ id: z.string(), expiresInDays: zInviteDays.optional() }),
      ),
    },
    async (args) =>
      ok(
        await resendInvite(
          ctx,
          deps.hasher,
          principal,
          args.id,
          args.expiresInDays ? { expiresInDays: args.expiresInDays } : {},
          inviteLink,
        ),
      ),
  );

  server.registerTool(
    'invite_revoke',
    {
      description: 'Revoke an invitation: its links stop working.',
      inputSchema: toolSchema('invite_revoke', () => z.object({ id: z.string() })),
    },
    async (args) => ok(await revokeInvite(ctx, principal, args.id)),
  );
}
