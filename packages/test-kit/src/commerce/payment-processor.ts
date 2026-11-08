/**
 * A card processor in memory, for the payment use-cases' tests: intents keyed by idempotency key
 * (a retried call replays the first answer), the test cards' behaviour, and failures on demand.
 */
import {
  type IntentRequest,
  IntentStateError,
  type InvoiceProcessor,
  InvoiceRefusedError,
  PaymentDeclinedError,
  type PaymentMode,
  type PaymentProcessor,
  type ProcessorIntent,
} from '@commerceworker/ports/commerce';

type Intent = { -readonly [K in keyof ProcessorIntent]: ProcessorIntent[K] };

/** Invoices at the fake processor: drafts, items, finalize, send, void and delete, by id. */
export class FakeInvoiceProcessor implements InvoiceProcessor {
  readonly invoices = new Map<string, { status: string; items: number[]; sent: boolean }>();
  private readonly drafts = new Map<string, string>();
  private next = 0;

  async createDraft(_d: unknown, key: string) {
    if (!this.drafts.has(key)) {
      const id = `in_${++this.next}`;
      this.drafts.set(key, id);
      this.invoices.set(id, { status: 'draft', items: [], sent: false });
    }
    return this.drafts.get(key)!;
  }

  private readonly itemKeys = new Set<string>();

  async addItem(item: { invoice: string; amount: number }, key: string) {
    if (this.itemKeys.has(key)) return;
    this.itemKeys.add(key);
    this.get(item.invoice).items.push(item.amount);
  }

  async finalize(id: string) {
    const inv = this.get(id);
    if (inv.status === 'draft') inv.status = 'open';
    return { number: `INV-${id}`, hostedUrl: `https://pay.example/${id}`, dueDate: null };
  }

  async send(id: string) {
    this.get(id).sent = true;
  }

  async void(id: string) {
    const inv = this.invoices.get(id);
    if (!inv) throw new InvoiceRefusedError('No such invoice', 'missing');
    if (inv.status !== 'open' && inv.status !== 'uncollectible')
      throw new InvoiceRefusedError(`Invoice is ${inv.status}`, 'refused');
    inv.status = 'void';
  }

  async delete(id: string) {
    const inv = this.invoices.get(id);
    if (!inv) throw new InvoiceRefusedError('No such invoice', 'missing');
    if (inv.status !== 'draft')
      throw new InvoiceRefusedError(`Invoice is ${inv.status}`, 'refused');
    this.invoices.delete(id);
  }

  async status(id: string) {
    return this.get(id).status;
  }

  private get(id: string) {
    const inv = this.invoices.get(id);
    if (!inv) throw new Error(`No such invoice ${id}`);
    return inv;
  }
}

export class FakePaymentProcessor implements PaymentProcessor {
  readonly id = 'stripe' as const;
  readonly invoices = new FakeInvoiceProcessor();
  readonly intents = new Map<string, Intent>();
  readonly refunds = new Map<
    string,
    { id: string; status: string; intentId: string; amount: number }
  >();
  readonly customers = new Map<string, string>();
  readonly calls: string[] = [];
  private readonly byKey = new Map<string, Intent>();
  private next = 0;

  constructor(readonly testMode = true) {}

  async createIntent(r: IntentRequest, key: string) {
    this.calls.push(`create ${key}`);
    const seen = this.byKey.get(key);
    if (seen) return { ...seen };
    if (r.paymentMethod === 'pm_card_visa_chargeDeclined')
      throw new PaymentDeclinedError('card_declined');
    const pi: Intent = {
      id: `pi_${++this.next}`,
      status: r.capture === 'manual' ? 'requires_capture' : 'succeeded',
      amount: r.amount,
      currency: r.currency,
      customer: r.customer ?? null,
      paymentMethod: r.paymentMethod,
      metadata: r.metadata,
    };
    this.intents.set(pi.id, pi);
    this.byKey.set(key, pi);
    return { ...pi };
  }

  async retrieveIntent(id: string) {
    const pi = this.intents.get(id);
    if (!pi) throw new Error(`No such intent ${id}`);
    return { ...pi };
  }

  async cancelIntent(id: string, key: string) {
    this.calls.push(`cancel ${key}`);
    const pi = await this.intent(id);
    if (pi.status !== 'requires_capture')
      throw new IntentStateError(`Intent is ${pi.status}`, pi.status);
    pi.status = 'canceled';
  }

  async captureIntent(id: string, amount: number, key: string) {
    this.calls.push(`capture ${key}`);
    const pi = await this.intent(id);
    if (pi.status === 'succeeded') return;
    if (pi.status !== 'requires_capture')
      throw new IntentStateError(`Intent is ${pi.status}`, pi.status);
    Object.assign(pi, { status: 'succeeded', amount });
  }

  async refund(r: { intentId: string; amount: number }, key: string) {
    this.calls.push(`refund ${key}`);
    const seen = this.refunds.get(key);
    if (seen) return { id: seen.id, status: seen.status };
    const out = { id: `re_${++this.next}`, status: 'succeeded', ...r };
    this.refunds.set(key, out);
    return { id: out.id, status: out.status };
  }

  async createCustomer(_c: unknown, key: string) {
    if (!this.customers.has(key)) this.customers.set(key, `cus_${++this.next}`);
    return this.customers.get(key)!;
  }

  private async intent(id: string) {
    const pi = this.intents.get(id);
    if (!pi) throw new Error(`No such intent ${id}`);
    return pi;
  }
}

/** Mock mode (`live` false), or live with this processor. */
export const paymentModeFor = (processor?: PaymentProcessor): PaymentMode => ({
  live: () => !!processor,
  processor: () => {
    if (!processor) throw new Error('No card processor in mock mode');
    return processor;
  },
});
