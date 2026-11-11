/**
 * Data subject requests: find everything held about one person by their email, export it, erase
 * it. `SubjectStore` reads and erases their rows across the deployment's tables; `ObjectStore`
 * deletes their files; `OrderRuntime` and `CartRuntime` reach the agents that hold the rest in
 * their own storage. `d1SubjectStore` (packages/db) and `InMemorySubjectStore` (packages/test-kit)
 * implement the store, held to one contract.
 */
import type { CheckoutSession, OrderState } from '@commerceworker/core';

/** A customer account with the subject's email. */
export interface SubjectAccount {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly [column: string]: unknown;
}

/** Who a request is about: their email, their accounts, and the orders their email started. */
export interface Subject {
  readonly email: string;
  readonly accounts: readonly SubjectAccount[];
  /** Orders an email from them started (`inbound_emails.order_id`). */
  readonly viaEmail: readonly string[];
  /** The email is also a team member's. */
  readonly teamMember: boolean;
}

/** An order's index row as a request reads it. */
export interface SubjectOrder {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly channel: string;
  readonly externalId: string | null;
  readonly createdAt: number;
  readonly customerId: string | null;
  readonly currency: string;
  readonly total: number;
}

/** Rows about the subject that aren't orders, as stored. */
export interface SubjectRows {
  readonly messages: Record<string, unknown>[];
  readonly documents: { key: string; kind: string; contentType: string; createdAt: number }[];
  readonly inboundEmails: Record<string, unknown>[];
  readonly taxCertificates: Record<string, unknown>[];
  readonly addresses: Record<string, unknown>[];
  /** Their accounts' companies, and the company members with their email (any company). */
  readonly companies: Record<string, unknown>[];
  readonly companyMembers: Record<string, unknown>[];
  /** Purchase orders of their accounts' companies and those their member rows placed (headers). */
  readonly purchaseOrders: Record<string, unknown>[];
  /** Quotes of their accounts' companies and those for their member rows (headers). */
  readonly quotes: Record<string, unknown>[];
}

export interface SubjectStore {
  /** Who `email` (normalized) is. */
  subject(email: string): Promise<Subject>;
  /**
   * The subject's orders not yet erased (by their contact email, their accounts or an email they
   * sent), `active` ones only when asked, up to `limit`.
   */
  orders(subject: Subject, opts: { active?: boolean; limit: number }): Promise<SubjectOrder[]>;
  /** Their messages, documents, inbound emails, certificates, addresses, companies and member rows, for an export. */
  rows(subject: Subject, orderIds: readonly string[]): Promise<SubjectRows>;
  /** Their checkout sessions, as stored. */
  checkouts(email: string, limit: number): Promise<CheckoutSession[]>;
  /** External carts whose buyer is `email`. */
  buyerCarts(email: string, limit: number): Promise<string[]>;
  /** Staff carts for these accounts. */
  customerCarts(customerIds: readonly string[], limit: number): Promise<string[]>;
  /** Carts submitted as these orders. */
  orderCarts(orderIds: readonly string[]): Promise<string[]>;
  /** Whether an erasure of the subject with this audit target was recorded. */
  wasErased(target: string): Promise<boolean>;
  /** Marks an order erased: its contact email gone, `title` its own, its reason cleared if asked. */
  markOrderErased(
    orderId: string,
    erased: { title: string; clearReason: boolean },
    at: number,
  ): Promise<void>;
  /**
   * Erases what belongs to these orders: document rows and webhook deliveries deleted, the buyer
   * scrubbed from the checkouts that placed them, messages and inbound emails blanked.
   */
  eraseOrderRows(orderIds: readonly string[]): Promise<{ messages: number; inboundEmails: number }>;
  /** The files their inbound emails not tied to an order kept. */
  unlinkedFiles(email: string): Promise<string[]>;
  /** Blanks what isn't tied to an order: inbound emails and messages; deletes unplaced checkouts. */
  eraseUnlinked(email: string): Promise<{ messages: number; inboundEmails: number }>;
  /**
   * Deletes an account's certificates and addresses and blanks the account, its company and every
   * member of it (their rows stay, for the orders they placed).
   */
  eraseAccount(
    customerId: string,
  ): Promise<{ taxCertificates: number; addresses: number; companyMembers: number }>;
  /**
   * Blanks the company members with this email, in every company, and marks them removed: their
   * rows stay for the orders they placed. Returns how many.
   */
  eraseMembers(email: string): Promise<number>;
  /**
   * Blanks what the purchase orders of the subject's accounts' companies, and those placed by a
   * member with their email, say of people: the ship-to's name and street lines and the notes, and
   * the buyer. The number, status, currency, lines and the rest of the address stay, as the orders
   * they started do. Run before the members are blanked. Returns how many.
   */
  erasePurchaseOrders(subject: Subject): Promise<number>;
  /**
   * Blanks what the quotes of the subject's accounts' companies, and those for a member with their
   * email, say of people: the notes and the buyer. The name (a staff-written label that could name
   * a person, kept so the quote still reads in lists and on invoiced orders' records), status, version, expiry and lines
   * (prices and quantities) stay, as the orders priced from them do. Run before the members are
   * blanked. Returns how many.
   */
  eraseQuotes(subject: Subject): Promise<number>;
}

/** The file store the subject's documents are in. */
export interface ObjectStore {
  /** Deletes every object under `prefix` (or the one object it names). Returns how many. */
  deletePrefix(prefix: string): Promise<number>;
}

/** The order agents a request reaches. */
export interface OrderRuntime {
  snapshot(orderId: string): Promise<OrderState>;
  /** Erases `terms` from the order's state; null while it hasn't ended. */
  erasePersonalData(
    orderId: string,
    terms: string[],
  ): Promise<{ held: boolean; title: string } | null>;
}

/** What a request asks of the cart agents. */
export interface SubjectCarts {
  subjectExport(cartId: string): Promise<Record<string, unknown> | null>;
  customerExport(cartId: string): Promise<Record<string, unknown> | null>;
  eraseSubject(cartId: string, terms: string[]): Promise<unknown>;
  /** Removes the ship-to a staff cart holds; true if it held one. */
  eraseShipTo(cartId: string): Promise<boolean>;
  eraseFromEvents(cartId: string, terms: string[]): Promise<unknown>;
}
