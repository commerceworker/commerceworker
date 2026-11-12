/**
 * The platforms a signed-in shopper linked their identity to (`/account/apps`, UCP identity
 * linking): each with when it was linked and one button that unlinks it, which ends the link and
 * every token of it at the engine (`StorefrontRpc.shopperUnlink`; the engine finds the link only
 * among the session's own address's). A plain form post, idempotent.
 */

import { Empty } from '@commerceworker/ui/page';
import { Link2 } from 'lucide-react';
import { data, Form, redirect, useLoaderData } from 'react-router';
import { AccountPageRefusal } from '~/components/account-refusal';
import { accountButtonQuiet, SignedInShell } from '~/components/account-shell';
import { engine } from '~/lib/env.server';
import { accountCall, accountHeaders, PRIVATE_HEADERS, toSignIn } from '~/lib/shopper.server';
import { pageTitle } from '~/lib/store-name';
import type { Route } from './+types/account-apps';

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: pageTitle(matches, 'Linked apps') },
  { name: 'robots', content: 'noindex' },
];

export async function loader({ request }: Route.LoaderArgs) {
  const { secret, actor } = await accountCall(request);
  const found = await engine().shopperLinks(secret, actor);
  if (!found) throw toSignIn();
  return data(found, { headers: PRIVATE_HEADERS });
}

export async function action({ request }: Route.ActionArgs) {
  const { secret, actor } = await accountCall(request);
  const id = (await request.formData()).get('unlink');
  if (typeof id === 'string' && id.length <= 100) await engine().shopperUnlink(secret, id, actor);
  return redirect('/account/apps', { status: 303, headers: PRIVATE_HEADERS });
}

export function headers({ errorHeaders }: Route.HeadersArgs) {
  return accountHeaders({ errorHeaders });
}

export const ErrorBoundary = AccountPageRefusal;

export default function AccountAppsPage() {
  const { email, links } = useLoaderData<typeof loader>();
  return (
    <SignedInShell email={email}>
      <h1 className="text-xl tracking-title">Linked apps</h1>
      <p className="mt-2 text-muted-foreground">
        Apps you allowed to act for you at this store, within what you allowed.
      </p>
      {links.length === 0 ? (
        <Empty
          icon={<Link2 aria-hidden="true" />}
          title={<h2 className="text-lg tracking-title">Nothing linked</h2>}
          className="mt-6"
        >
          An app that asks to link to your account shows here once you allow it.
        </Empty>
      ) : (
        <ul className="mt-4 divide-y border-y">
          {links.map((l) => (
            <li key={l.id} className="flex items-start justify-between gap-4 py-4">
              <p className="min-w-0">
                <span className="block break-words font-medium">{l.platform}</span>
                <span className="block text-muted-foreground text-sm">
                  Linked{' '}
                  {new Date(l.since).toLocaleDateString('en-US', {
                    dateStyle: 'medium',
                    timeZone: 'UTC',
                  })}
                  . Can see your orders.
                </span>
              </p>
              <Form method="post" className="shrink-0">
                <button
                  type="submit"
                  name="unlink"
                  value={l.id}
                  aria-label={`Unlink ${l.platform}`}
                  className={`${accountButtonQuiet} w-auto`}
                >
                  Unlink
                </button>
              </Form>
            </li>
          ))}
        </ul>
      )}
    </SignedInShell>
  );
}
