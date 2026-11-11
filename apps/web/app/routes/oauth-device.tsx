/**
 * Where a person approves a sign-in from a terminal (the device grant, lib/oauth-device.server.ts).
 * The terminal shows a code and sends them here. The page is built against code phishing (RFC 8628
 * §5.4, RFC 9700): the code is typed or confirmed by the person, never acted on from a link alone,
 * and the next step names the app, the address this page is on, what it will reach and the role.
 * Approving takes a role no higher than the person's own nor than the terminal asked for, and a
 * step-up above viewer, as the consent page does.
 */

import { env } from 'cloudflare:workers';
import { atLeast, isRole, type Role } from '@commerceworker/core';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@commerceworker/ui/card';
import { Field, FieldError, FieldGroup, FieldLabel } from '@commerceworker/ui/field';
import { Input } from '@commerceworker/ui/input';
import { TriangleAlert } from 'lucide-react';
import { data, Form, useActionData, useLoaderData, useLocation, useNavigation } from 'react-router';
import { Mark } from '~/components/mark';
import { grantable, RoleChoices } from '~/components/role-choices';
import { StepUpField } from '~/components/step-up-field';
import { audit, clientIp } from '~/lib/audit.server';
import {
  type Caller,
  requireUser,
  type StepUpMethod,
  stepUp,
  stepUpMethod,
} from '~/lib/auth.server';
import { approveDeviceGrant, channelOf, oauthApi } from '~/lib/oauth.server';
import {
  CLI_CLIENT_ID,
  type DeviceRecord,
  denyDevice,
  failApproval,
  findByUserCode,
  formatUserCode,
  normalizeUserCode,
  pending,
} from '~/lib/oauth-device.server';
import type { Route } from './+types/oauth-device';

export const meta = () => [{ title: 'Sign in from a terminal · CommerceWorker' }];

/** Never framed (a framed approve button is clickjacking) and never cached. */
const GUARD = {
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
};
export const headers: Route.HeadersFunction = ({ loaderHeaders, actionHeaders }) => {
  const h = new Headers(loaderHeaders);
  actionHeaders.forEach((v, k) => {
    h.set(k, v);
  });
  return h;
};

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request);
  const url = new URL(request.url);
  // A link from the terminal brings the person here, and no further: the code in it is not read.
  // They type what their terminal shows (RFC 8628 §5.4), so a link someone else sent them can't
  // be approved by a click.
  return data(
    {
      host: url.host,
      fromLink: url.searchParams.has('user_code'),
      who: me.email ?? me.name,
    },
    { headers: GUARD },
  );
}

type Confirm = {
  step: 'confirm';
  id: string;
  app: string;
  /** The first-party CLI, which the page labels as such; every other client is unverified. */
  official: boolean;
  /** Where and when the terminal asked. */
  startedFrom: { ip: string; place: string | null; at: string };
  clientId: string;
  channel: string;
  resource: string;
  requested: Role;
  roles: Role[];
  stepUp: StepUpMethod | null;
  userCode: string;
  error?: string;
};

const KINDS: Record<string, string> = {
  API: 'the REST API',
  MCP: 'the MCP endpoint',
  A2A: 'the A2A endpoint',
};

const refuse = (error: string, status = 400) =>
  data({ step: 'enter' as const, error }, { status, headers: GUARD });

/** Code entry is open to anyone signed in: bound it per person and per address as well as per miss. */
async function overEntryBudget(request: Request, userId: string) {
  const limiter = (env as Partial<Record<'OAUTH_TOKEN_LIMIT', RateLimit>>).OAUTH_TOKEN_LIMIT;
  // Without the binding only local development goes on; a deployment fails closed.
  if (!limiter) return !import.meta.env.DEV;
  for (const key of [`device-entry:${userId}`, `device-entry-ip:${clientIp(request)}`])
    if (!(await limiter.limit({ key })).success) return true;
  return false;
}

const entered = (code: string) => formatUserCode(normalizeUserCode(code) ?? '');

/** What the person is asked to approve: the app as the client registered it, never as it claims at the poll. */
async function describe(
  request: Request,
  me: Caller,
  id: string,
  record: DeviceRecord,
  userCode: string,
  error?: string,
) {
  const client = await oauthApi(request)
    .lookupClient(record.clientId)
    .catch(() => null);
  return {
    step: 'confirm' as const,
    id,
    app: client?.clientName || record.clientId,
    official: record.clientId === CLI_CLIENT_ID,
    startedFrom: {
      ip: record.origin.ip,
      place: record.origin.place,
      at: new Date(record.origin.at).toISOString(),
    },
    clientId: record.clientId,
    channel: channelOf(record.resource),
    resource: record.resource,
    requested: record.role,
    // No higher than the person's own role, nor than the app asked for.
    roles: (['viewer', 'approver', 'operator'] as const).filter(
      (r) => grantable(r) && atLeast(me.role, r) && atLeast(record.role, r),
    ),
    stepUp: await stepUpMethod(me),
    userCode: entered(userCode),
    ...(error ? { error } : {}),
  } satisfies Confirm;
}

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');

  if (intent === 'lookup') {
    if (await overEntryBudget(request, me.id))
      return refuse('Too many codes entered. Wait a minute and try again.', 429);
    const found = await findByUserCode(String(form.get('user_code') ?? ''), me.id);
    if ('refused' in found)
      return refuse(
        found.refused === 'locked'
          ? 'Too many wrong codes. Wait ten minutes, then start again from your terminal.'
          : 'That code isn’t valid, or it has expired. Check your terminal, or start again from it.',
        found.refused === 'locked' ? 429 : 404,
      );
    const { id, record } = found.found;
    return data(await describe(request, me, id, record, String(form.get('user_code'))), {
      headers: GUARD,
    });
  }

  const id = String(form.get('id') ?? '');
  const record = await pending(id);
  if (!record)
    return refuse(
      'This sign-in has expired or was already decided. Start again from your terminal.',
    );
  const userCode = String(form.get('user_code') ?? '');
  const app =
    (
      await oauthApi(request)
        .lookupClient(record.clientId)
        .catch(() => null)
    )?.clientName || record.clientId;
  // Who asked and from where goes on the decision's row: the start itself isn't audited, as
  // anyone on the internet can make one.
  const detail = {
    clientId: record.clientId,
    resource: record.resource,
    startedAt: new Date(record.origin.at).toISOString(),
    startedFromIp: record.origin.ip,
    ...(record.origin.place ? { startedFromPlace: record.origin.place } : {}),
  };

  if (intent === 'deny') {
    await denyDevice(id, record);
    await audit(request, 'oauth.device.deny', {
      actor: me,
      target: app,
      detail: { ...detail, role: record.role },
    });
    return data({ step: 'denied' as const, app }, { headers: GUARD });
  }
  if (intent !== 'approve') return refuse('Unknown request.');

  const role = form.get('role');
  if (!isRole(role) || !grantable(role) || !atLeast(me.role, role) || !atLeast(record.role, role))
    return data(
      await describe(
        request,
        me,
        id,
        record,
        userCode,
        'Choose a role you have yourself, no higher than the app asked for.',
      ),
      { status: 400, headers: GUARD },
    );
  // Nothing ties this request to this browser (RFC 10027 §6), so every approval, viewer included,
  // first confirms it's the person at the keyboard.
  if (me.kind === 'user') {
    const failed = await stepUp(request, me, {
      code: String(form.get('code') ?? ''),
      password: String(form.get('password') ?? ''),
    });
    if (failed) {
      await audit(request, 'auth.step_up_failed', {
        actor: me,
        detail: { intent: 'oauth-device', role, error: failed },
      });
      // Too many wrong answers burn the code: its holder can't keep guessing at a session.
      if (await failApproval(id, record))
        return refuse(
          'Too many wrong answers. This code is no longer valid; start again from your terminal.',
          403,
        );
      return data(await describe(request, me, id, record, userCode, failed), {
        status: 403,
        headers: GUARD,
      });
    }
  }
  const name = await approveDeviceGrant(request, me, id, record, role);
  await audit(request, 'oauth.device.approve', {
    actor: me,
    target: name,
    detail: { ...detail, role },
  });
  return data({ step: 'approved' as const, app: name, role }, { headers: GUARD });
}

export default function OAuthDevice() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const here = useLocation();
  const switchAccount = `/logout?next=${encodeURIComponent(here.pathname + here.search)}`;
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-safe-4 pt-safe-4 pb-safe-4">
      <Card className="w-full max-w-md">
        {result?.step === 'confirm' ? (
          <ConfirmStep {...result} host={d.host} who={d.who} />
        ) : result?.step === 'approved' ? (
          <Finished
            title="You’re signed in"
            text={`${result.app} can now act as ${d.who}. Go back to your terminal; it finishes on its own. You can disconnect it any time on your Account page.`}
          />
        ) : result?.step === 'denied' ? (
          <Finished
            title="Sign-in denied"
            text={`${result.app} was not given access. You can close this page.`}
          />
        ) : (
          <EnterStep
            host={d.host}
            fromLink={d.fromLink}
            who={d.who}
            error={result && 'error' in result ? result.error : undefined}
            switchAccount={switchAccount}
          />
        )}
      </Card>
    </main>
  );
}

/** UTC, in a fixed format: the server and the browser draw the same text. */
const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

function Finished({ title, text }: { title: string; text: string }) {
  return (
    <>
      <CardHeader>
        <Mark className="size-7" />
        <CardTitle className="mt-2">
          <h1 className="font-semibold tracking-title text-2xl">{title}</h1>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm" role="status">
          {text}
        </p>
      </CardContent>
    </>
  );
}

/** What was sent (a verification link) is shown for checking; it never advances by itself. */
function EnterStep({
  host,
  fromLink,
  who,
  error,
  switchAccount,
}: {
  host: string;
  fromLink: boolean;
  who: string;
  error: string | undefined;
  switchAccount: string;
}) {
  // The navigation is idle again once the answer is in, so a wrong code can be retyped.
  const sending = useNavigation().state === 'submitting';
  return (
    <>
      <CardHeader>
        <Mark className="size-7" />
        <CardTitle className="mt-2">
          <h1 className="text-balance font-semibold tracking-title text-2xl">
            Sign in from a terminal
          </h1>
        </CardTitle>
        <CardDescription className="text-foreground">
          Enter the code your terminal shows. You are on{' '}
          <strong className="font-mono font-medium">{host}</strong>; check that is the address it
          told you to open.
        </CardDescription>
        <p className="text-muted-foreground text-xs">
          Signed in as {who}.{' '}
          <button type="submit" form="switch-account" className="text-link hover:underline">
            Use a different account
          </button>
        </p>
      </CardHeader>
      <CardContent>
        <Form
          method="post"
          onSubmit={(e) => {
            if (sending) e.preventDefault();
          }}
        >
          <input type="hidden" name="intent" value="lookup" />
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="user_code">Code</FieldLabel>
              <Input
                id="user_code"
                name="user_code"
                placeholder="XXXX-XXXX"
                required
                maxLength={12}
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                className="font-mono text-lg uppercase tracking-widest"
              />
            </Field>
            {fromLink ? (
              <p className="text-muted-foreground text-xs">
                A link brought you here, but it doesn’t carry the code: type the one your own
                terminal shows. If you didn’t just start a sign-in there, close this page.
              </p>
            ) : null}
            {error ? <FieldError>{error}</FieldError> : null}
            <Button type="submit" aria-disabled={sending || undefined}>
              Continue
            </Button>
          </FieldGroup>
        </Form>
        <form id="switch-account" method="post" action={switchAccount} hidden />
      </CardContent>
    </>
  );
}

function ConfirmStep(c: Confirm & { host: string; who: string }) {
  // Idle again once the answer is in, so a wrong step-up answer can be corrected and resent.
  const navigation = useNavigation();
  const sending =
    navigation.state === 'submitting' ? String(navigation.formData?.get('intent') ?? '') : null;
  const here = useLocation();
  const error = c.error;
  const checked = c.roles.includes(c.requested) ? c.requested : c.roles[0];
  return (
    <>
      <CardHeader>
        <Mark className="size-7" />
        {/* The name is the app's own claim; without a known publisher, say so beside it. */}
        <CardTitle className="mt-2">
          <h1 className="text-balance font-semibold tracking-title text-2xl">
            Sign {c.official ? 'the official CommerceWorker CLI' : `“${c.app}”`} in to
            CommerceWorker?
          </h1>
        </CardTitle>
        {c.official ? (
          <span className="w-fit rounded-full bg-ok/15 px-1.5 py-0.5 font-medium text-ok text-xs">
            Official CommerceWorker CLI
          </span>
        ) : (
          <span className="w-fit rounded-full bg-wait/15 px-1.5 py-0.5 font-medium text-wait text-xs">
            Unverified name
          </span>
        )}
        <CardDescription className="text-foreground">
          {c.official
            ? 'This is the command-line tool CommerceWorker publishes. Anyone can start a sign-in as it, so check the code and where the request came from.'
            : 'This app registered itself; its name is not verified.'}{' '}
          Its id is <span className="break-all font-mono text-xs">{c.clientId}</span>. It will reach{' '}
          {KINDS[c.channel] ?? 'CommerceWorker'} at{' '}
          <strong className="break-all font-mono font-medium">{c.resource}</strong>, and asked for
          the <strong className="font-medium">{c.requested}</strong> role. You are on{' '}
          <strong className="font-mono font-medium">{c.host}</strong>; the code is{' '}
          <strong className="font-mono font-medium">{c.userCode}</strong>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Alert variant="warning" role="note" className="mb-4">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Approve only a sign-in you started.</AlertTitle>
          <AlertDescription>
            Approve only if you just started this in your own terminal, and the code it shows is{' '}
            {c.userCode}. If someone sent you this code or link, deny it: they may be trying to get
            into your account.
          </AlertDescription>
        </Alert>
        <p className="mb-4 text-muted-foreground text-xs">
          The request came from <span className="font-mono">{c.startedFrom.ip}</span>
          {c.startedFrom.place ? <> (about {c.startedFrom.place})</> : null}, at{' '}
          <time dateTime={c.startedFrom.at}>{utc(c.startedFrom.at)}</time>.
        </p>
        <Form
          method="post"
          onSubmit={(e) => {
            // One decision at a time; a disabled submitter would drop its `intent`.
            if (sending) e.preventDefault();
          }}
        >
          <input type="hidden" name="id" value={c.id} />
          <input type="hidden" name="user_code" value={c.userCode} />
          <FieldGroup className="gap-5">
            <RoleChoices roles={c.roles} who={c.who} channel={c.channel} checked={checked} />
            {/* A code never goes in a URL: after single sign-on they land on the entry step. */}
            <StepUpField method={c.stepUp} next={here.pathname} />
            {error ? <FieldError>{error}</FieldError> : null}
            <div className="flex gap-2">
              <Button
                type="submit"
                name="intent"
                value="approve"
                aria-disabled={!!sending || undefined}
              >
                {sending === 'approve' ? 'Signing in…' : 'Approve'}
              </Button>
              <Button
                type="submit"
                name="intent"
                value="deny"
                variant="outline"
                aria-disabled={!!sending || undefined}
              >
                {sending === 'deny' ? 'Denying…' : 'Deny'}
              </Button>
            </div>
          </FieldGroup>
        </Form>
      </CardContent>
    </>
  );
}
