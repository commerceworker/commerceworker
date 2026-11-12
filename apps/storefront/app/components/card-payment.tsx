import { toMinor } from '@commerceworker/core';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { money } from '@commerceworker/ui/lib/format';
import { Turnstile } from '@commerceworker/ui/turnstile';
import { CircleAlert, CreditCard, Info } from 'lucide-react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { useSubmit } from 'react-router';
import {
  elementsOptions,
  loadStripe,
  type PaymentElementHandle,
  type StripeElementsHandle,
  type StripeHandle,
} from '~/lib/stripe-js';

export type CardPaymentProps = {
  publishableKey: string;
  currency: string;
  /** The quote's total, as the page shows it: the Payment Element's amount (the engine charges its own). */
  total: number;
  /** The Turnstile site key, when the deployment has one: Pay then waits for the check. */
  turnstileKey: string | null;
  /** Something else on the page is being sent. */
  busy: boolean;
  /** The form whose fields (and Turnstile token) travel with the payment. */
  formRef: RefObject<HTMLFormElement | null>;
  /** Set when the card needs the bank: Stripe.js runs its step and the engine is asked to confirm. */
  authenticate?: string | undefined;
  /** The last answer from the action, so a spent Turnstile token is replaced. */
  answer: unknown;
};

/**
 * The card payment of a hosted checkout: Stripe's Payment Element (card, Apple Pay, Google Pay,
 * Link) in deferred-intent mode, drawn in its own frames so the card never touches this page. Pay
 * validates it, asks Stripe.js for a confirmation token and posts only that token with the form (the
 * page's version and total ride in its fields; the engine prices again and charges its own total).
 * Without a script none of this can run, so the page says so rather than showing a form that
 * can't pay.
 */
export function CardPayment({
  publishableKey,
  currency,
  total,
  turnstileKey,
  busy,
  formRef,
  authenticate,
  answer,
}: CardPaymentProps) {
  const submit = useSubmit();
  const box = useRef<HTMLDivElement>(null);
  const [js, setJs] = useState(false);
  const [stripe, setStripe] = useState<StripeHandle | null>(null);
  const [elements, setElements] = useState<StripeElementsHandle | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [complete, setComplete] = useState(false);
  const [checked, setChecked] = useState(!turnstileKey);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const amount = toMinor(total, currency);
  const first = useRef({ amount, currency });
  first.current = { amount, currency };

  useEffect(() => setJs(true), []);

  // Stripe.js and the element are made once the page is a script's, and only then.
  useEffect(() => {
    if (!js) return;
    let gone = false;
    let element: PaymentElementHandle | null = null;
    loadStripe(publishableKey).then(
      (s) => {
        const el = box.current;
        if (gone || !el) return;
        const made = s.elements(elementsOptions(first.current.amount, first.current.currency));
        element = made.create('payment', { layout: 'tabs' });
        element.on('change', (e) => setComplete(e.complete));
        element.mount(el);
        setStripe(s);
        setElements(made);
      },
      () => !gone && setLoadFailed(true),
    );
    return () => {
      gone = true;
      element?.destroy();
    };
  }, [js, publishableKey]);

  // A total the page now shows is the element's amount (Apple Pay's sheet shows it).
  useEffect(() => {
    elements?.update({ amount });
  }, [elements, amount]);

  // The bank's step, once, for the intent the engine is holding; then the engine confirms it. How
  // it went is the engine's to say (it reads the intent), so even a failed step is followed by the ask.
  const handled = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!authenticate || !stripe || handled.current === authenticate) return;
    handled.current = authenticate;
    setWorking(true);
    stripe
      .handleNextAction({ clientSecret: authenticate })
      .catch(() => undefined)
      .then(() => submit({ intent: 'confirm' }, { method: 'post', preventScrollReset: true }));
  }, [authenticate, stripe, submit]);
  // A refused answer ends the wait (and a Turnstile token is spent: the widget starts again).
  useEffect(() => {
    if (answer && !authenticate) setWorking(false);
  }, [answer, authenticate]);

  async function pay() {
    const form = formRef.current;
    if (!form || !stripe || !elements) return;
    setProblem(null);
    setWorking(true);
    try {
      const checkedFields = await elements.submit();
      if (checkedFields.error) {
        setProblem(checkedFields.error.message ?? 'Check your payment details.');
        setWorking(false);
        return;
      }
      const made = await stripe.createConfirmationToken({ elements });
      if (made.error || !made.confirmationToken) {
        setProblem(made.error?.message ?? 'Your payment details could not be read. Try again.');
        setWorking(false);
        return;
      }
      const body = new FormData(form);
      body.set('intent', 'pay');
      body.set('confirmationToken', made.confirmationToken.id);
      submit(body, { method: 'post', preventScrollReset: true });
    } catch {
      setProblem('Your payment details could not be read. Try again.');
      setWorking(false);
    }
  }

  if (!js)
    return (
      <Alert>
        <CreditCard aria-hidden="true" />
        <AlertTitle>Card payment needs JavaScript</AlertTitle>
        <AlertDescription>
          Turn JavaScript on to pay by card here, or contact the business to pay for this order.
        </AlertDescription>
      </Alert>
    );

  return (
    <div className="flex flex-col gap-3">
      {/* Stripe's frames fill this; React draws nothing into it. */}
      <div ref={box} className="min-h-[7rem] rounded-lg" />
      {loadFailed ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>The payment form didn’t load</AlertTitle>
          <AlertDescription>
            Reload the page. If it keeps failing, your network may be blocking js.stripe.com.
          </AlertDescription>
        </Alert>
      ) : null}
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      {authenticate && working ? (
        <Alert>
          <Info aria-hidden="true" />
          <AlertTitle>Confirm with your bank</AlertTitle>
          <AlertDescription>
            Finish the step your bank shows; this page continues by itself.
          </AlertDescription>
        </Alert>
      ) : null}
      {turnstileKey ? (
        <Turnstile
          siteKey={turnstileKey}
          action="checkout_pay"
          reset={answer}
          onSolved={setChecked}
        />
      ) : null}
      <Button
        type="button"
        size="lg"
        className="h-11 w-full text-base"
        disabled={busy || working || !stripe || !complete || !checked}
        onClick={pay}
      >
        {working ? 'Paying…' : `Pay ${money(total, currency)}`}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Your card details go to Stripe, not to us.
      </p>
    </div>
  );
}
