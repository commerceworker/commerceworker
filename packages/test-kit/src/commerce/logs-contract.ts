/**
 * The behaviour the logs keep: the in-memory stores run it in node and the D1 stores in workerd
 * (packages/db). Ids start `lg_`.
 */
import type {
  IntakeLog,
  PaymentEventLog,
  UsageStore,
  WebhookReceipts,
} from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

export function describeLogsContract(
  name: string,
  make: () => Promise<{
    intake: IntakeLog;
    events: PaymentEventLog;
    usage: UsageStore;
    receipts: WebhookReceipts;
  }>,
) {
  describe(`${name}: the logs contract`, () => {
    it('records an inbound email once by its message id', async () => {
      const { intake } = await make();
      const email = {
        id: 'lg_e1',
        messageId: '<lg-1@example.com>',
        mailbox: 'orders@shop.example',
        sender: 'buyer@example.com',
        subject: 'PO 1',
        status: 'accepted',
        receivedAt: 1,
      };
      await intake.record(email);
      await intake.record({ ...email, id: 'lg_e2', status: 'duplicate' });
    });

    it('claims a payment event once, and frees one whose handling failed', async () => {
      const { events } = await make();
      expect(await events.claim('lg_evt_1', 'stripe', 'invoice.paid', 1)).toBe(true);
      expect(await events.claim('lg_evt_1', 'stripe', 'invoice.paid', 2)).toBe(false);
      await events.link('lg_evt_1', 'ord_1');
      await events.release('lg_evt_1');
      expect(await events.claim('lg_evt_1', 'stripe', 'invoice.paid', 3)).toBe(true);
    });

    it('takes a signed webhook once, gives back a failed one, and lets an expired one go', async () => {
      const { receipts } = await make();
      const T = 9_000_000_000_000;
      const TTL = 600_000;
      expect(await receipts.claim('lg_sig_1', T, TTL)).toBe(true);
      expect(await receipts.claim('lg_sig_1', T + 1, TTL)).toBe(false);
      await receipts.release('lg_sig_1');
      expect(await receipts.claim('lg_sig_1', T + 2, TTL)).toBe(true);
      // Past the window, the old receipt is dropped and the id taken afresh.
      expect(await receipts.claim('lg_sig_1', T + 2 + TTL + 1, TTL)).toBe(true);
      expect(await receipts.claim('lg_sig_2', T + 2 + TTL + 1, TTL)).toBe(true);
    });

    it("adds a person's tokens per day, and prunes old days", async () => {
      const { usage } = await make();
      await usage.add('lg_usr', '2026-10-01', 100);
      await usage.add('lg_usr', '2026-10-01', 50);
      await usage.add('lg_usr', '2026-11-01', 5);
      expect(await usage.tokens('lg_usr', '2026-10-01')).toBe(150);
      expect(await usage.tokens('lg_other', '2026-10-01')).toBe(0);
      expect(await usage.prune('2026-10-15')).toBeGreaterThanOrEqual(1);
      expect(await usage.tokens('lg_usr', '2026-10-01')).toBe(0);
      expect(await usage.tokens('lg_usr', '2026-11-01')).toBe(5);
    });
  });
}
