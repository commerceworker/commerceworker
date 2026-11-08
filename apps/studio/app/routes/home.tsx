import { redirect } from 'react-router';
import { requireUser } from '~/lib/auth.server';
import { hasNoSpaces } from '~/lib/first-space.server';
import { atLeast } from '~/lib/roles';
import type { Route } from './+types/home';

/**
 * Signed in, `/` is the overview; signed out, `requireUser` sends the browser to sign in. A
 * deployment admin on a deployment with no space yet is sent to set up the first one instead
 * (setup lands here, after two-factor setup when that is due); skipping it goes to `/dashboard`.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request);
  if (atLeast(me.role, 'admin') && (await hasNoSpaces(me))) throw redirect('/setup/space');
  throw redirect('/dashboard');
}

export default function Home() {
  return null;
}
