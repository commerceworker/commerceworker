import type { AccessPolicy } from '@commerceworker/application';

/**
 * How people reach a space in v2: every person signs in to the admin web app (passwords,
 * passkeys, OIDC SSO, SCIM) and acts here through its signed principal. So team members always
 * count as administrators for the last-admin guard; there is no API-side sign-in to opt into.
 */
export const WEB_SIGN_IN: AccessPolicy = { sso: true };
