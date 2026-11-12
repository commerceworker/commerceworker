/**
 * Stripe.js, loaded only by the card payment on a hosted checkout page (`CardPayment`), so no other
 * page of this Worker fetches it and only that page's policy allows it (`STRIPE_HEADER`). It is
 * loaded from js.stripe.com itself, as Stripe requires, and typed here for the few calls the page
 * makes: a Payment Element in deferred-intent mode, a confirmation token made from it, and the
 * bank's step (`handleNextAction`). Nothing here sees a card number: Stripe's frames do.
 */

type StripeError = { message?: string };

export type PaymentElementHandle = {
  mount(el: HTMLElement): void;
  destroy(): void;
  on(event: 'change', handler: (e: { complete: boolean }) => void): void;
};

export type StripeElementsHandle = {
  create(type: 'payment', options?: Record<string, unknown>): PaymentElementHandle;
  update(options: { amount?: number; currency?: string }): void;
  submit(): Promise<{ error?: StripeError }>;
};

export type StripeHandle = {
  elements(options: Record<string, unknown>): StripeElementsHandle;
  createConfirmationToken(options: {
    elements: StripeElementsHandle;
    params?: Record<string, unknown>;
  }): Promise<{ error?: StripeError; confirmationToken?: { id: string } }>;
  handleNextAction(options: {
    clientSecret: string;
  }): Promise<{ error?: StripeError; paymentIntent?: { status: string } }>;
};

const SCRIPT = 'https://js.stripe.com/v3';

type StripeGlobal = (key: string) => StripeHandle;
let loading: Promise<StripeGlobal> | null = null;

/** Stripe.js once per page: a blocked or offline load rejects, and the next mount tries again. */
function loadScript(): Promise<StripeGlobal> {
  const ready = (window as { Stripe?: StripeGlobal }).Stripe;
  if (ready) return Promise.resolve(ready);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => {
      const api = (window as { Stripe?: StripeGlobal }).Stripe;
      if (api) resolve(api);
      else reject(new Error('Stripe.js did not load'));
    };
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error('Stripe.js did not load'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export async function loadStripe(publishableKey: string): Promise<StripeHandle> {
  return (await loadScript())(publishableKey);
}

/**
 * The Payment Element's options for a deferred intent: a payment of this amount, authorized now and
 * captured later (`manual`), by card (which Apple Pay and Google Pay are offered under) or Link.
 * No redirect or asynchronous method is offered, as the engine refuses them too (`allow_redirects: never`).
 */
export const elementsOptions = (amount: number, currency: string) => ({
  mode: 'payment',
  amount,
  currency: currency.toLowerCase(),
  captureMethod: 'manual',
  paymentMethodTypes: ['card', 'link'],
});
