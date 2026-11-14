/**
 * Workspace settings in D1 `workspace_settings`. Every page load checks them, and they change
 * rarely, so each isolate keeps what it read for a short while.
 */

import { env } from 'cloudflare:workers';
import { audit } from './audit.server';
import type { Principal } from './roles';
import { readSsoSettings, type SsoSettings } from './sso';
import {
  DEFAULT_TWO_FACTOR,
  isTwoFactorRequirement,
  type TwoFactorRequirement,
} from './two-factor';
import { adminSettings } from './wire.server';

const KEY = 'two_factor_required';
const CACHE_MS = 30_000;

let cached: { value: TwoFactorRequirement; at: number } | null = null;

/**
 * Which roles must use two-factor sign-in. Until an admin chooses, admins must: the role that can
 * change who has access.
 */
export async function twoFactorRequirement(): Promise<TwoFactorRequirement> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const stored = await adminSettings().get(KEY);
  const value = isTwoFactorRequirement(stored) ? stored : DEFAULT_TWO_FACTOR;
  cached = { value, at: Date.now() };
  return value;
}

export async function setTwoFactorRequirement(
  request: Request,
  by: Principal,
  next: TwoFactorRequirement,
) {
  const from = await twoFactorRequirement();
  if (from === next) return;
  const updatedBy = by.email ?? by.name;
  await adminSettings().set({ key: KEY, value: next, updatedAt: Date.now(), updatedBy });
  cached = { value: next, at: Date.now() };
  await audit(request, 'team.two_factor_requirement', { actor: by, detail: { from, to: next } });
}

const SSO_KEY = 'sso';
let sso: { value: SsoSettings; at: number } | null = null;

/** How single sign-on adds people and whether it is the only way in (`sso.ts`). */
export async function ssoSettings(): Promise<SsoSettings> {
  if (sso && Date.now() - sso.at < CACHE_MS) return sso.value;
  const stored = await adminSettings().get(SSO_KEY);
  sso = { value: readSsoSettings(stored), at: Date.now() };
  return sso.value;
}

/**
 * Saves the SSO settings. `via` names how an admin who isn't signed in changed them: a setup code
 * recovering access turns SSO-only off, so a broken identity provider can't lock everyone out.
 */
export async function setSsoSettings(
  request: Request,
  by: Principal,
  next: SsoSettings,
  via?: 'setup code',
) {
  const from = await ssoSettings();
  if (JSON.stringify(from) === JSON.stringify(next)) return;
  const value = JSON.stringify(next);
  const updatedBy = by.email ?? by.name;
  await adminSettings().set({ key: SSO_KEY, value, updatedAt: Date.now(), updatedBy });
  sso = { value: next, at: Date.now() };
  await audit(request, 'team.sso_settings', {
    actor: by,
    detail: { from, to: next, ...(via ? { via } : {}) },
  });
}

/**
 * Whether passwords and passkeys are off right now: admins chose SSO-only and the deployment has
 * an identity provider. Without one, the saved choice can't lock anyone out.
 */
export async function ssoOnlyInEffect(): Promise<boolean> {
  const e = env as { OIDC_ISSUER?: string; OIDC_CLIENT_ID?: string; OIDC_CLIENT_SECRET?: string };
  if (!e.OIDC_ISSUER || !e.OIDC_CLIENT_ID || !e.OIDC_CLIENT_SECRET) return false;
  return (await ssoSettings()).ssoOnly;
}
