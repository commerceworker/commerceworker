/**
 * The behaviour every `DocumentStore` and `MessageStore` keeps: the in-memory stores run it in node
 * and the D1 and R2 stores in workerd (packages/db). Order ids start `dc_`, which the D1 runner
 * clears before each case.
 */
import type { DocumentStore, MessageStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

export function describeDocumentStoreContract(
  name: string,
  make: () => Promise<{ documents: DocumentStore; messages: MessageStore }>,
) {
  describe(`${name}: the documents and messages contract`, () => {
    it('files a document by order, kind and name, and reads it back', async () => {
      const { documents } = await make();
      const key = await documents.put('dc_o1', 'invoice', 'invoice-1.html', '<p>one</p>');
      expect(key).toBe('orders/dc_o1/invoice/invoice-1.html');
      expect(await documents.text(key)).toBe('<p>one</p>');
      expect(await documents.text('orders/dc_o1/invoice/none.html')).toBeUndefined();
    });

    it('replaces the body when filed again, keeping one record', async () => {
      const { documents } = await make();
      await documents.put('dc_o2', 'po', 'po.txt', 'first', 'text/plain; charset=utf-8');
      const key = await documents.put(
        'dc_o2',
        'po',
        'po.txt',
        'second',
        'text/plain; charset=utf-8',
      );
      await documents.put('dc_o2', 'invoice', 'a.html', '<p/>');
      expect(await documents.text(key)).toBe('second');
      expect(await documents.list('dc_o2')).toEqual([
        {
          key: 'orders/dc_o2/invoice/a.html',
          orderId: 'dc_o2',
          kind: 'invoice',
          contentType: 'text/html; charset=utf-8',
        },
        { key, orderId: 'dc_o2', kind: 'po', contentType: 'text/plain; charset=utf-8' },
      ]);
    });

    it('files a binary body, under its own kind', async () => {
      const { documents } = await make();
      const key = await documents.put(
        'dc_o4',
        'inbound',
        'message.eml',
        new TextEncoder().encode('From: a@example.com'),
        'message/rfc822',
        'email',
      );
      expect(key).toBe('orders/dc_o4/inbound/message.eml');
      expect(await documents.text(key)).toBe('From: a@example.com');
      expect((await documents.list('dc_o4'))[0]).toMatchObject({
        kind: 'email',
        contentType: 'message/rfc822',
      });
    });

    it('queues a message once per order and step', async () => {
      const { messages } = await make();
      const m = { recipient: 'a@example.com', subject: 'Shipped', body: 'On its way' };
      expect(await messages.send('dc_o3', 'notify#1', m)).toEqual({
        messageId: 'msg_dc_o3_notify_1',
        recipient: 'a@example.com',
        subject: 'Shipped',
      });
      await messages.send('dc_o3', 'notify#1', { ...m, body: 'again' });
      await messages.send('dc_o3', 'notify#1:seller', m);
      expect((await messages.messages('dc_o3')).map((r) => [r.messageId, r.body])).toEqual([
        ['msg_dc_o3_notify_1', 'On its way'],
        ['msg_dc_o3_notify_1_seller', 'On its way'],
      ]);
    });

    it('records when a message went out, once, and why one did not', async () => {
      const { messages } = await make();
      const m = { recipient: 'a@example.com', subject: 'Confirmed', body: 'Thanks' };
      const { messageId } = await messages.send('dc_o5', 'confirmation', m);
      expect(await messages.find('dc_o5', 'confirmation')).toMatchObject({
        messageId,
        sentAt: null,
        error: null,
      });
      await messages.markFailed(messageId, 'Email sending is not configured');
      expect((await messages.find('dc_o5', 'confirmation'))?.error).toBe(
        'Email sending is not configured',
      );
      await messages.markSent(messageId, 1000);
      await messages.markSent(messageId, 2000);
      await messages.markFailed(messageId, 'late failure');
      expect(await messages.find('dc_o5', 'confirmation')).toMatchObject({
        sentAt: 1000,
        error: null,
      });
      expect(await messages.find('dc_o5', 'none')).toBeUndefined();
    });

    it('keeps the id Email Sending returned, once, and finds the message by it', async () => {
      const { messages } = await make();
      const m = { recipient: 'a@example.com', subject: 'Confirmed', body: 'Thanks' };
      const { messageId } = await messages.send('dc_o6', 'confirmation', m);
      await messages.markSent(messageId, 1000, 'prov-1');
      await messages.markSent(messageId, 2000, 'prov-2');
      expect(await messages.find('dc_o6', 'confirmation')).toMatchObject({
        sentAt: 1000,
        providerId: 'prov-1',
        deliveryStatus: null,
      });
      expect(await messages.recordDelivery('prov-1', 'delivered', 1500)).toBe(true);
      expect(await messages.recordDelivery('nobody', 'delivered', 1500)).toBe(false);
    });

    it('records the newest delivery status an event reports, never an older one over it', async () => {
      const { messages } = await make();
      const m = { recipient: 'a@example.com', subject: 'Confirmed', body: 'Thanks' };
      const { messageId } = await messages.send('dc_o7', 'confirmation', m);
      await messages.markSent(messageId, 1000, 'prov-7');
      const state = async () => {
        const r = await messages.find('dc_o7', 'confirmation');
        return [r?.deliveryStatus, r?.deliveryAt, r?.deliveryDetail];
      };
      await messages.recordDelivery('prov-7', 'deferred', 1100, '451 try later');
      expect(await state()).toEqual(['deferred', 1100, '451 try later']);
      await messages.recordDelivery('prov-7', 'delivered', 1200);
      expect(await state()).toEqual(['delivered', 1200, null]);
      // A late deferral or a repeat changes nothing; a complaint follows a delivery.
      await messages.recordDelivery('prov-7', 'deferred', 1300);
      await messages.recordDelivery('prov-7', 'delivered', 1400);
      expect(await state()).toEqual(['delivered', 1200, null]);
      expect(await messages.recordDelivery('prov-7', 'complained', 1500, 'abuse')).toBe(true);
      expect(await state()).toEqual(['complained', 1500, 'abuse']);
      await messages.recordDelivery('prov-7', 'bounced', 1600);
      expect(await state()).toEqual(['complained', 1500, 'abuse']);
    });

    it('keeps the first of two peer failures', async () => {
      const { messages } = await make();
      const m = { recipient: 'a@example.com', subject: 'Confirmed', body: 'Thanks' };
      const { messageId } = await messages.send('dc_o8', 'confirmation', m);
      await messages.markSent(messageId, 1000, 'prov-8');
      await messages.recordDelivery('prov-8', 'bounced', 1100);
      await messages.recordDelivery('prov-8', 'failed', 1200);
      expect((await messages.find('dc_o8', 'confirmation'))?.deliveryStatus).toBe('bounced');
    });
  });
}
