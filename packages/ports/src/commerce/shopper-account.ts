/**
 * What a shopper's account pages need beyond the order index and the address book: the ship-to an
 * order recorded, as the order's own state holds it. The engine implements the reader over the
 * order's agent, where the structured address lives (the index row has none).
 */
export interface OrderShipTos {
  /** The order's `meta.shipTo` as recorded (a string or an address object), or null for an order with none. */
  read(orderId: string): Promise<unknown>;
}
