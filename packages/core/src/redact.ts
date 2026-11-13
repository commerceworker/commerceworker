/**
 * What a model may see of an order. Workflow AI nodes (classify, risk, router, summarize, assess)
 * get the order's commercial facts: lines, amounts, channel, fulfilment method, ship-to country.
 * With personal data redacted (the default), they don't get who the buyer is or where they live:
 * no contact, names, emails, phone numbers, street addresses or payment ids, and email addresses
 * and phone numbers in free text are masked. A deployment that needs them (a router that decides
 * by customer name) sets `send`. Extract still reads the inbound document whole: finding the
 * buyer in it is its job.
 */

import { shipToCountry } from './shipping';
import type { Order } from './types';

export const PERSONAL_DATA_MODES = ['redact', 'send'] as const;
export type PersonalDataMode = (typeof PERSONAL_DATA_MODES)[number];

/** The mode a deployment's `AI_PERSONAL_DATA` asks for; anything but `send` redacts. */
export const personalDataMode = (value: string | undefined): PersonalDataMode =>
  value === 'send' ? 'send' : 'redact';

/** Keys whose values identify or locate a person, wherever they appear. */
const PERSONAL_KEYS = new Set(
  [
    'address',
    'address1',
    'address2',
    'billTo',
    'buyer',
    'city',
    'contact',
    'customerName',
    'email',
    'firstName',
    'lastName',
    'line1',
    'line2',
    'name',
    'phone',
    'postalCode',
    'shipTo',
    'street',
    'zip',
  ].map((k) => k.toLowerCase().replace(/[_-]/g, '')),
);
const isPersonalKey = (key: string) => PERSONAL_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''));

// Free text reaches this from buyers and inbound mail, so it can be hostile: a regex with a
// greedy run before a literal backtracks quadratically on a long run that never completes. These
// are scanners that walk the text once. They mask exactly what the patterns they replaced did
// (`[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}` and `\+?\(?\d[\d\s().-]{6,}\d`), and the
// tests hold them to those on random text.

const LOCAL = /^[\p{L}\p{N}._%+-]$/u;
const DOMAIN = /^[\p{L}\p{N}.-]$/u;
const LETTER = /^\p{L}$/u;
const PHONE_SEPARATOR = /^[\s().-]$/;

/** The code point at `i` as a string, so a surrogate pair is one character. */
const charAt = (text: string, i: number) => String.fromCodePoint(text.codePointAt(i) as number);

/** The end of the run of characters `pattern` accepts that starts at `from`. */
const runEnd = (text: string, from: number, pattern: RegExp) => {
  let i = from;
  while (i < text.length) {
    const c = charAt(text, i);
    if (!pattern.test(c)) break;
    i += c.length;
  }
  return i;
};

/**
 * The end of a domain starting at `from`, or -1: domain characters, then a dot and two or more
 * letters. The pattern takes the last such dot in the run of domain characters.
 */
const domainEnd = (text: string, from: number) => {
  const run = runEnd(text, from, DOMAIN);
  let end = -1;
  let dot = -1;
  let count = 0; // letters after `dot`
  let units = 0; // and their length in UTF-16 units
  const settle = () => {
    // The dot must leave at least one domain character before it.
    if (dot > from && count >= 2) end = dot + 1 + units;
  };
  for (let i = from; i < run; ) {
    const c = charAt(text, i);
    if (c === '.') {
      settle();
      dot = i;
      count = units = 0;
    } else if (dot >= 0 && LETTER.test(c)) {
      count++;
      units += c.length;
    } else {
      settle();
      dot = -1;
    }
    i += c.length;
  }
  settle();
  return end;
};

const maskEmails = (text: string) => {
  let out = '';
  let copied = 0;
  let i = 0;
  while (i < text.length) {
    const c = charAt(text, i);
    if (!LOCAL.test(c)) {
      i += c.length;
      continue;
    }
    // Every start in a run of local characters meets the same '@' (or none), so the run's
    // first character decides for all of them.
    const at = runEnd(text, i, LOCAL);
    const end = text[at] === '@' ? domainEnd(text, at + 1) : -1;
    if (end < 0) {
      i = at;
      continue;
    }
    out += `${text.slice(copied, i)}[email]`;
    copied = i = end;
  }
  return copied === 0 ? text : out + text.slice(copied);
};

const isDigit = (code: number) => code >= 48 && code <= 57;

/**
 * Digits with the usual separators, e.g. +1 (555) 010-0199, are a phone number from the first
 * digit (and a `(` and `+` just before it) to the last, when there are at least nine digits, so a
 * date (2026-10-15) or an amount stays. A run with fewer is left alone and isn't searched again.
 */
const maskPhones = (text: string) => {
  let out = '';
  let copied = 0;
  let i = 0;
  while (i < text.length) {
    if (!isDigit(text.charCodeAt(i)) && !PHONE_SEPARATOR.test(text[i] as string)) {
      i++;
      continue;
    }
    let first = -1;
    let last = -1;
    let digits = 0;
    let j = i;
    for (; j < text.length; j++) {
      if (isDigit(text.charCodeAt(j))) {
        if (first < 0) first = j;
        last = j;
        digits++;
      } else if (!PHONE_SEPARATOR.test(text[j] as string)) break;
    }
    if (digits >= 9) {
      let start = first;
      if (start > i && text[start - 1] === '(') start--;
      if (start > copied && text[start - 1] === '+') start--;
      out += `${text.slice(copied, start)}[phone]`;
      copied = last + 1;
    }
    i = j;
  }
  return copied === 0 ? text : out + text.slice(copied);
};

/** Masks email addresses and phone numbers in free text, in one pass over each. */
export const maskPersonalText = (text: string) => maskPhones(maskEmails(text));

/** A JSON value with personal keys dropped and personal text masked, at any depth. */
export function scrubPersonal(value: unknown): unknown {
  if (typeof value === 'string') return maskPersonalText(value);
  if (Array.isArray(value)) return value.map(scrubPersonal);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !isPersonalKey(k))
        .map(([k, v]) => [k, scrubPersonal(v)]),
    );
  return value;
}

/** The order as a model sees it. Never internal bookkeeping, the document text or payment ids. */
export function modelOrder(order: Order, mode: PersonalDataMode) {
  const facts = {
    id: order.id,
    model: order.model,
    channel: order.channel,
    customerId: order.customerId,
    lines: order.lines.map((l) => ({
      sku: l.sku,
      name: l.name,
      qty: l.qty,
      unitPrice: l.unitPrice,
      ...(l.sellerId ? { sellerId: l.sellerId } : {}),
    })),
    subtotal: order.subtotal,
    shipping: order.shipping ?? 0,
    shippingOption: order.shippingOption,
    tax: order.tax,
    total: order.total,
    baseTotal: order.baseTotal,
    currency: order.currency,
    fulfillment: order.fulfillment ? { method: order.fulfillment.method } : undefined,
  };
  if (mode === 'send')
    return { ...facts, title: order.title, contact: order.contact, meta: order.meta };
  return {
    ...facts,
    title: order.title ? maskPersonalText(order.title) : undefined,
    /** A buyer without a customer account who left contact details. */
    guest: !order.customerId && !!order.contact,
    shipToCountry: shipToCountry(order),
    meta: scrubPersonal(order.meta ?? {}) as Record<string, unknown>,
  };
}

type CustomerRow = {
  id: string;
  name: string;
  email: string;
  kind: string;
  tier: string;
  creditLimit: number;
  balance: number;
  terms: string;
};

/** A customer as a model sees it: their account terms, and only with `send` their name and email. */
export function modelCustomer(customer: CustomerRow | undefined, mode: PersonalDataMode) {
  if (!customer) return undefined;
  const account = {
    id: customer.id,
    kind: customer.kind,
    tier: customer.tier,
    creditLimit: customer.creditLimit,
    balance: customer.balance,
    terms: customer.terms,
  };
  return mode === 'send' ? { ...account, name: customer.name, email: customer.email } : account;
}

/**
 * A model's view of a running order: the order, its customer, the run's vars and completed steps'
 * outputs, each redacted for `mode`. Keys left out stay out.
 */
export type ModelContextInput = {
  order: Order;
  customer?: CustomerRow | undefined;
  vars?: unknown;
  completed?: unknown;
};

export function modelContext(mode: PersonalDataMode, c: ModelContextInput) {
  const loose = (v: unknown) => (mode === 'send' ? v : scrubPersonal(v));
  return {
    order: modelOrder(c.order, mode),
    ...('customer' in c ? { customer: modelCustomer(c.customer, mode) } : {}),
    ...('vars' in c ? { vars: loose(c.vars) } : {}),
    ...('completed' in c ? { completed: loose(c.completed) } : {}),
  };
}
