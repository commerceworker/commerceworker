/**
 * The consent page of UCP identity linking (`/identity/authorize`): where a platform sends a
 * shopper to link their address, with the OAuth authorization request in the query (RFC 6749 §4.1.1;
 * PKCE `S256` required). A GET describes the request to a signed-in shopper, writing nothing; a
 * shopper who isn't signed in is sent to sign in and comes back here (`next`). Only the shopper's
 * own POST of the form answers it: the engine checks the request again, mints the one-time code
 * and returns the platform's return address, which this 303s to. A request whose client or return
 * address can't be trusted is shown, never redirected to (RFC 6749 §4.1.2.1). The page is never
 * cached or framed, and its CSP lets the form go on to the platform's address and no other
 * (`CONSENT_HEADER`: Chrome applies `form-action` to the redirect after a post). The Worker refuses
 * a cross-site POST before it gets here, and the cookie is `SameSite=Lax`.
 */

import { LINK_PATHS, type LinkAuthorizeView } from '@commerceworker/core';
import { CONSENT_HEADER } from '@commerceworker/security/csp';
import { Empty } from '@commerceworker/ui/page';
import { Link2Off } from 'lucide-react';
import { data, isRouteErrorResponse, redirect, useLoaderData, useRouteError } from 'react-router';
import { AccountShell, accountButton, accountButtonQuiet } from '~/components/account-shell';
import { engine } from '~/lib/env.server';
import {
  accountHeaders,
  PRIVATE_HEADERS,
  shopperActor,
  shopperSecret,
  signInBudget,
} from '~/lib/shopper.server';
import { pageTitle } from '~/lib/store-name';
import { AUTHORIZE_PARAMS, authorizeParams } from '~/lib/ucp-link.server';
import type { Route } from './+types/identity-authorize';

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: pageTitle(matches, 'Link an account') },
  { name: 'robots', content: 'noindex' },
];

const refusal = (description: string, status = 400) =>
  data(description, { status, headers: PRIVATE_HEADERS });

/** Where to send a shopper who has to sign in first, with this request to come back to. */
const signInThen = (params: Record<string, string>) =>
  redirect(
    `/account/sign-in?next=${encodeURIComponent(`${LINK_PATHS.authorize}?${new URLSearchParams(params)}`)}`,
    { status: 303, headers: PRIVATE_HEADERS },
  );

/**
 * Ends the request for a view the engine refused or deferred: sign in first, back to the
 * platform's error address, or the page's own refusal (thrown, as the loader's other refusals are).
 */
function settle(
  view: Exclude<LinkAuthorizeView, { status: 'consent' }>,
  params: Record<string, string>,
): never {
  if (view.status === 'sign_in') throw signInThen(params);
  if (view.redirect) throw redirect(view.redirect, { status: 303, headers: PRIVATE_HEADERS });
  throw refusal(view.description);
}

export async function loader({ request }: Route.LoaderArgs) {
  const params = authorizeParams(new URL(request.url).searchParams);
  if (!params) throw refusal('This request repeats a parameter.');
  const limited = await signInBudget(request, 'authorize');
  if (limited) throw limited;
  const view = await engine().ucpLinkAuthorize(
    params,
    shopperSecret(request),
    await shopperActor(),
  );
  if (view.status !== 'consent') settle(view, params);
  return data(
    {
      platform: view.platform,
      email: view.email,
      scopes: view.scopes,
      params,
      // Where Allow or Cancel sends them, said before they choose.
      returnTo: new URL(view.redirectUri).origin,
    },
    // The form posts to this address and the engine answers with a redirect to the platform's:
    // the policy must let the form go there.
    { headers: { ...PRIVATE_HEADERS, [CONSENT_HEADER]: view.redirectUri } },
  );
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const decision = form.get('decision');
  if (decision !== 'approve' && decision !== 'deny') throw refusal('Choose Allow or Cancel.');
  const fields = new URLSearchParams();
  for (const name of AUTHORIZE_PARAMS) {
    const v = form.get(name);
    if (typeof v === 'string') fields.set(name, v);
  }
  const params = authorizeParams(fields);
  if (!params) throw refusal('This request is not valid.');
  const limited = await signInBudget(request, 'authorize');
  if (limited) throw limited;
  const done = await engine().ucpLinkDecide(
    params,
    decision === 'approve',
    shopperSecret(request),
    await shopperActor(),
  );
  if (done.status === 'redirect')
    return redirect(done.redirect, { status: 303, headers: PRIVATE_HEADERS });
  return settle(done, params);
}

export function headers({ loaderHeaders, errorHeaders }: Route.HeadersArgs) {
  const out = accountHeaders({ errorHeaders });
  const consent = loaderHeaders.get(CONSENT_HEADER);
  if (consent) out.set(CONSENT_HEADER, consent);
  return out;
}

/** A request that can't go on and has nowhere safe to be sent: what is wrong, and nothing to approve. */
export function ErrorBoundary() {
  const error = useRouteError();
  const said = isRouteErrorResponse(error) && typeof error.data === 'string' ? error.data : null;
  return (
    <main id="main" className="mx-auto max-w-md px-safe-4 py-24 sm:px-safe-6">
      <Empty
        icon={<Link2Off aria-hidden="true" />}
        title={<h1 className="text-xl tracking-title">We couldn’t link this account</h1>}
      >
        {said ?? 'Try again from the app you came from.'}
      </Empty>
    </main>
  );
}

export default function AuthorizePage() {
  const { platform, email, scopes, params, returnTo } = useLoaderData<typeof loader>();
  return (
    <AccountShell>
      <h1 className="break-words text-xl tracking-title">Link {platform} to your account</h1>
      <p className="mt-2 text-muted-foreground">
        <span className="break-words font-medium text-foreground">{platform}</span> is asking to act
        for you at this store, as{' '}
        <span className="break-all font-medium text-foreground">{email}</span>.
      </p>
      <h2 className="mt-6 font-medium text-base">It would be able to</h2>
      <ul className="mt-2 list-disc pl-5">
        {scopes.map((s) => (
          <li key={s.scope}>{s.description}</li>
        ))}
      </ul>
      <p className="mt-4 text-muted-foreground text-sm">
        You’ll return to <span className="break-all font-medium text-foreground">{returnTo}</span>.
        It gets nothing else, and never your sign-in. You can unlink it any time from your account.
      </p>
      {/* A plain form: no script needed. The request goes back with the answer, and is checked again. */}
      <form method="post" className="mt-6 flex flex-col gap-3">
        {Object.entries(params).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <button type="submit" name="decision" value="approve" className={accountButton}>
          Allow
        </button>
        <button type="submit" name="decision" value="deny" className={accountButtonQuiet}>
          Cancel
        </button>
      </form>
    </AccountShell>
  );
}
