/**
 * The consent page for MCP, A2A and REST API clients (see lib/oauth.server.ts). The person signs in as usual
 * (two-factor included), sees which app is asking and where its access will be sent, and grants
 * it a role no higher than their own. The provider's consent helpers bind the form to this
 * browser, make it single-use and forbid framing.
 */

import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type ConsentDescription,
} from '@cloudflare/workers-oauth-provider';
import { atLeast, isRole, ROLES, type Role } from '@commerceworker/core';
import { CONSENT_HEADER } from '@commerceworker/security/csp';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@commerceworker/ui/card';
import { FieldError, FieldGroup } from '@commerceworker/ui/field';
import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { data, Form, Link, useActionData, useLoaderData, useLocation } from 'react-router';
import { Mark } from '~/components/mark';
import { grantable, RoleChoices } from '~/components/role-choices';
import { StepUpField } from '~/components/step-up-field';
import { audit } from '~/lib/audit.server';
import {
  authenticatedAt,
  type GrantProps,
  requireUser,
  type StepUpMethod,
  stepUp,
  stepUpMethod,
} from '~/lib/auth.server';
import { channelOf, oauthApi } from '~/lib/oauth.server';
import { DEVICE_REDIRECT } from '~/lib/oauth-device.server';
import type { Route } from './+types/oauth-authorize';

export const meta = ({ loaderData: d }: Route.MetaArgs) => [
  {
    title:
      d && 'error' in d
        ? 'Can’t connect this app · CommerceWorker'
        : 'Connect an app · CommerceWorker',
  },
];

/** The consent cookie and anti-framing headers from the loader, and the redirect's cookies. */
export const headers: Route.HeadersFunction = ({ loaderHeaders, actionHeaders }) => {
  const h = new Headers(loaderHeaders);
  actionHeaders.forEach((v, k) => {
    h.append(k, v);
  });
  return h;
};

/**
 * A refused request in words a person can act on. Only the error's code is shown beside it, for
 * whoever builds the app.
 */
function explain(err: AuthorizationError): string {
  const d = err.description.toLowerCase();
  if (d.includes('client'))
    return 'CommerceWorker doesn’t recognise the app that sent you here, so it can’t tell who is asking.';
  if (d.includes('redirect'))
    return 'The app’s return address doesn’t match the one it registered, so CommerceWorker won’t send it access.';
  if (err.code === 'invalid_target')
    return 'The app asked for access to something CommerceWorker doesn’t offer.';
  if (err.code === 'temporarily_unavailable' || err.code === 'server_error')
    return 'CommerceWorker couldn’t finish this just now. Try again in a moment.';
  return 'This connection link is incomplete or has expired.';
}

/**
 * Where a person goes once they have answered: a `303`, so the browser follows it with a GET
 * whatever the method that led here (OAuth 2.1 §4.1.2; a `302` after a POST is left to the browser).
 */
const seeOther = (location: string, headers?: Headers) => {
  const h = new Headers(headers);
  h.set('location', location);
  return new Response(null, { status: 303, headers: h });
};

/** What the provider refused, as a page; never a redirect to an unverified client. */
function refusal(err: unknown) {
  if (err instanceof AuthorizationError && err.redirectTo) return seeOther(err.redirectTo);
  // Only the error's code is shown: the provider's own description can carry what the client sent.
  if (err instanceof AuthorizationError)
    return data({ error: explain(err), detail: err.code }, { status: 400 });
  if (err instanceof CimdFetchError)
    return data(
      {
        error: 'CommerceWorker couldn’t check who published this app. Try again later.',
        detail: 'client_metadata_unavailable',
      },
      { status: 400 },
    );
  throw err;
}

/**
 * What the app asked about how recently the person signed in, read from the raw URL (the
 * provider's parser passes neither on): `prompt=login` (OpenID Connect Core §3.1.2.1) and
 * `max_age`, in seconds. `next` is this request without them, for the person to come back to once
 * they have signed in again: that sign-in is the answer, and asking again would never end.
 */
function freshnessAsked(url: URL) {
  const prompts = (url.searchParams.get('prompt') ?? '').split(/\s+/).filter(Boolean);
  const raw = url.searchParams.get('max_age');
  // Anything but whole seconds is no age at all, as the specification has it.
  const maxAge = raw !== null && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
  const next = new URL(url);
  next.searchParams.delete('max_age');
  const rest = prompts.filter((p) => p !== 'login');
  if (rest.length) next.searchParams.set('prompt', rest.join(' '));
  else next.searchParams.delete('prompt');
  return { login: prompts.includes('login'), maxAge, next: next.pathname + next.search };
}

/** An age in seconds as a person reads it. */
function ageText(seconds: number) {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.round(seconds / 3600)} hours`;
}

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request);
  const oauth = oauthApi(request);
  try {
    const authRequest = await oauth.parseAuthRequest(request);
    // A device client's return address (lib/oauth-device.server.ts) is for the terminal's code, which
    // is never delivered by a redirect; a browser flow must not mint one for it.
    if (authRequest.redirectUri === DEVICE_REDIRECT)
      return data(
        {
          error: 'This app signs in with a code from a terminal, not a browser link.',
          detail: 'invalid_request',
        },
        { status: 400 },
      );
    // PKCE for every app (RFC 9700 §2.1.1): the provider asks it only of public clients, but a
    // client that registered with a secret can leak its code just the same. The client and its
    // return address are checked by now, so the app is told, as RFC 6749 §4.1.2.1 has it.
    if (!authRequest.codeChallenge)
      return seeOther(
        authorizationErrorRedirect(
          authRequest,
          'invalid_request',
          'PKCE code_challenge is required.',
        ),
      );
    // A person who signed in too long ago for this app, or whom it asked to sign in again, does
    // so before anything is shown or minted. Only a person's session has an age.
    const asked = freshnessAsked(new URL(request.url));
    if (me.kind === 'user' && (asked.login || asked.maxAge !== null)) {
      const at = asked.login ? null : await authenticatedAt(request, me);
      const stale =
        asked.login ||
        at === null ||
        (asked.maxAge !== null && Date.now() - at >= asked.maxAge * 1000);
      if (stale)
        return data({
          reauth: {
            why: asked.login
              ? 'This app asked you to sign in again before it connects.'
              : `This app asked for a sign-in from the last ${ageText(asked.maxAge ?? 0)}.`,
            next: asked.next,
            sso: (await stepUpMethod(me)) === 'sso',
          },
          who: me.email ?? me.name,
          details: await oauth.describeConsent(authRequest),
        });
    }
    // First: a failed lookup leaves nothing behind.
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    // The consent form's answer is a redirect to the app, which Chromium holds to this page's
    // `form-action`: it names the return address's origin, and this page only.
    consent.headers.set(CONSENT_HEADER, authRequest.redirectUri);
    const roles = ROLES.filter((r) => grantable(r) && atLeast(me.role, r));
    return data(
      {
        details,
        handle: consent.handle,
        roles,
        who: me.email ?? me.name,
        channel: channelOf(authRequest.resource),
        stepUp: await stepUpMethod(me),
      },
      {
        headers: consent.headers,
      },
    );
  } catch (err) {
    return refusal(err);
  }
}

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request);
  const oauth = oauthApi(request);
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');
  try {
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return seeOther(denied.redirectTo, denied.headers);
    }
    const role = form.get('role');
    if (!isRole(role) || !grantable(role) || !atLeast(me.role, role))
      return data({ error: 'Choose a role you have yourself.' }, { status: 400 });
    // An app that can act, not just read, keeps access for weeks: confirm it's the person at the
    // keyboard first, before the single-use handle is spent.
    if (me.kind === 'user' && role !== 'viewer') {
      const failed = await stepUp(request, me, {
        code: String(form.get('code') ?? ''),
        password: String(form.get('password') ?? ''),
      });
      if (failed) {
        await audit(request, 'auth.step_up_failed', {
          actor: me,
          detail: { intent: 'oauth-consent', role, error: failed },
        });
        return data({ error: failed }, { status: 403 });
      }
    }
    const approved = await oauth.approveConsent(request, handle, { scope: [role] });
    const client = await oauth.lookupClient(approved.request.clientId);
    const app = client?.clientName || approved.request.clientId;
    const props: GrantProps = { kind: me.kind, id: me.id, role };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: me.id,
      // Shown on the Account page, so two apps with one name can be told apart.
      metadata: {
        app,
        channel: channelOf(approved.request.resource),
        // The host the consent page named (no port), so both pages show the same address.
        host: new URL(approved.request.redirectUri).hostname,
      },
      scope: [role],
      props,
    });
    await audit(request, 'oauth.app_connected', {
      actor: me,
      target: app,
      detail: { role, clientId: approved.request.clientId },
    });
    return seeOther(redirectTo, approved.headers);
  } catch (err) {
    return refusal(err);
  }
}

export default function OAuthAuthorize() {
  const d = useLoaderData<typeof loader>();
  const here = useLocation();
  // Signing out returns here, so the person signs in as themselves and sees this request again.
  const switchAccount = `/logout?next=${encodeURIComponent(here.pathname + here.search)}`;
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4">
      <Card className="w-full max-w-md">
        {'error' in d ? (
          <>
            <CardHeader>
              <Mark className="size-7" />
              <CardTitle className="mt-2">
                <h1 className="font-semibold tracking-title text-2xl">Can’t connect this app</h1>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm">{d.error}</p>
              <p className="text-muted-foreground text-sm">
                Start again from the app you were connecting.
              </p>
              {d.detail ? (
                <p className="font-mono text-muted-foreground text-xs">Details: {d.detail}</p>
              ) : null}
              <Link to="/" className="mt-2 inline-block text-link text-sm hover:underline">
                Go to CommerceWorker
              </Link>
            </CardContent>
          </>
        ) : 'reauth' in d ? (
          <SignInAgain {...d} />
        ) : (
          <Consent {...d} switchAccount={switchAccount} here={here.pathname + here.search} />
        )}
      </Card>
    </main>
  );
}

/**
 * The app wants a recent sign-in. Signing out and back in is one, and so is signing in again at
 * the identity provider for someone who has only that; either comes back to this request, which no
 * longer asks (`freshnessAsked`).
 */
function SignInAgain({
  reauth,
  who,
  details,
}: {
  reauth: { why: string; next: string; sso: boolean };
  who: string;
  details: ConsentDescription;
}) {
  return (
    <>
      <CardHeader>
        <Mark className="size-7" />
        <CardTitle className="mt-2">
          <h1 className="text-balance font-semibold tracking-title text-2xl">Sign in again</h1>
        </CardTitle>
        <CardDescription className="text-foreground">
          {reauth.why} You’re signed in as {who}; it would connect “{details.clientName}”.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {reauth.sso ? (
          <Button asChild>
            <a href={`/login/sso?reauth=1&next=${encodeURIComponent(reauth.next)}`}>
              Sign in again
            </a>
          </Button>
        ) : (
          <Form
            method="post"
            action={`/logout?next=${encodeURIComponent(reauth.next)}`}
            reloadDocument
          >
            <Button type="submit">Sign in again</Button>
          </Form>
        )}
      </CardContent>
    </>
  );
}

function Consent({
  details,
  handle,
  roles,
  who,
  channel,
  switchAccount,
  stepUp,
  here,
}: {
  details: ConsentDescription;
  handle: string;
  roles: Role[];
  who: string;
  channel: string;
  switchAccount: string;
  stepUp: StepUpMethod | null;
  here: string;
}) {
  // React escapes every string below; all of them may come from the client.
  const [sending, setSending] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Role | undefined>(roles[0]);
  const refused = useActionData<typeof action>();
  const kind =
    channel === 'A2A'
      ? 'an agent (A2A)'
      : channel === 'API'
        ? 'a client of the REST API'
        : 'an AI client (MCP)';
  return (
    <>
      <CardHeader>
        <Mark className="size-7" />
        {/* The name is the app's own claim; without a known publisher, say so beside it. */}
        <CardTitle className="mt-2">
          <h1 className="text-balance font-semibold tracking-title text-2xl">
            Connect {details.clientDomain ? details.clientName : `“${details.clientName}”`} to
            CommerceWorker?
          </h1>
        </CardTitle>
        {details.clientDomain ? null : (
          <span className="w-fit rounded-full bg-wait/15 px-1.5 py-0.5 font-medium text-wait text-xs">
            Unverified name
          </span>
        )}
        <CardDescription className="text-foreground">
          {details.clientDomain ? (
            <>
              Published by <strong className="font-medium">{details.clientDomain}</strong>.
            </>
          ) : (
            'This app registered itself; its name is not verified.'
          )}{' '}
          It is {kind}. Access will be sent to{' '}
          <strong className="font-mono font-medium">{details.redirectHost}</strong>.
        </CardDescription>
        <p className="text-muted-foreground text-xs">
          Not {who}?{' '}
          <button type="submit" form="switch-account" className="text-link hover:underline">
            Use a different account
          </button>
        </p>
      </CardHeader>
      <CardContent>
        <Form
          method="post"
          reloadDocument
          onSubmit={(e) => {
            // One decision per page. The buttons stay enabled: a disabled submitter would drop its
            // `decision` from the form, turning Connect into Cancel.
            if (sending) e.preventDefault();
            else
              setSending(
                (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') ?? 'approve',
              );
          }}
        >
          <input type="hidden" name="handle" value={handle} />
          <FieldGroup className="gap-5">
            {details.redirectIsLoopback ? (
              <Alert variant="warning" role="note">
                <TriangleAlert aria-hidden="true" />
                <AlertTitle>This sends access to an app on your computer.</AlertTitle>
                <AlertDescription>
                  Continue only if you just started connecting from it.
                </AlertDescription>
              </Alert>
            ) : null}
            <RoleChoices roles={roles} who={who} channel={channel} onChoose={setChosen} />
            {chosen && chosen !== 'viewer' ? <StepUpField method={stepUp} next={here} /> : null}
            {refused && 'error' in refused ? <FieldError>{refused.error}</FieldError> : null}
            <div className="flex gap-2">
              <Button
                type="submit"
                name="decision"
                value="approve"
                aria-disabled={!!sending || undefined}
              >
                {sending === 'approve' ? 'Connecting…' : 'Connect'}
              </Button>
              <Button
                type="submit"
                name="decision"
                value="deny"
                variant="outline"
                aria-disabled={!!sending || undefined}
              >
                {sending === 'deny' ? 'Cancelling…' : 'Cancel'}
              </Button>
            </div>
          </FieldGroup>
        </Form>
        {/* Signing out is a POST; it comes back here (`next`) to sign in as someone else. */}
        <form id="switch-account" method="post" action={switchAccount} hidden />
      </CardContent>
    </>
  );
}
