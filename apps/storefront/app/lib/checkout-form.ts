/**
 * The hosted checkout page's form, as pure functions: a posted form into the buyer's patch (and
 * the field errors it can find without asking the engine), the session's issues into the section
 * each belongs to, and the quote into the rows of its total. The engine decides what is allowed
 * (`hostedPatchSchema`, strict, never a price); this only builds what the page may ask.
 */

import {
  type CheckoutIssue,
  HOSTED_LIMITS,
  type HostedCheckout,
  type HostedPatch,
  hostedBuyerSchema,
  MAX_LINE_QUANTITY,
  SHIP_TO_LIMITS,
  type ShopperAddresses,
  shipToSchema,
} from '@commerceworker/core';

/** The fields of a ship-to, in the order a buyer fills them. */
export const SHIP_FIELDS = [
  'name',
  'line1',
  'line2',
  'city',
  'region',
  'postalCode',
  'country',
] as const;
export type ShipField = (typeof SHIP_FIELDS)[number];

/** What is wrong with a field, by the name of its input (`email`, `shipTo.city`, `lines`, `promo`). */
export type FieldErrors = Record<string, string>;

/** Every string the form posted, by input name: echoed back so a refused page keeps what was typed. */
export type FormValues = Record<string, string>;

const BUYER_FIELDS = ['email', 'firstName', 'lastName', 'phone'] as const;

/** What a field is called in a message. */
const SHIP_LABEL: Record<ShipField, string> = {
  name: 'Name',
  line1: 'Address',
  line2: 'Apartment, suite',
  city: 'City',
  region: 'State or region',
  postalCode: 'Postal code',
  country: 'Country',
};

/** The string a form field holds (a file is not one). */
const text = (f: FormData, name: string) => {
  const v = f.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/** The strings of a form, for echoing. */
export function valuesOf(f: FormData): FormValues {
  const out: FormValues = {};
  for (const [k, v] of f.entries()) if (typeof v === 'string' && k !== 'version') out[k] = v;
  return out;
}

/** A ship-to as the form holds it: only the fields with something in them. */
const shipToFrom = (get: (f: ShipField) => string) => {
  const out: Partial<Record<ShipField, string>> = {};
  for (const f of SHIP_FIELDS) {
    const v = get(f);
    if (v) out[f] = v;
  }
  return out;
};

const sameAddress = (
  a: Record<string, string | undefined>,
  b: Record<string, string | undefined>,
) => SHIP_FIELDS.every((f) => (a[f] ?? '') === (b[f] ?? ''));

/** The most a form's line quantity may be. */
const QTY_ERROR = `Enter a quantity from 1 to ${MAX_LINE_QUANTITY}.`;

/**
 * The patch a posted form asks for, from the session as the page showed it. Only what the form
 * carries is in it: a section that wasn't on the page (the address of a pickup) leaves its part of
 * the session alone. A change of address clears the shipping option, since the options belong to
 * the address; the flow offers its own choice again.
 */
export function patchFromForm(
  f: FormData,
  checkout: HostedCheckout,
  opts: { editLines: boolean },
): { patch: HostedPatch; errors: FieldErrors } {
  const patch: HostedPatch = {};
  const errors: FieldErrors = {};

  // Who is buying: all four fields at once, since the session takes the buyer whole.
  if (BUYER_FIELDS.some((n) => f.has(n))) {
    const buyer: Record<string, string> = {};
    for (const n of BUYER_FIELDS) {
      const v = text(f, n);
      if (v) buyer[n] = v;
    }
    const parsed = hostedBuyerSchema.safeParse(buyer);
    if (parsed.success) patch.buyer = parsed.data;
    else
      for (const issue of parsed.error.issues) {
        const n = String(issue.path[0] ?? '');
        if (n === 'email') errors.email = 'Enter an email address like name@example.com.';
        else if (n)
          errors[n] =
            `That is too long (${n === 'phone' ? HOSTED_LIMITS.phone : HOSTED_LIMITS.name} characters at most).`;
      }
  }

  // Where it goes: the ship-to, when the page showed one.
  const shipping = f.has('shipTo.line1');
  let addressChanged = false;
  if (shipping) {
    const address = shipToFrom((n) => text(f, `shipTo.${n}`));
    const parsed = shipToSchema.strict().safeParse(address);
    if (parsed.success) {
      patch.shipTo = Object.keys(address).length ? parsed.data : null;
      addressChanged = !sameAddress(address, checkout.shipTo ?? {});
    } else
      for (const issue of parsed.error.issues) {
        const n = issue.path[0] as ShipField;
        if (SHIP_FIELDS.includes(n))
          errors[`shipTo.${n}`] =
            `${SHIP_LABEL[n]} is too long (${SHIP_TO_LIMITS[n]} characters at most).`;
      }
  }

  const method = text(f, 'fulfillment');
  if (method === 'ship' || method === 'pickup') {
    patch.fulfillment = method;
    patch.pickupLocationId = method === 'pickup' ? text(f, 'pickupLocationId') || null : null;
  }
  const option = text(f, 'shippingOption');
  if (addressChanged) patch.shippingOption = null;
  else if (option) patch.shippingOption = option;

  // Codes: the ones already on the session, less the ones removed, plus the one typed.
  const removed = new Set(f.getAll('remove').map((v) => String(v).toLowerCase()));
  const codes = (checkout.promoCodes ?? []).filter((c) => !removed.has(c.toLowerCase()));
  const typed = text(f, 'promo');
  if (typed && !codes.some((c) => c.toLowerCase() === typed.toLowerCase())) codes.push(typed);
  if (typed.length > HOSTED_LIMITS.promoCode) errors.promo = 'That code is too long.';
  else if (codes.length > HOSTED_LIMITS.promoCodes)
    errors.promo = `A checkout takes at most ${HOSTED_LIMITS.promoCodes} codes.`;
  else if (codes.length !== (checkout.promoCodes ?? []).length || typed || removed.size)
    patch.promoCodes = codes;

  // Lines: the quantities as the page showed them, when the merchant lets the buyer change them.
  if (opts.editLines && checkout.lines.some((l) => f.has(`qty:${l.id}`))) {
    const lines: NonNullable<HostedPatch['lines']> = [];
    const dropped = new Set(f.getAll('removeLine').map(String));
    for (const l of checkout.lines) {
      const raw = text(f, `qty:${l.id}`);
      const qty = raw === '' ? l.qty : Number(raw);
      if (dropped.has(l.id) || qty === 0) continue;
      if (!Number.isInteger(qty) || qty < 0 || qty > MAX_LINE_QUANTITY)
        errors[`qty:${l.id}`] = QTY_ERROR;
      else lines.push({ id: l.id, sku: l.sku, qty });
    }
    if (!lines.length) errors.lines = 'A checkout needs at least one item.';
    else if (
      JSON.stringify(lines.map((l) => [l.id, l.qty])) !==
      JSON.stringify(checkout.lines.map((l) => [l.id, l.qty]))
    )
      patch.lines = lines;
  }
  return { patch, errors };
}

/**
 * The patch that fills a checkout from what the engine says a signed-in shopper has: their address
 * as the contact email and, when `chosen` names one of their saved places, that place as the
 * ship-to. `chosen` is only an id picked from the engine's own list, never an address: what the
 * page posted can name one of the shopper's places and cannot make one. A change of address clears
 * the shipping option, as an edit of it does, since the options belong to the address.
 */
export function fillPatch(
  chosen: string,
  checkout: HostedCheckout,
  saved: ShopperAddresses | null,
): { patch: HostedPatch; errors: FieldErrors } {
  if (!saved) return { patch: {}, errors: { saved: 'Sign in again to use your saved details.' } };
  // The session takes the buyer whole: what is already there, less anything the schema doesn't name.
  const buyer: Record<string, string> = {};
  for (const n of BUYER_FIELDS) {
    const v = checkout.buyer[n];
    if (v) buyer[n] = v;
  }
  const patch: HostedPatch = { buyer: { ...buyer, email: saved.email } };
  if (!chosen) return { patch, errors: {} };
  const place = saved.addresses.find((a) => a.id === chosen);
  if (!place)
    return {
      patch: {},
      errors: { saved: 'That address isn’t saved any more. Choose another, or type it below.' },
    };
  const address = shipToFrom((f) => place[f] ?? '');
  patch.shipTo = address;
  if (!sameAddress(address, checkout.shipTo ?? {})) patch.shippingOption = null;
  return { patch, errors: {} };
}

/** The sections of the page an issue can belong to. */
export type IssueSection =
  | 'email'
  | 'contact'
  | 'address'
  | 'shipping'
  | 'pickup'
  | 'lines'
  | 'promo'
  | 'payment'
  | 'general';

/**
 * The section an issue is about, from its JSONPath (`$.buyer.email`, `$.fulfillment`, …) and, where
 * one path carries several (the checkout's fulfillment is address, shipping option and store), its code.
 */
export function sectionOf(i: CheckoutIssue): IssueSection {
  const path = i.path ?? '$';
  if (path === '$.buyer.email') return 'email';
  if (path.startsWith('$.buyer')) return 'contact';
  if (path.startsWith('$.fulfillment')) {
    if (i.code === 'pickup_unavailable') return 'pickup';
    if (i.code === 'fulfillment_option_unavailable' || /shipping option/i.test(i.content))
      return 'shipping';
    return 'address';
  }
  if (path.startsWith('$.line_items') || path.startsWith('$.lines')) return 'lines';
  if (path.startsWith('$.promoCodes')) return 'promo';
  if (path.startsWith('$.payment')) return 'payment';
  return 'general';
}

/** The input an issue is about, when its path names one (`$.buyer.phone`, `…address.postal_code`), or null. */
export function fieldOf(i: CheckoutIssue): string | null {
  const path = i.path ?? '';
  const buyer = /^\$\.buyer\.(email|phone|firstName|lastName|first_name|last_name)$/.exec(
    path,
  )?.[1];
  if (buyer) return buyer.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
  const address = /address\.(name|line1|line2|city|region|postalCode|postal_code|country)$/.exec(
    path,
  )?.[1];
  return address ? `shipTo.${address.replace('postal_code', 'postalCode')}` : null;
}

/** An issue as the page shows it: its words, and whether it only says something is still to do. */
export type ShownIssue = { kind: CheckoutIssue['kind']; content: string; todo: boolean };

/**
 * The issues by section, and by the input they name (`fields`, first per input). A "missing" error
 * only says what the buyer has yet to fill in, so the page holds those back until they have tried to
 * continue (`showTodo`); everything else shows at once. An issue on an input is shown there and not
 * again in its section.
 */
export function issuesBySection(
  issues: CheckoutIssue[],
  showTodo: boolean,
): Record<IssueSection, ShownIssue[]> & { fields: Record<string, ShownIssue> } {
  const out: Record<IssueSection, ShownIssue[]> & { fields: Record<string, ShownIssue> } = {
    email: [],
    contact: [],
    address: [],
    shipping: [],
    pickup: [],
    lines: [],
    promo: [],
    payment: [],
    general: [],
    fields: {},
  };
  for (const i of issues) {
    const todo = i.code === 'missing';
    if (todo && !showTodo) continue;
    const shown = { kind: i.kind, content: i.content, todo };
    const field = fieldOf(i);
    if (field) out.fields[field] ??= shown;
    else out[sectionOf(i)].push(shown);
  }
  return out;
}

/** One row of the total: what it is, and what it comes to (negative for a discount). */
export type TotalRow = {
  key: 'subtotal' | 'discount' | 'shipping' | 'tax' | 'total';
  label: string;
  amount: number;
  /** A note beside the label: the code a discount came from. */
  note?: string;
  /** Shipping that costs nothing says so. */
  free?: boolean;
};

/**
 * The quote as the rows of its total: the subtotal before discounts, each discount, shipping, tax and
 * the total, every amount the quote's own (`listSubtotal`, `discounts`, `shipping`, `tax`, `total`):
 * nothing is added up here. A quote with no `listSubtotal` shows its `subtotal` and no discount rows.
 * A free-shipping promotion is a note on the shipping row.
 */
export function totalRows(quote: NonNullable<HostedCheckout['quote']>): TotalRow[] {
  const applied = quote.discounts?.applied ?? [];
  const lineDiscounts = applied.filter((d) => d.kind !== 'free_shipping');
  const freeShipping = applied.find((d) => d.kind === 'free_shipping');
  const before = quote.listSubtotal !== undefined;
  const rows: TotalRow[] = [
    { key: 'subtotal', label: 'Subtotal', amount: quote.listSubtotal ?? quote.subtotal },
  ];
  if (before)
    for (const d of lineDiscounts)
      rows.push({
        key: 'discount',
        label: d.title,
        amount: -d.amount,
        ...(d.code ? { note: d.code } : {}),
      });
  if (quote.ships)
    rows.push({
      key: 'shipping',
      label: 'Shipping',
      amount: quote.shipping,
      ...(quote.shipping === 0 ? { free: true } : {}),
      ...(freeShipping?.code ? { note: freeShipping.code } : {}),
    });
  rows.push({ key: 'tax', label: 'Tax', amount: quote.tax });
  rows.push({ key: 'total', label: 'Total', amount: quote.total });
  return rows;
}

/** A promo code on the session, with what the quote did with it. */
export type CodeStatus =
  | { code: string; state: 'applied'; title: string }
  | { code: string; state: 'refused'; reason: string }
  | { code: string; state: 'pending' };

/** Each code the buyer entered, applied, refused (with why) or not yet priced. */
export function codeStatuses(checkout: HostedCheckout): CodeStatus[] {
  const applied = checkout.quote?.discounts?.applied ?? [];
  const refused = checkout.quote?.discounts?.refused ?? [];
  return (checkout.promoCodes ?? []).map((code) => {
    const lower = code.toLowerCase();
    const a = applied.find((d) => d.code?.toLowerCase() === lower);
    if (a) return { code, state: 'applied', title: a.title };
    const r = refused.find((d) => d.code.toLowerCase() === lower);
    if (r) return { code, state: 'refused', reason: r.reason };
    return { code, state: 'pending' };
  });
}

/** The shipping option the session has chosen: its own, or the one the flow's quote charged. */
export const chosenOption = (c: HostedCheckout) =>
  c.shippingOption ?? c.quote?.shippingOption ?? null;

/**
 * Whether the buyer may still change anything or place the order. A checkout waiting on the
 * business (`requires_escalation`) is not theirs to change.
 */
export const isOpen = (c: Pick<HostedCheckout, 'status'>) =>
  c.status === 'incomplete' || c.status === 'ready_for_complete';
