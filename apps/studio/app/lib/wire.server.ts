/** Studio's auth persistence composition root. Handlers take ports, never tables. */
import { env } from 'cloudflare:workers';
import { createCfEmailSender, type SendEmailBinding } from '@commerceworker/adapters/email-cf';
import type { EmailSender } from '@commerceworker/ports';
import { createAdminAuditLog } from '@commerceworker/store/admin-audit-log';
import { createAdminAuth } from '@commerceworker/store/admin-auth';
import { createAdminPasskeys } from '@commerceworker/store/admin-passkeys';
import { createAdminPasswordResets } from '@commerceworker/store/admin-password-resets';
import { createAdminScimDirectory } from '@commerceworker/store/admin-scim-directory';
import { createAdminSettings } from '@commerceworker/store/admin-settings';
import { createAdminTeam } from '@commerceworker/store/admin-team';

export const adminSettings = () => createAdminSettings(env.DB);

export const adminAuth = () => createAdminAuth(env.DB);

export const adminPasskeys = () => createAdminPasskeys(env.DB);

export const adminTeam = () => createAdminTeam(env.DB);

export const adminPasswordResets = () => createAdminPasswordResets(env.DB);

export const adminScimDirectory = () => createAdminScimDirectory(env.DB);

export const adminAuditLog = () => createAdminAuditLog(env.DB);

type EmailEnv = { EMAIL?: SendEmailBinding; EMAIL_FROM?: string; EMAIL_FROM_NAME?: string };

/**
 * The deployment's email settings, or null when it sends none: an Email Sending `send_email`
 * binding (EMAIL, added per deployment by scripts/fleet.ts when the registry names a sender) and
 * its sender address. A bound EMAIL without EMAIL_FROM is a configuration error, refused with the
 * engine's words (`makeEmail` in packages/platform/src/wire.ts) rather than read as "no email".
 */
function emailSettings(): (EmailEnv & { EMAIL: SendEmailBinding; EMAIL_FROM: string }) | null {
  const e = env as EmailEnv;
  if (!e.EMAIL) return null;
  if (!e.EMAIL_FROM)
    throw new Error(
      'The EMAIL send_email binding is set but EMAIL_FROM is not; set it to an address on a domain onboarded to Email Sending',
    );
  return e as EmailEnv & { EMAIL: SendEmailBinding; EMAIL_FROM: string };
}

/** Whether this deployment sends email. Throws on EMAIL bound without EMAIL_FROM. */
export const sendsEmail = (): boolean => emailSettings() !== null;

/**
 * The `EmailSender` over the EMAIL binding (`@commerceworker/adapters/email-cf`), or undefined
 * when the deployment sends no email. Throws on EMAIL without EMAIL_FROM, and on a sender address
 * the adapter can't use.
 */
export function emailSender(): EmailSender | undefined {
  const e = emailSettings();
  if (!e) return undefined;
  return createCfEmailSender(e.EMAIL, {
    from: e.EMAIL_FROM,
    ...(e.EMAIL_FROM_NAME ? { fromName: e.EMAIL_FROM_NAME } : {}),
  });
}

/** Health probes share the same database and service binding as this invocation. */
export function studioHealthChecks(bindings: Pick<Env, 'DB' | 'API'>) {
  return {
    db: () => bindings.DB.prepare('select 1').first(),
    api: async () => {
      const response = await bindings.API.fetch('https://api/health');
      await response.body?.cancel();
      if (!response.ok) throw new Error('api unhealthy');
    },
  };
}
