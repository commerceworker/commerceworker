import {
  getSchedulerAlerts,
  getSchedulerStatus,
  revokeEverythingFor,
  setSchedulerAlertRecipients,
} from '@commerceworker/application';
import { entryBulkJobsFor, ForbiddenError, inScope } from '@commerceworker/domain';
import { type Context, Hono } from 'hono';
import { type AuthDeps, type AuthVars, principalMiddleware } from '../../auth';
import { doc } from '../../docs/openapi';
import * as authDocs from '../../docs/schemas/auth';
import * as healthDocs from '../../docs/schemas/health';
import { parseBody, schedulerAlertsBody } from '../../validation';

export function deploymentRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- people (deployment-wide) ------------------------------------------
  // The web app calls this, as the deployment admin acting, when it disables, removes or
  // re-secures a person: their sessions are the web app's to end; their tokens live here.
  app.delete(
    '/deployment/people/:subject/credentials',
    doc('Auth', 'Revoke every token a person holds', {
      description:
        'Revokes the OAuth access tokens and grants, personal access tokens and setup credentials ' +
        "held by `subject` (the person's web user id), in every space. Deployment administrators only.",
    }),
    async (c) => {
      const principal = c.get('principal');
      if (principal.spaceId !== '*') throw new ForbiddenError('Deployment administrators only');
      return c.json(await revokeEverythingFor(ctx, c.req.param('subject')));
    },
  );

  // --- scheduler (deployment-wide) ---------------------------------------
  app.get(
    '/deployment/scheduler',
    doc('System', 'Report the engine cron and each sweep', {
      ok: healthDocs.schedulerStatus,
      description:
        'Whether the engine cron is ticking (`stale` once its last tick is more than ' +
        '`staleAfterSeconds` old), and for each sweep it runs (outbox relay, scheduled actions, ' +
        'retention, reseal, bulk and purge recovery, version archive, agent schedules) when it ' +
        'last ran, last succeeded and last failed, with the redacted error. The public ' +
        '`/health` says only `scheduler: ok|stale`. Deployment administrators only.',
    }),
    async (c) => c.json(await getSchedulerStatus(ctx, c.get('principal'))),
  );
  app.get(
    '/deployment/scheduler/alerts',
    doc('System', 'Report the scheduler alerts', {
      ok: healthDocs.schedulerAlerts,
      description:
        'Who is emailed when a sweep goes stale, the sweeps stale now and the last resolved ' +
        'episodes, each with how its emails went. A sweep is stale once it has gone two of its ' +
        'runs without a success (five minutes for the every-minute ones); the cron emails once ' +
        'per episode and once more when it recovers, and once when it ticks again after a gap. ' +
        'Deployment administrators only.',
    }),
    async (c) => c.json(await getSchedulerAlerts(ctx, c.get('principal'))),
  );
  app.put(
    '/deployment/scheduler/alerts',
    doc('System', 'Set who the scheduler alerts email', {
      body: schedulerAlertsBody,
      ok: healthDocs.schedulerAlerts,
      description:
        'Replaces the recipients (at most 50; trimmed, lowercased, deduplicated). An empty list ' +
        'turns the emails off: the engine still logs every episode. The emails need the ' +
        "deployment's Email Sending sender (`email.from` in its registry entry). Deployment " +
        'administrators only.',
    }),
    async (c) => {
      const { recipients } = await parseBody(c, schedulerAlertsBody);
      return c.json(await setSchedulerAlertRecipients(ctx, c.get('principal'), recipients));
    },
  );

  /** Lightweight principal probe for admin connection UI and SSO sessions. */
  const me = (c: Context<AuthVars>) => {
    const principal = c.get('principal');
    return c.json({
      spaceId: principal.spaceId,
      kind: principal.kind,
      scopes: principal.scopes,
      subject: principal.subject,
      restricted: principal.contentGrants !== undefined,
    });
  };
  app.get(
    '/auth/me',
    doc('Auth', 'Resolve the calling principal', { ok: authDocs.principal }),
    principalMiddleware(deps),
    me,
  );
  // The same, resolved in one space: a person's role (and its per-content-type grants) is per
  // space, so this is what the admin asks before offering an action only some roles may take.
  // `/spaces/*` already resolved the principal; a key or person with no standing in this space
  // is refused rather than described.
  app.get(
    '/spaces/:space/auth/me',
    doc('Auth', 'Resolve the calling principal in a space', { ok: authDocs.spacePrincipal }),
    (c) => {
      const principal = c.get('principal');
      if (!inScope(principal, c.req.param('space'))) {
        throw new ForbiddenError('this space');
      }
      return c.json({
        spaceId: principal.spaceId,
        kind: principal.kind,
        scopes: principal.scopes,
        subject: principal.subject,
        restricted: principal.contentGrants !== undefined,
        // The bulk jobs over entries this role may start here (`canRunEntryBulkJob`), as the
        // bulk job routes decide: the admin offers only these.
        bulkJobs: entryBulkJobsFor(principal),
      });
    },
  );

  return app;
}
