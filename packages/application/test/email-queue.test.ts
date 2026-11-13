import { RecordingEmailSender } from '@commerceworker/test-kit';
import { InMemoryMessageStore } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  deliverQueuedEmail,
  queuedEmail,
  recordEmailEvent,
  scrubQueuedEmail,
} from '../src/commerce';

const now = 1_800_000_000_000;
const signIn = (over: Record<string, unknown> = {}) => ({
  kind: 'sign_in',
  to: 'pat@example.com',
  subject: 'Your code',
  text: 'Your code is 123456',
  html: '<p>123456</p>',
  expiresAt: now + 600_000,
  ...over,
});

const ports = (email: RecordingEmailSender | undefined) =>
  ({ email, messages: new InMemoryMessageStore() }) as never;

describe('a queued sign-in code', () => {
  it('is sent while its code is live', async () => {
    const email = new RecordingEmailSender();
    expect(await deliverQueuedEmail(ports(email), signIn(), now)).toEqual({ status: 'sent' });
    expect(email.sent).toEqual([
      {
        to: ['pat@example.com'],
        subject: 'Your code',
        text: 'Your code is 123456',
        html: '<p>123456</p>',
      },
    ]);
  });

  it('is dropped, unsent, once its code has expired', async () => {
    const email = new RecordingEmailSender();
    expect(await deliverQueuedEmail(ports(email), signIn(), now + 600_000)).toEqual({
      status: 'skipped',
      why: 'expired',
    });
    expect(email.sent).toEqual([]);
  });

  it('asks for a retry when Email Sending refuses, and when the sender throws', async () => {
    const refusing = new RecordingEmailSender({
      delivered: false,
      error: 'E_INTERNAL_SERVER_ERROR',
    });
    expect(await deliverQueuedEmail(ports(refusing), signIn(), now)).toEqual({
      status: 'retry',
      error: 'E_INTERNAL_SERVER_ERROR',
    });
    const throwing = {
      send: async () => {
        throw new Error('binding down');
      },
    };
    expect(await deliverQueuedEmail(ports(throwing as never), signIn(), now)).toEqual({
      status: 'retry',
      error: 'binding down',
    });
  });

  it('sends nothing without a sender', async () => {
    expect(await deliverQueuedEmail(ports(undefined), signIn(), now)).toEqual({
      status: 'skipped',
      why: 'not_configured',
    });
  });

  it('keeps no code in what a dead letter keeps', () => {
    const scrubbed = scrubQueuedEmail(signIn());
    expect(scrubbed).toEqual({ kind: 'sign_in', redacted: true, expiresAt: now + 600_000 });
    expect(JSON.stringify(scrubbed)).not.toMatch(/123456|pat@/);
    // A confirmation's job holds no credential, so it is kept whole.
    const confirmation = { kind: 'confirmation', orderId: 'o', messageId: 'm' };
    expect(scrubQueuedEmail(confirmation)).toEqual(confirmation);
    expect(queuedEmail(scrubbed)).toBeNull();
  });
});

describe('recordEmailEvent', () => {
  const event = (type: string, over: Record<string, unknown> = {}) => ({
    type: `cf.email.sending.message.${type}`,
    payload: { messageId: 'prov-1', recipient: 'pat@example.com', ...over },
    metadata: { eventTimestamp: '2026-11-12T10:00:00.000Z' },
  });

  async function sent() {
    const messages = new InMemoryMessageStore();
    const { messageId } = await messages.send('ord_1', 'confirmation', {
      recipient: 'pat@example.com',
      subject: 's',
      body: 'b',
    });
    await messages.markSent(messageId, now, 'prov-1');
    return messages;
  }

  it('records the status on the message the id belongs to, at the event’s time', async () => {
    const messages = await sent();
    expect(await recordEmailEvent(messages, event('delivered'), now)).toEqual({
      status: 'recorded',
      delivery: 'delivered',
    });
    expect(await messages.find('ord_1', 'confirmation')).toMatchObject({
      deliveryStatus: 'delivered',
      deliveryAt: Date.parse('2026-11-12T10:00:00.000Z'),
    });
  });

  it('keeps a bounce’s reason, and a complaint over a delivery, and never an older status over a newer', async () => {
    const messages = await sent();
    await recordEmailEvent(messages, event('delivered'), now);
    await recordEmailEvent(messages, event('complained'), now);
    await recordEmailEvent(messages, event('delivered'), now);
    expect((await messages.find('ord_1', 'confirmation'))?.deliveryStatus).toBe('complained');
    const other = await sent();
    await recordEmailEvent(
      other,
      event('bounced', { bounce: { type: 'hard', reason: '550 5.1.1 User unknown' } }),
      now,
    );
    expect(await other.find('ord_1', 'confirmation')).toMatchObject({
      deliveryStatus: 'bounced',
      deliveryDetail: '550 5.1.1 User unknown',
    });
  });

  it('reports a message no row has (a sign-in code’s), so the consumer can wait for markSent once', async () => {
    const messages = await sent();
    expect(
      await recordEmailEvent(messages, event('delivered', { messageId: 'someone-else' }), now),
    ).toEqual({ status: 'unmatched', delivery: 'delivered' });
  });

  it('ignores what it does not read', async () => {
    const messages = await sent();
    for (const body of [
      null,
      'x',
      {},
      event('opened'),
      { type: 'cf.email.sending.message.delivered', payload: {} },
    ])
      expect(await recordEmailEvent(messages, body, now)).toEqual({ status: 'ignored' });
  });
});
