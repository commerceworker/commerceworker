import { describe, expect, it } from 'vitest';
import { createCfEmailSender, type SendEmailBinding } from '../../src/email-cf/index';

type Sent = Parameters<SendEmailBinding['send']>[0];

function fakeBinding(fail?: Error & { code?: string }) {
  const sent: Sent[] = [];
  const binding: SendEmailBinding = {
    async send(message) {
      if (fail) throw fail;
      sent.push(message);
      return { messageId: `msg-${sent.length}` };
    },
  };
  return { binding, sent };
}

describe('createCfEmailSender', () => {
  it('sends through the binding and returns the message id', async () => {
    const { binding, sent } = fakeBinding();
    const email = createCfEmailSender(binding, { from: 'workflows@example.com' });
    const r = await email.send({
      to: ['editor@example.com'],
      subject: 'Review needed',
      text: 'Please review',
      html: '<p>Please review</p>',
    });
    expect(r).toEqual({ delivered: true, id: 'msg-1' });
    expect(sent).toEqual([
      {
        from: 'workflows@example.com',
        to: 'editor@example.com',
        subject: 'Review needed',
        text: 'Please review',
        html: '<p>Please review</p>',
      },
    ]);
  });

  it('names the sender and de-duplicates recipients', async () => {
    const { binding, sent } = fakeBinding();
    const email = createCfEmailSender(binding, {
      from: 'workflows@example.com',
      fromName: 'commerceworker',
    });
    await email.send({
      to: ['a@example.com', ' a@example.com', 'b@example.com'],
      subject: 's',
      text: 't',
    });
    expect(sent[0]?.from).toEqual({ email: 'workflows@example.com', name: 'commerceworker' });
    expect(sent[0]?.to).toEqual(['a@example.com', 'b@example.com']);
    expect(sent[0]).not.toHaveProperty('html');
  });

  it('reports binding failures with their code instead of throwing', async () => {
    const err = Object.assign(new Error('sender domain is not verified'), {
      code: 'E_SENDER_NOT_VERIFIED',
    });
    const email = createCfEmailSender(fakeBinding(err).binding, { from: 'x@example.com' });
    const r = await email.send({ to: ['a@example.com'], subject: 's', text: 't' });
    expect(r.delivered).toBe(false);
    expect(r.error).toBe('E_SENDER_NOT_VERIFIED: sender domain is not verified');
  });

  it('refuses messages with no or too many recipients', async () => {
    const { binding, sent } = fakeBinding();
    const email = createCfEmailSender(binding, { from: 'x@example.com', maxRecipients: 2 });
    expect(await email.send({ to: [' '], subject: 's', text: 't' })).toEqual({
      delivered: false,
      error: 'No recipients',
    });
    const many = await email.send({
      to: ['a@example.com', 'b@example.com', 'c@example.com'],
      subject: 's',
      text: 't',
    });
    expect(many.delivered).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('refuses an unusable from address at construction', () => {
    expect(() => createCfEmailSender(fakeBinding().binding, { from: 'not-an-address' })).toThrow(
      /EMAIL_FROM/,
    );
  });
});
