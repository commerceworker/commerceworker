/**
 * The storefront's root (`/`). There is no shop to browse here: a buyer arrives by a link (a
 * checkout, a cart, a receipt, a sign-in), so someone who opens the bare host gets the store's name,
 * the way to their account, and what to open instead. Plain links, no loader and no script.
 */
import { Link } from 'react-router';
import { AccountShell, accountButton } from '~/components/account-shell';
import { storeNameOf } from '~/lib/store-name';
import type { Route } from './+types/home';

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: storeNameOf(matches) ?? 'Your account' },
  { name: 'robots', content: 'noindex' },
];

export default function HomePage() {
  return (
    <AccountShell>
      <h1 className="text-xl tracking-title">Your orders</h1>
      <p className="mt-2 text-muted-foreground">
        Sign in with your email to see your orders and saved addresses. No password needed.
      </p>
      {/* `/account` sends anyone not signed in on to sign-in, and a signed-in shopper straight in. */}
      <Link to="/account" className={`${accountButton} mt-6`}>
        Go to your orders
      </Link>
      <p className="mt-6 text-muted-foreground text-sm">
        Checking out or finishing a cart? Open the link you were sent.
      </p>
    </AccountShell>
  );
}
