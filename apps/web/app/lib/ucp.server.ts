/**
 * Agentic checkout over UCP, the admin's part: the platforms an admin lets in and the settings
 * that turn it on. Platforms call the storefront (`apps/storefront/app/lib/ucp.server.ts`), which
 * reads what is registered here from D1 and forwards `/ucp/*` to the engine; a change made here
 * reaches it within its 30 seconds' cache of the settings.
 */

import {
  changeUcpSettings,
  getUcpAdmin,
  revokeUcpPlatform,
} from '@commerceworker/application/commerce';
import { newId, UCP_PLATFORM_KEY_PREFIX, type UcpSettings } from '@commerceworker/core';
import type { z } from 'zod';
import type { platformInput } from './api-schemas';
import { randomToken, sha256Hex } from './credentials';
import { flowStore, ucpStore, workspaceStore } from './wire.server';

const ports = () => ({ workspace: workspaceStore(), flows: flowStore(), ucp: ucpStore() });

/** The settings and platforms the API shows: never a key. */
export const ucpAdmin = () => getUcpAdmin(ports());

/** The key is returned once, here; afterwards only the platform holds it. */
export async function addPlatform(input: z.infer<typeof platformInput>, by: string) {
  const key = `${UCP_PLATFORM_KEY_PREFIX}${randomToken()}`;
  const platform = {
    id: newId('ucp'),
    name: input.name,
    profileUrl: input.profileUrl,
    redirectUris: input.redirectUris,
    keyPrefix: key.slice(0, UCP_PLATFORM_KEY_PREFIX.length + 4),
    createdAt: Date.now(),
    createdBy: by,
  };
  await ucpStore().addPlatform({ ...platform, keyHash: await sha256Hex(key) });
  return { platform: { ...platform, lastUsedAt: null, revokedAt: null }, key };
}

/** Revoked at once. The row stays, so its checkouts and orders still name it. */
export const revokePlatform = (id: string) => revokeUcpPlatform(ports(), id, Date.now());

/** Sets the settings, once their checkout flow can take checkouts. */
export const setUcpSettings = (next: UcpSettings, by: string) =>
  changeUcpSettings(ports(), next, by);
