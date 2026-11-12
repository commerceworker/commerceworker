/**
 * A hosted checkout, for the buyer whose redeemed start link set its cookie
 * (lib/hosted-checkout.server.ts). The engine decides who may see and change a session (`checkout`,
 * `updateCheckout`: the cookie's secret and an actor signed for this checkout) and answers null for
 * anyone else's; this only says who asks and draws what it is given. The page is one plain form
 * posting to its own action, so it works without a script: an update redirects back to the page
 * (a reload repeats nothing), a change the buyer's page didn't know of (`version`) is said and the
 * checkout shown as it is now, and in test mode "Place order" completes it and goes to the order
 * page. A card payment is not taken here yet.
 */

import { HOSTED_ID, type HostedCheckout } from '@commerceworker/core';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { CircleAlert, Info } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { data, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import { CheckoutForm } from '~/components/checkout-form';
import { CheckoutRefusal } from '~/components/checkout-refusal';
import { type FieldErrors, type FormValues, patchFromForm, valuesOf } from '~/lib/checkout-form';
import { engine } from '~/lib/env.server';
import {
  checkoutBuyer,
  checkoutRefusal,
  PRIVATE_HEADERS,
  privateHeaders,
  storefrontSettings,
} from '~/lib/hosted-checkout.server';
import { overBudget } from '~/lib/rate-limit';
import type { Route } from './+types/checkout';

export const meta = () => [
  { title: 'Checkout · CommerceWorker' },
  { name: 'robots', content: 'noindex' },
];

/** Who is asking, or why they can't: the same for the page and its posts. */
async function authorize(request: Request, id: string) {
  if (!HOSTED_ID.test(id)) throw checkoutRefusal('This checkout doesn’t exist.', 404);
  const settings = await storefrontSettings();
  if (!settings.checkout.enabled) throw checkoutRefusal('Checkout is not available here.', 404);
  const buyer = await checkoutBuyer(request, id);
  if (!buyer) throw checkoutRefusal('Open this checkout from the link you were sent.', 401);
  // Each cookie has its own budget: someone sending a wrong one spends theirs, not the buyer's.
  const limited = await overBudget('API_LIMIT', buyer.budgetKey);
  if (limited) throw limited;
  return { buyer, settings };
}

const orderPlaced = (id: string) => `/checkout/${id}/placed`;

export async function loader({ request, params }: Route.LoaderArgs) {
  const { buyer, settings } = await authorize(request, params.id);
  const checkout = await engine().checkout(params.id, buyer.secret, buyer.actor);
  if (!checkout) throw checkoutRefusal('This checkout doesn’t exist.', 404);
  if (checkout.status === 'completed')
    return redirect(orderPlaced(params.id), { status: 303, headers: PRIVATE_HEADERS });
  return data(
    {
      checkout,
      testPayments: settings.checkout.testPayments,
      editLines: settings.checkout.editLines,
    },
    { headers: PRIVATE_HEADERS },
  );
}

/** What an action says back: the page as it should be drawn, never a redirect's worth of state. */
type Refusal = {
  /** Which button was pressed, so the alert says what did not happen. */
  intent: 'update' | 'place';
  /** Say this at the top. */
  error: string;
  /** The session moved under the buyer: say so, and draw it as it is. */
  changed: boolean;
  /** The session as it is now, when the engine sent it. */
  checkout?: HostedCheckout | undefined;
  /** What the buyer typed, to keep it where it is still theirs to fix. */
  values?: FormValues | undefined;
  errors?: FieldErrors | undefined;
};

const refusal = (r: Refusal, status: number) => data(r, { status, headers: PRIVATE_HEADERS });

export async function action({ request, params }: Route.ActionArgs) {
  const { buyer, settings } = await authorize(request, params.id);
  const form = await request.formData();
  const intent = form.get('intent') === 'place' ? 'place' : 'update';
  // A form with no version asks for no conflict check; one with a version that is no number is
  // never the session's, so it is a conflict (`Number('')` would have been 0).
  const version = form.has('version') ? Number(form.get('version')) : undefined;
  const call = [params.id, buyer.secret] as const;

  const current = await engine().checkout(...call, buyer.actor);
  if (!current) throw checkoutRefusal('This checkout doesn’t exist.', 404);
  if (current.status === 'completed')
    return redirect(orderPlaced(params.id), { status: 303, headers: PRIVATE_HEADERS });

  // What the page can tell wrong without asking the engine: an email that isn't one, a quantity.
  const { patch, errors } = patchFromForm(form, current, settings.checkout);
  if (Object.keys(errors).length)
    return refusal(
      {
        intent,
        error: 'Check the highlighted fields.',
        changed: false,
        checkout: current,
        values: valuesOf(form),
        errors,
      },
      422,
    );

  // Trying codes is the one thing here worth guessing at: its own, smaller budget per cookie.
  if (patch.promoCodes) {
    const limited = await overBudget('PROMO_LIMIT', `promo:${buyer.budgetKey}`);
    if (limited) throw limited;
  }

  const changed = await engine().updateCheckout(
    params.id,
    patch,
    buyer.secret,
    buyer.actor,
    version,
  );
  if (!changed) throw checkoutRefusal('This checkout doesn’t exist.', 404);
  if (!changed.ok)
    return refusal(
      {
        intent,
        error: changed.error,
        changed: !!changed.changed,
        checkout: changed.checkout ?? current,
        // Typed text is kept for a refusal about it, and dropped for a session that moved.
        ...(changed.changed ? {} : { values: valuesOf(form) }),
      },
      changed.changed ? 409 : 422,
    );
  if (intent === 'update')
    return redirect(`/checkout/${params.id}`, { status: 303, headers: PRIVATE_HEADERS });

  // Place the order: only a checkout that is ready, and only in test mode (the engine checks both).
  if (changed.checkout.status !== 'ready_for_complete')
    return refusal(
      {
        intent,
        error: 'Finish the details marked below, then place your order.',
        changed: false,
        checkout: changed.checkout,
      },
      422,
    );
  let placed: Awaited<ReturnType<ReturnType<typeof engine>['completeCheckout']>>;
  try {
    placed = await engine().completeCheckout(...call, buyer.actor, {
      // The version the update just made and the total the page showed: nothing else is placed.
      version: changed.checkout.version,
      total: form.has('total') ? Number(form.get('total')) : Number.NaN,
    });
  } catch {
    // The order failed after the checkout was claimed; the engine opened it again.
    return refusal(
      {
        intent,
        error: 'We couldn’t place your order. Nothing was charged. Try again.',
        changed: false,
        checkout: changed.checkout,
      },
      503,
    );
  }
  if (!placed) throw checkoutRefusal('This checkout doesn’t exist.', 404);
  if (!placed.ok)
    return refusal(
      {
        intent,
        error: placed.error,
        changed: !!placed.changed,
        checkout: placed.checkout ?? changed.checkout,
      },
      placed.changed ? 409 : 422,
    );
  return redirect(orderPlaced(params.id), { status: 303, headers: PRIVATE_HEADERS });
}

export function headers({ errorHeaders }: Route.HeadersArgs) {
  return privateHeaders({ errorHeaders });
}

export const ErrorBoundary = CheckoutRefusal;

/** What the buyer pressed, as the form posts it: the control to give focus back to once the page is drawn again. */
function pressed(f: FormData | undefined): { name: string; value: string } | null {
  if (!f) return null;
  for (const name of ['remove', 'removeLine', 'intent']) {
    const value = f.get(name);
    if (typeof value === 'string') return { name, value };
  }
  return null;
}

export default function CheckoutPage() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  // What the engine said last is as new as the loader's, unless the loader has run since.
  const checkout = result?.checkout ?? loaded.checkout;
  const ended = checkout.status === 'canceled';
  const claimed = checkout.status === 'complete_in_progress';
  const reviewing = checkout.status === 'requires_escalation';
  const alertRef = useRef<HTMLDivElement>(null);
  const last = useRef<{ name: string; value: string } | null>(null);
  const answer = useRef(result);
  answer.current = result;

  // Focus follows what happened (a form that is submitted without a script starts again, at the top):
  // a refusal or a change takes it to the one alert, a field's error to the field, and an update
  // gives it back to the control that was pressed, or to its neighbour when that one is gone.
  useEffect(() => {
    if (navigation.state === 'submitting') {
      last.current = pressed(navigation.formData);
      return;
    }
    if (navigation.state !== 'idle' || !last.current) return;
    const was = last.current;
    last.current = null;
    const r = answer.current;
    if (r?.errors && Object.keys(r.errors).length) {
      document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    } else if (r) {
      alertRef.current?.focus();
    } else {
      const same = document.querySelector<HTMLElement>(
        `button[name="${was.name}"][value="${CSS.escape(was.value)}"]`,
      );
      (
        same ??
        document.getElementById(was.name === 'remove' ? 'f-promo' : '') ??
        document.querySelector<HTMLElement>('input[name^="qty:"]')
      )?.focus();
    }
  }, [navigation.state, navigation.formData]);

  return (
    <main
      id="main"
      className="mx-auto w-full max-w-5xl px-safe-4 pt-safe-6 pb-safe-8 sm:px-safe-6 lg:px-safe-8"
    >
      <header className="mb-6 flex flex-col gap-1">
        {/* TODO(S7): the merchant's store name, which the wordmark stands in for until then. */}
        <p className="font-semibold text-brand tracking-title">CommerceWorker</p>
        <h1 className="font-semibold text-2xl tracking-title">Checkout</h1>
      </header>

      {result?.changed ? (
        <Alert variant="warning" className="mb-4" ref={alertRef} tabIndex={-1}>
          <Info aria-hidden="true" />
          <AlertTitle>This checkout changed</AlertTitle>
          <AlertDescription>
            It was updated while you were editing, or its price moved. Here it is as it is now;{' '}
            {result.intent === 'place'
              ? 'your order was not placed'
              : 'your last change was not saved'}
            .
          </AlertDescription>
        </Alert>
      ) : result?.error ? (
        <Alert variant="destructive" className="mb-4" ref={alertRef} tabIndex={-1}>
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{result.intent === 'place' ? 'Order not placed' : 'Not saved'}</AlertTitle>
          <AlertDescription>{result.error}</AlertDescription>
        </Alert>
      ) : null}

      {ended ? (
        <Alert className="mb-4">
          <Info aria-hidden="true" />
          <AlertTitle>This checkout has ended</AlertTitle>
          <AlertDescription>
            It expired or was canceled. Ask the business for a new link.
          </AlertDescription>
        </Alert>
      ) : claimed ? (
        <Alert className="mb-4">
          <Info aria-hidden="true" />
          <AlertTitle>Your order is being placed</AlertTitle>
          <AlertDescription>Reload this page in a moment.</AlertDescription>
        </Alert>
      ) : reviewing ? (
        <Alert className="mb-4">
          <Info aria-hidden="true" />
          <AlertTitle>We’re reviewing this order</AlertTitle>
          <AlertDescription>You’ll hear from the business.</AlertDescription>
        </Alert>
      ) : null}

      <CheckoutForm
        checkout={checkout}
        testPayments={loaded.testPayments}
        editLines={loaded.editLines}
        values={result?.values}
        errors={result?.errors}
        attempted={!!result}
        busy={navigation.state !== 'idle'}
        placing={navigation.formData?.get('intent') === 'place'}
        changed={!!result?.changed}
      />
    </main>
  );
}
