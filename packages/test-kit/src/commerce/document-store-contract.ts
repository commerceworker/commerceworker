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
  });
}
