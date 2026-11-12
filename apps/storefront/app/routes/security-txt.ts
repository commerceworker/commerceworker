/** `/.well-known/security.txt` (RFC 9116): public, no sign-in, no engine call. */

import { securityTxtResponse } from '@commerceworker/security/security-txt';
import type { Route } from './+types/security-txt';

export function loader({ request }: Route.LoaderArgs) {
  return securityTxtResponse(request);
}
