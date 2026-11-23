import { ORDER_CHANNEL_LABELS, ORDER_CHANNELS, type OrderChannel } from '@commerceworker/core';
import { Ago } from '@commerceworker/ui/ago';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { Checkbox } from '@commerceworker/ui/checkbox';
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@commerceworker/ui/field';
import { Input } from '@commerceworker/ui/input';
import { cn } from '@commerceworker/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Body, Empty, PageHeader, Section } from '@commerceworker/ui/page';
import { Ban, KeyRound, PlugZap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  data,
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from 'react-router';
import { CopyButton } from '~/components/copy-button';
import { FormSheet, useFormSheet } from '~/components/form-sheet';
import { StepUpField } from '~/components/step-up-field';
import { integrationInput } from '~/lib/api-schemas';
import { useAssistant } from '~/lib/assistant';
import { actorName, audit } from '~/lib/audit.server';
import { requireUser, stepUp, stepUpMethod } from '~/lib/auth.server';
import { eventShort, KNOWN_EVENTS } from '~/lib/events';
import { createIntegration, listIntegrations, rotateIntegration } from '~/lib/integrations.server';
import { publishedFlows } from '~/lib/orders.server';
import { SECRET_HEADERS } from '~/lib/secret-response';
import type { Route } from './+types/integrations';

export const meta = () => [{ title: 'Integrations · CommerceWorker' }];

/** A new secret's response is never stored (`SECRET_HEADERS`), a full-page submit included. */
export const headers: Route.HeadersFunction = ({ actionHeaders }) => actionHeaders;

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request, 'admin');
  const [integrations, flows, method] = await Promise.all([
    listIntegrations(),
    publishedFlows(),
    stepUpMethod(me),
  ]);
  return {
    // Live ones first, newest first within each.
    integrations: [...integrations].sort(
      (a, b) => Number(!!a.revokedAt) - Number(!!b.revokedAt) || b.createdAt - a.createdAt,
    ),
    flows: flows.map((f) => ({ id: f.id, name: f.name })),
    stepUp: me.kind === 'user' ? method : undefined,
  };
}

/** A secret shown once, with who it's for. */
type Secret = { label: string; value: string; name: string };

/** Typed-in event keys: commas or spaces between them. */
const typed = (v: FormDataEntryValue | null) =>
  String(v ?? '')
    .split(/[\s,]+/)
    .map((e) => e.trim())
    .filter(Boolean);

/**
 * Creating an integration lets an outside system act on orders, and rotating changes what it
 * signs with; both ask the admin to prove it's them first, as Webhooks and Team do. Revoking goes
 * through the assistant, which asks to confirm (`revoke_integration`).
 */
export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request, 'admin');
  const f = await request.formData();
  const intent = String(f.get('intent') ?? '');
  if (intent !== 'create' && intent !== 'rotate')
    return data({ error: 'That isn’t something this page does.' }, 400);
  // Checked first, so a mistake doesn't spend a one-time code.
  const startOrders = f.get('startOrders') === 'on';
  const parsed =
    intent === 'create'
      ? integrationInput.safeParse({
          name: String(f.get('name') ?? ''),
          events:
            f.get('anyEvent') === 'on'
              ? ['*']
              : [...new Set([...f.getAll('events').map(String), ...typed(f.get('otherEvents'))])],
          startOrders,
          flows: !startOrders
            ? []
            : f.get('anyFlow') === 'on'
              ? ['*']
              : f.getAll('flows').map(String),
          channel: (String(f.get('channel') ?? '') || null) as OrderChannel | null,
        })
      : null;
  if (parsed && !parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return data(
      {
        error:
          field === 'name'
            ? 'Give it a name, up to 100 characters.'
            : field === 'events'
              ? 'An event is up to 100 characters, and it can have up to 50.'
              : 'Check what it may do.',
      },
      400,
    );
  }
  if (parsed?.success && !parsed.data.events.length && !parsed.data.startOrders)
    return data({ error: 'Choose the events it may send, or let it start orders.' }, 400);
  if (me.kind === 'user') {
    const failed = await stepUp(request, me, {
      code: String(f.get('code') ?? ''),
      password: String(f.get('password') ?? ''),
    });
    if (failed) {
      await audit(request, 'auth.step_up_failed', {
        actor: me,
        target: null,
        detail: { intent: `integration.${intent}`, error: failed },
      });
      return data({ error: failed }, 403);
    }
  }
  if (parsed?.success) {
    const created = await createIntegration(parsed.data, actorName(me));
    await audit(request, 'integration.created', {
      actor: me,
      target: created.integration.name,
      detail: { id: created.integration.id, via: 'app' },
    });
    return data(
      {
        secret: {
          label: `Signing secret for ${created.integration.name}`,
          value: created.secret,
          name: created.integration.name,
        } satisfies Secret,
      },
      { headers: SECRET_HEADERS },
    );
  }
  const id = String(f.get('id') ?? '');
  const rotated = await rotateIntegration(id);
  if (!rotated) return data({ error: `No live integration ${id}.` }, 404);
  await audit(request, 'integration.rotated', {
    actor: me,
    target: rotated.integration.name,
    detail: { id, via: 'app' },
  });
  return data(
    {
      secret: {
        label: `New signing secret for ${rotated.integration.name}`,
        value: rotated.secret,
        name: rotated.integration.name,
      } satisfies Secret,
    },
    { headers: SECRET_HEADERS },
  );
}

type Data = Awaited<ReturnType<typeof loader>>;

export default function Integrations() {
  const { integrations, flows, stepUp: method } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const secret = result && 'secret' in result ? result.secret : null;
  const error = result && 'error' in result ? result.error : null;
  const nav = useNavigation();
  const busy = nav.state === 'submitting' && nav.formData?.get('intent') === 'create';
  const sheet = useFormSheet(result, (r) => 'secret' in r);
  const secretRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (secret) secretRef.current?.focus();
  }, [secret]);
  const flowName = new Map(flows.map((f) => [f.id, f.name]));
  return (
    <>
      <PageHeader
        title="Integrations"
        subtitle="Outside systems that send CommerceWorker signed requests: a payment provider recording payments, a partner’s system starting orders. Each has its own secret and may do only what you allow."
        actions={
          <FormSheet
            open={sheet.open}
            onOpenChange={sheet.onOpenChange}
            label="New integration"
            description="It signs each request with its secret, shown once when you add it."
          >
            <NewIntegration
              error={sheet.open ? error : null}
              busy={busy}
              flows={flows}
              stepUp={method}
            />
          </FormSheet>
        }
      />
      <Body className="grid gap-4">
        {secret ? (
          <Alert
            ref={secretRef}
            tabIndex={-1}
            variant="warning"
            role="note"
            className="outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <KeyRound aria-hidden="true" />
            <AlertTitle>{secret.label}</AlertTitle>
            <AlertDescription className="max-w-measure">
              Give it to {secret.name} to sign its requests with. Copy it now: it is shown once and
              stored only encrypted.
            </AlertDescription>
            <div className="col-start-2 mt-2 flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 select-all break-all rounded-sm bg-card px-2 py-1.5 font-mono text-sm">
                {secret.value}
              </code>
              <CopyButton text={secret.value} />
            </div>
          </Alert>
        ) : null}
        {error && !sheet.open ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <Section
          title="Integrations"
          description="What each may do, and when it last sent a signed request."
          flush
        >
          {integrations.length ? (
            <ul className="divide-y">
              {integrations.map((i) => (
                <IntegrationRow key={i.id} i={i} flowName={flowName} stepUp={method} />
              ))}
            </ul>
          ) : (
            <Empty icon={<PlugZap aria-hidden="true" />} title="No integrations yet">
              Add one for each outside system that records events on orders or starts them.
            </Empty>
          )}
        </Section>
      </Body>
    </>
  );
}

function NewIntegration({
  error,
  busy,
  flows,
  stepUp,
}: {
  error: string | null;
  busy: boolean;
  flows: Data['flows'];
  stepUp: Data['stepUp'];
}) {
  const [anyEvent, setAnyEvent] = useState(false);
  const [orders, setOrders] = useState(false);
  const [anyFlow, setAnyFlow] = useState(true);
  return (
    <Form method="post" className="flex flex-col gap-5">
      <input type="hidden" name="intent" value="create" />
      <Field>
        <FieldLabel htmlFor="integration-name">Name</FieldLabel>
        <Input id="integration-name" name="name" required maxLength={100} placeholder="Payments" />
        <FieldDescription>What the system is, as the audit log will name it.</FieldDescription>
      </Field>
      <FieldSet>
        <FieldLegend variant="label">Events it may send</FieldLegend>
        <Check id="integration-any-event" name="anyEvent" checked={anyEvent} onChange={setAnyEvent}>
          Any event
        </Check>
        {anyEvent ? null : (
          <>
            <div className="grid gap-x-4 sm:grid-cols-2">
              {KNOWN_EVENTS.map((e) => (
                <Check key={e} id={`integration-event-${e}`} name="events" value={e}>
                  <span className="font-mono text-xs">{e}</span>
                </Check>
              ))}
            </div>
            <Field>
              <FieldLabel htmlFor="integration-other-events" className="font-normal">
                Others your flows wait for
              </FieldLabel>
              <Input
                id="integration-other-events"
                name="otherEvents"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="carrier.exception, invoice.disputed"
              />
            </Field>
          </>
        )}
      </FieldSet>
      <FieldSet>
        <FieldLegend variant="label">Orders</FieldLegend>
        <Check id="integration-orders" name="startOrders" checked={orders} onChange={setOrders}>
          It may start orders
        </Check>
        {orders ? (
          <>
            <Check id="integration-any-flow" name="anyFlow" checked={anyFlow} onChange={setAnyFlow}>
              On any flow, or the one routing picks
            </Check>
            {anyFlow ? null : (
              <div className="grid gap-x-4 sm:grid-cols-2">
                {flows.map((fl) => (
                  <Check key={fl.id} id={`integration-flow-${fl.id}`} name="flows" value={fl.id}>
                    {fl.name}
                  </Check>
                ))}
              </div>
            )}
          </>
        ) : null}
      </FieldSet>
      <Field>
        <FieldLabel htmlFor="integration-channel">Only orders on</FieldLabel>
        <NativeSelect id="integration-channel" name="channel" defaultValue="">
          <NativeSelectOption value="">Any channel</NativeSelectOption>
          {ORDER_CHANNELS.map((c) => (
            <NativeSelectOption key={c} value={c}>
              {ORDER_CHANNEL_LABELS[c]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldDescription>
          The orders it starts and the orders it sends events to, both.
        </FieldDescription>
      </Field>
      {stepUp !== undefined ? <StepUpField method={stepUp} next="/integrations" /> : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy} className="self-start">
        {busy ? 'Adding…' : 'Add integration'}
      </Button>
    </Form>
  );
}

/** A checkbox and its label, 44px tall on touch. */
function Check({
  id,
  name,
  value,
  checked,
  onChange,
  children,
}: {
  id: string;
  name: string;
  value?: string;
  checked?: boolean;
  onChange?: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-9 items-center gap-2 touch:min-h-11">
      <Checkbox
        id={id}
        name={name}
        value={value}
        checked={checked}
        onCheckedChange={onChange ? (v) => onChange(v === true) : undefined}
      />
      <FieldLabel htmlFor={id} className="font-normal">
        {children}
      </FieldLabel>
    </div>
  );
}

/** What an integration may do, in words. */
function scope(i: Data['integrations'][number], flowName: Map<string, string>) {
  const events = i.events.includes('*')
    ? 'any event'
    : i.events.length
      ? i.events.map(eventShort).join(', ')
      : null;
  const orders = i.startOrders
    ? `starts orders${
        i.flows.includes('*') || !i.flows.length
          ? ''
          : ` on ${i.flows.map((f) => flowName.get(f) ?? f).join(', ')}`
      }`
    : null;
  const channel = i.channel
    ? `${ORDER_CHANNEL_LABELS[i.channel as OrderChannel]} orders only`
    : null;
  return [events ? `Sends ${events}` : null, orders, channel].filter(Boolean).join(' · ');
}

function IntegrationRow({
  i,
  flowName,
  stepUp,
}: {
  i: Data['integrations'][number];
  flowName: Map<string, string>;
  stepUp: Data['stepUp'];
}) {
  const { act } = useAssistant();
  const { revalidate } = useRevalidator();
  const [rotating, setRotating] = useState(false);
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const revoke = async () => {
    setAsking(true);
    setFailed(null);
    try {
      const r = await act('revoke_integration', { integrationId: i.id });
      if (!('declined' in r)) revalidate();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  };
  const revoked = !!i.revokedAt;
  return (
    <li className={cn('px-4 py-3', revoked && 'text-muted-foreground')}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-72">
          <p className="font-medium text-sm">
            {i.name}
            {revoked ? (
              <span className="ml-2 inline-flex items-center gap-1 font-normal text-xs">
                <Ban className="size-3" aria-hidden="true" /> Revoked <Ago ms={i.revokedAt!} />
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 text-xs">{scope(i, flowName)}</p>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {i.lastUsedAt ? (
              <>
                Last used <Ago ms={i.lastUsedAt} />
              </>
            ) : (
              'Not used yet'
            )}{' '}
            · added <Ago ms={i.createdAt} />
            {i.createdBy ? ` by ${i.createdBy}` : ''}
            {i.previousExpiresAt && !revoked ? (
              <>
                {' '}
                · the previous secret also works until <Ago ms={i.previousExpiresAt} />
              </>
            ) : null}
          </p>
          {failed ? (
            <p role="alert" className="mt-1 text-bad text-sm">
              {failed}
            </p>
          ) : null}
        </div>
        {revoked ? null : (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {rotating ? null : (
              <Button size="sm" variant="outline" onClick={() => setRotating(true)}>
                <KeyRound aria-hidden="true" /> Rotate secret
              </Button>
            )}
            {asking ? (
              <span className="text-muted-foreground text-sm" aria-live="polite">
                Confirm it in the assistant
              </span>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Revoke ${i.name}`}
                onClick={() => void revoke()}
              >
                <Ban aria-hidden="true" /> Revoke
              </Button>
            )}
          </div>
        )}
      </div>
      {rotating && !revoked ? (
        <Form method="post" className="mt-3 flex flex-wrap items-end gap-3">
          <input type="hidden" name="intent" value="rotate" />
          <input type="hidden" name="id" value={i.id} />
          <p className="w-full max-w-measure text-muted-foreground text-xs">
            The current secret keeps working for 24 hours, so {i.name} can switch without a gap.
          </p>
          {stepUp !== undefined ? <StepUpField method={stepUp} next="/integrations" /> : null}
          <Button type="submit" size="sm">
            Rotate now
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setRotating(false)}>
            Cancel
          </Button>
        </Form>
      ) : null}
    </li>
  );
}
