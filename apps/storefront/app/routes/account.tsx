/**
 * A signed-in shopper's page (`/account`): who they are signed in as, and sign out. A shopper is
 * the verified email address, so there is nothing else to show yet (their orders come next).
 * Anyone not signed in goes to the sign-in page. Signing out ends the session at the engine, not
 * only the cookie, then clears it. Never cached: it is one person's.
 */

import { data, Form, redirect, useLoaderData } from 'react-router';
import { AccountRefusal } from '~/components/account-refusal';
import { AccountShell, accountButton } from '~/components/account-shell';
import { engine } from '~/lib/env.server';
import {
  accountHeaders,
  clearedShopperCookie,
  currentShopper,
  PRIVATE_HEADERS,
  shopperActor,
  shopperSecret,
} from '~/lib/shopper.server';
import type { Route } from './+types/account';

export const meta = () => [
  { title: 'Your account · CommerceWorker' },
  { name: 'robots', content: 'noindex' },
];

export async function loader({ request }: Route.LoaderArgs) {
  const found = await currentShopper(request);
  if (!found) return redirect('/account/sign-in', { status: 303, headers: PRIVATE_HEADERS });
  return data({ email: found.shopper.email }, { headers: PRIVATE_HEADERS });
}

export async function action({ request }: Route.ActionArgs) {
  const secret = shopperSecret(request);
  if (secret) await engine().shopperSignOut(secret, await shopperActor());
  return redirect('/account/sign-in', {
    status: 303,
    headers: { 'set-cookie': clearedShopperCookie(request), ...PRIVATE_HEADERS },
  });
}

export function headers({ errorHeaders }: Route.HeadersArgs) {
  return accountHeaders({ errorHeaders });
}

export const ErrorBoundary = AccountRefusal;

export default function AccountPage() {
  const { email } = useLoaderData<typeof loader>();
  return (
    <AccountShell>
      <h1 className="text-xl tracking-title">Your account</h1>
      <p className="mt-2 text-muted-foreground">
        Signed in as <span className="break-all font-medium text-foreground">{email}</span>.
      </p>
      <Form method="post" className="mt-6">
        <button type="submit" className={accountButton}>
          Sign out
        </button>
      </Form>
    </AccountShell>
  );
}
