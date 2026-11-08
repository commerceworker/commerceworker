/**
 * A deployment's setup code: the `SETUP_TOKEN` secret, generated when the deployment is
 * provisioned and handed to the customer's first admin. On `/setup` it creates an admin account
 * with a password they choose, once: the code's hash is recorded when it is used, so it never
 * works twice. With people already on the team, a new code (set by whoever runs the deployment)
 * is the recovery path when no admin can sign in. Every use and every wrong guess is audited, and
 * guesses are throttled per address.
 */

import { env } from 'cloudflare:workers';
import { audit, clientIp } from './audit.server';
import { authEnabled, recordFailure, Throttled, waitFor } from './auth.server';
import { normalizeEmail, secretEqual, sha256Hex } from './credentials';
import { setSsoSettings, ssoSettings } from './settings.server';
import { insertAdmin, type NewAdmin, TeamError } from './team.server';
import { throttleKey } from './throttle';
import { workspaceStore } from './wire.server';

/** The workspace setting holding the SHA-256 of the last setup code used. */
const USED_KEY = 'setup_code_used';

const setupCode = () => (env as { SETUP_TOKEN?: string }).SETUP_TOKEN || undefined;

/** Whether `/setup` can create an admin right now: a code is set and hasn't been used. */
export async function setupOpen(): Promise<boolean> {
  const code = setupCode();
  return !!code && !(await used(code));
}

async function used(code: string) {
  return (await workspaceStore().setting(USED_KEY)) === (await sha256Hex(code));
}

/**
 * Creates an admin from the setup code and returns their id. Throws `TeamError` for a wrong or
 * spent code or a bad account, and `Throttled` after too many wrong codes from one address.
 */
export async function redeemSetupCode(request: Request, given: string, input: NewAdmin) {
  const code = setupCode();
  if (!code) throw new TeamError('This workspace has no setup code. Ask whoever runs it for one.');
  const key = [throttleKey('setup-ip', clientIp(request))];
  const wait = await waitFor(key);
  if (wait) throw new Throttled(wait);
  if (!(await secretEqual(given.trim(), code))) {
    await recordFailure(key);
    await audit(request, 'team.setup_refused', { detail: { reason: 'wrong code' } });
    throw new TeamError('That setup code is not right.');
  }
  const first = !(await authEnabled());
  // Claim the code before creating anyone, so two submissions at once can't both use it.
  const hash = await sha256Hex(code);
  const before = await workspaceStore().setting(USED_KEY);
  if (!(await workspaceStore().claimSetting(USED_KEY, hash, input.email)))
    throw new TeamError(
      'That setup code has been used. Ask whoever runs the workspace for a new one.',
    );
  let id: string;
  try {
    id = await insertAdmin(request, input, first ? 'team.first_admin' : 'team.recovery_admin');
  } catch (err) {
    // Nobody was created (a bad address or password): the code still works.
    await workspaceStore().restoreSetting(USED_KEY, before);
    throw err;
  }
  // Recovering access is for when sign-in is broken, an identity provider included: the new
  // admin signs in with their password, so SSO-only goes off until an admin turns it on again.
  const sso = await ssoSettings();
  if (sso.ssoOnly) {
    const email = normalizeEmail(input.email);
    await setSsoSettings(
      request,
      { kind: 'user', id, email, name: input.name.trim() || email, role: 'admin' },
      { ...sso, ssoOnly: false },
      'setup code',
    );
  }
  return id;
}
