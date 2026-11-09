import { SIDEBAR_COOKIE_NAME } from '@commerceworker/ui/sidebar';

/**
 * Whether the sidebar was left open, from the cookie `packages/ui`'s sidebar writes
 * (`SIDEBAR_COOKIE_NAME`), so the server draws it as it was. Open unless that cookie says `false`;
 * matched by its exact name, so another cookie ending in it is not it.
 */
export const sidebarOpenFrom = (request: Request) =>
  !(request.headers.get('Cookie') ?? '').split(/;\s*/).includes(`${SIDEBAR_COOKIE_NAME}=false`);
