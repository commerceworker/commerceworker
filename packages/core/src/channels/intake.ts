/**
 * Durable channel intake: a Shopify order webhook or an EDI 850 interchange is verified, its raw body
 * written to `DOCS` (`intakeKey`) and a pointer queued (`IntakeMessage`); the engine's consumer maps
 * and starts the orders later, by their channel and external id, so a redelivery starts nothing twice.
 * Both ends map with the functions here, so what the web app accepted is what the engine starts.
 */

import { type InboundOrder, inboundOrderSchema } from '../inbound';
import { shopifyToInbound } from './shopify';
import { parseX12, x12850ToInbound } from './x12';

/**
 * Who the audit trail names as starting the orders: the API caller who posted the EDI, by id alone.
 * A message that dead-letters is kept for months, so it carries no name or email.
 */
export type IntakeActor = { kind: string; id: string };

/** What the intake queue carries: where the raw body is, and what the web app decided about it. */
export type IntakeMessage =
  | {
      channel: 'shopify';
      key: string;
      receivedAt: number;
      shop: string;
      /** Routed when it was accepted (`ORDER_ROUTES`), so the consumer needs no route table. */
      flowId: string;
    }
  | {
      channel: 'edi';
      key: string;
      receivedAt: number;
      sender: string;
      /** The customer `EDI_PARTNERS` maps the sender to, resolved when it was accepted. */
      customerId: string;
      /** The flow for each transaction, by its control number. */
      flows: Record<string, string>;
      actor: IntakeActor;
    };

export const isIntakeMessage = (v: unknown): v is IntakeMessage => {
  const m = v as Partial<IntakeMessage> | null;
  if (!m || typeof m.key !== 'string' || typeof m.receivedAt !== 'number') return false;
  if (m.channel === 'shopify') return typeof m.shop === 'string' && typeof m.flowId === 'string';
  return (
    m.channel === 'edi' &&
    typeof m.sender === 'string' &&
    typeof m.customerId === 'string' &&
    !!m.flows &&
    typeof m.flows === 'object' &&
    !!m.actor &&
    typeof m.actor.id === 'string'
  );
};

/** `intake/<channel>/<date>/<id>`: the date is the day it was received, UTC. */
export const intakeKey = (channel: IntakeMessage['channel'], at: Date, id: string) =>
  `intake/${channel}/${at.toISOString().slice(0, 10)}/${id}`;

/** One order of an intake body, mapped and validated, or why it can't be. */
export type MappedIntake =
  | { ok: true; control?: string; poNumber?: string; order: InboundOrder }
  | { ok: false; control?: string; error: string };

/** A Shopify `orders/create` body as the order it starts. */
export function mapShopifyIntake(raw: string, customerId?: string): MappedIntake {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Body must be JSON' };
  }
  const mapped = shopifyToInbound(body as Parameters<typeof shopifyToInbound>[0], { customerId });
  if (!mapped.ok) return { ok: false, error: mapped.error };
  const parsed = inboundOrderSchema.safeParse(mapped.order);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid order' };
  return { ok: true, order: parsed.data };
}

/** An X12 interchange as its purchase orders, in interchange order, each mapped or refused. */
export function mapEdiIntake(
  text: string,
  partner: { sender: string; customerId: string },
): { ok: true; orders: MappedIntake[] } | { ok: false; error: string } {
  const parsed = parseX12(text);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    orders: parsed.interchange.transactions.map((tx): MappedIntake => {
      const mapped = x12850ToInbound(tx, partner);
      if (!mapped.ok) return { ok: false, control: tx.control, error: mapped.error };
      const valid = inboundOrderSchema.safeParse(mapped.order);
      if (!valid.success)
        return {
          ok: false,
          control: tx.control,
          error: valid.error.issues[0]?.message ?? 'Invalid order',
        };
      return {
        ok: true,
        control: tx.control,
        poNumber: (mapped.order.meta.edi as { poNumber: string }).poNumber,
        order: valid.data,
      };
    }),
  };
}
