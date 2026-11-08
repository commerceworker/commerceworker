/**
 * Workspace settings (through the workspace port, `workspaceStore`). Every page load checks them, and they change
 * rarely, so each isolate keeps what it read for a short while.
 */

import { env } from 'cloudflare:workers';
import {
  APPROVAL_SEPARATION_KEY,
  ASSISTANT_ROUTING_KEY,
  type Principal,
} from '@commerceworker/core';
import { audit } from './audit.server';
import { readSsoSettings, type SsoSettings } from './sso';
import {
  DEFAULT_TWO_FACTOR,
  isTwoFactorRequirement,
  type TwoFactorRequirement,
} from './two-factor';
import { workspaceStore } from './wire.server';

const KEY = 'two_factor_required';
const CACHE_MS = 30_000;

let cached: { value: TwoFactorRequirement; at: number } | null = null;

/**
 * Which roles must use two-factor sign-in. Until an admin chooses, operators and admins must: the
 * roles that can change orders, flows and the team.
 */
export async function twoFactorRequirement(): Promise<TwoFactorRequirement> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = await workspaceStore().setting(KEY);
  const requirement = isTwoFactorRequirement(value) ? value : DEFAULT_TWO_FACTOR;
  cached = { value: requirement, at: Date.now() };
  return requirement;
}

export async function setTwoFactorRequirement(
  request: Request,
  by: Principal,
  next: TwoFactorRequirement,
) {
  const from = await twoFactorRequirement();
  if (from === next) return;
  const updatedBy = by.email ?? by.name;
  await workspaceStore().setSetting(KEY, next, updatedBy);
  cached = { value: next, at: Date.now() };
  await audit(request, 'team.two_factor_requirement', { actor: by, detail: { from, to: next } });
}

/**
 * Whether the assistant routes a typed request that is one exact call without the chat model,
 * when Clef is sure (`routing.ts` in the engine, which reads the same row); off until an admin
 * turns it on. Read fresh: the Team page shows what a change just set.
 */
export async function assistantRouting(): Promise<boolean> {
  const value = await workspaceStore().setting(ASSISTANT_ROUTING_KEY);
  return value === 'on';
}

let separation: { value: boolean; at: number } | null = null;

/**
 * Whether whoever started an order is kept from deciding its approvals (`ownOrderRefusal`); off
 * until an admin turns it on. The engine reads the same row when a decision arrives.
 */
export async function approvalSeparation(): Promise<boolean> {
  if (separation && Date.now() - separation.at < CACHE_MS) return separation.value;
  const value = await workspaceStore().setting(APPROVAL_SEPARATION_KEY);
  separation = { value: value === 'on', at: Date.now() };
  return separation.value;
}

const SSO_KEY = 'sso';
let sso: { value: SsoSettings; at: number } | null = null;

/** How single sign-on adds people and whether it is the only way in (`sso.ts`). */
export async function ssoSettings(): Promise<SsoSettings> {
  if (sso && Date.now() - sso.at < CACHE_MS) return sso.value;
  const value = await workspaceStore().setting(SSO_KEY);
  sso = { value: readSsoSettings(value), at: Date.now() };
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
  await workspaceStore().setSetting(SSO_KEY, value, updatedBy);
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
