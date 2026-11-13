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

    const STALE = 600_000;

    it('claims a payment event once, and frees one whose handling failed or answered retry', async () => {
      const { events } = await make();
      expect(await events.claim('lg_evt_1', 'stripe', 'invoice.paid', 1, STALE)).toBe('claimed');
      expect(await events.claim('lg_evt_1', 'stripe', 'invoice.paid', 2, STALE)).toBe('processing');
      await events.link('lg_evt_1', 'ord_1');
      await events.release('lg_evt_1');
      expect(await events.claim('lg_evt_1', 'stripe', 'invoice.paid', 3, STALE)).toBe('claimed');
      expect(await events.fail('lg_evt_1')).toEqual({ failures: 1, poisoned: false });
      expect(await events.claim('lg_evt_1', 'stripe', 'invoice.paid', 4, STALE)).toBe('claimed');
    });

    it('takes a claim over only once it is stale', async () => {
      const { events } = await make();
      const T = 1_000_000;
      expect(await events.claim('lg_evt_stale', 'stripe', 'refund.created', T, STALE)).toBe(
        'claimed',
      );
      // Its taker never finished: fresh until ten minutes have passed, then anyone's.
      expect(
        await events.claim('lg_evt_stale', 'stripe', 'refund.created', T + STALE - 1, STALE),
      ).toBe('processing');
      expect(await events.claim('lg_evt_stale', 'stripe', 'refund.created', T + STALE, STALE)).toBe(
        'claimed',
      );
      // The new claim is fresh again.
      expect(
        await events.claim('lg_evt_stale', 'stripe', 'refund.created', T + STALE + 1, STALE),
      ).toBe('processing');
    });

    it('gives exactly one of several concurrent takers a claim, new or stale', async () => {
      const { events } = await make();
      const T = 2_000_000;
      const race = (id: string, now: number) =>
        Promise.all(
          Array.from({ length: 6 }, () => events.claim(id, 'stripe', 'refund.created', now, STALE)),
        );
      const fresh = await race('lg_evt_race', T);
      expect(fresh.filter((c) => c === 'claimed')).toHaveLength(1);
      const stale = await race('lg_evt_race', T + STALE);
      expect(stale.filter((c) => c === 'claimed')).toHaveLength(1);
      expect(stale.filter((c) => c === 'processing')).toHaveLength(5);
    });

    it('keeps a finished event a duplicate, however old', async () => {
      const { events } = await make();
      expect(await events.claim('lg_evt_done', 'stripe', 'invoice.paid', 1, STALE)).toBe('claimed');
      await events.finish('lg_evt_done', 'handled');
      expect(await events.claim('lg_evt_done', 'stripe', 'invoice.paid', 2, STALE)).toBe('done');
      expect(await events.claim('lg_evt_done', 'stripe', 'invoice.paid', 1e12, STALE)).toBe('done');
      // A late release of a finished claim does not reopen it.
      await events.release('lg_evt_done');
      expect(await events.claim('lg_evt_done', 'stripe', 'invoice.paid', 1e12, STALE)).toBe('done');
    });

    it('counts failures, and poisons the event at the limit, once', async () => {
      const { events } = await make();
      const id = 'lg_evt_poison';
      for (let n = 1; n <= 4; n++) {
        expect(await events.claim(id, 'stripe', 'charge.refunded', n, STALE)).toBe('claimed');
        expect(await events.fail(id, 5)).toEqual({ failures: n, poisoned: false });
      }
      expect(await events.claim(id, 'stripe', 'charge.refunded', 5, STALE)).toBe('claimed');
      expect(await events.fail(id, 5)).toEqual({ failures: 5, poisoned: true });
      // Set aside: not claimable, even long after.
      expect(await events.claim(id, 'stripe', 'charge.refunded', 6, STALE)).toBe('poisoned');
      expect(await events.claim(id, 'stripe', 'charge.refunded', 1e12, STALE)).toBe('poisoned');
      // Without a limit, failures are counted and the event is never poisoned.
      const other = 'lg_evt_nolimit';
      for (let n = 1; n <= 7; n++) {
        await events.claim(other, 'stripe', 'charge.refunded', n, STALE);
        expect(await events.fail(other)).toEqual({ failures: n, poisoned: false });
      }
    });

    it('keeps a reconciliation cursor per provider that only moves forward', async () => {
      const { events } = await make();
      expect(await events.cursor('lg_prov')).toBeUndefined();
      await events.advance('lg_prov', 100, 1);
      await events.advance('lg_prov', 50, 2);
      expect(await events.cursor('lg_prov')).toBe(100);
      await events.advance('lg_prov', 150, 3);
      expect(await events.cursor('lg_prov')).toBe(150);
      expect(await events.cursor('lg_other')).toBeUndefined();
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
