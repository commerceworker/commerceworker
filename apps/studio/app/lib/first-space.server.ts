/**
 * Whether the deployment has no space yet, as a deployment admin sees it (`GET /spaces` over the
 * api binding, signed for them and this path): `/` then sends them to set up the first one.
 */

import { principalTarget } from '@commerceworker/security/principal';
import { api } from './env.server';
import { setPrincipalHeader } from './principal.server';
import type { Principal } from './roles';

/** True only when the api answered with no spaces; a failure counts as "has some", never as setup. */
export async function hasNoSpaces(me: Principal): Promise<boolean> {
  try {
    const headers = new Headers();
    await setPrincipalHeader(
      headers,
      { ...me, email: me.email ?? '' },
      principalTarget('GET', '/spaces'),
    );
    const res = await api().fetch('https://api/spaces', { headers });
    if (!res.ok) return false;
    const body = (await res.json()) as { items?: unknown[] };
    return Array.isArray(body.items) && body.items.length === 0;
  } catch {
    return false;
  }
}
