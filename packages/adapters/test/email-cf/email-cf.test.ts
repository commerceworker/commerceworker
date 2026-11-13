import { describe, expect, it } from 'vitest';
import {
  createCfEmailSender,
  FALLBACK_CODES,
  type SendEmailBinding,
  withFallbackSender,
} from '../../src/email-cf/index';

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
    expect(r.code).toBe('E_SENDER_NOT_VERIFIED');
  });

  it('refuses a recipient that is not an address, sending nothing', async () => {
    const { binding, sent } = fakeBinding();
    const email = createCfEmailSender(binding, { from: 'x@example.com' });
    for (const to of [
      'not an address',
      'a@b',
      'Bob <b@example.com>',
      'a@example.com\nBcc: z@example.com',
    ])
      expect(await email.send({ to: ['ok@example.com', to], subject: 's', text: 't' })).toEqual({
        delivered: false,
        error: 'Not an email address',
      });
    expect(sent).toEqual([]);
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

  it('judges an address by its shape, and a hostile one in linear time', () => {
    const make = (from: string) => () => createCfEmailSender(fakeBinding().binding, { from });
    expect(make('a@b.c')).not.toThrow();
    for (const bad of ['a@b', 'a@@b.c', '@b.c', 'a@b.', 'a@.b', 'a b@c.d', 'Ann <a@b.c>']) {
      expect(make(bad), bad).toThrow(/EMAIL_FROM/);
    }
    const start = performance.now();
    expect(make(`!@${'!.'.repeat(50_000)}`)).not.toThrow();
    expect(make(`!@${'!'.repeat(100_000)}`)).toThrow(/EMAIL_FROM/);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('withFallbackSender', () => {
  const failing = (code?: string) => Object.assign(new Error('refused'), code ? { code } : {});
  const message = { to: ['buyer@example.com'], subject: 's', text: 't' };
  const pair = (
    primaryFails?: Error & { code?: string },
    fallbackFails?: Error & { code?: string },
  ) => {
    const primary = fakeBinding(primaryFails);
    const fallback = fakeBinding(fallbackFails);
    return {
      primary,
      fallback,
      sender: withFallbackSender(
        createCfEmailSender(primary.binding, { from: 'orders@main.example.com' }),
        createCfEmailSender(fallback.binding, { from: 'orders@backup.example.net' }),
      ),
    };
  };

  it('sends from the primary and never touches the fallback when it works', async () => {
    const { sender, primary, fallback } = pair();
    expect(await sender.send(message)).toEqual({ delivered: true, id: 'msg-1' });
    expect(primary.sent).toHaveLength(1);
    expect(fallback.sent).toHaveLength(0);
  });

  it.each([...FALLBACK_CODES])(
    'sends from the fallback when the primary answers %s',
    async (code) => {
      const { sender, primary, fallback } = pair(failing(code));
      expect(await sender.send(message)).toEqual({ delivered: true, id: 'msg-1' });
      expect(primary.sent).toHaveLength(0);
      expect(fallback.sent).toEqual([
        { from: 'orders@backup.example.net', to: 'buyer@example.com', subject: 's', text: 't' },
      ]);
    },
  );

  it.each([
    'E_RATE_LIMIT_EXCEEDED',
    'E_DAILY_LIMIT_EXCEEDED',
    'E_RECIPIENT_SUPPRESSED',
    'E_ACCOUNT_SUSPENDED',
    'E_VALIDATION_ERROR',
    undefined,
  ])('does not try the fallback for %s: it is the same account and message', async (code) => {
    const { sender, fallback } = pair(failing(code));
    const r = await sender.send(message);
    expect(r.delivered).toBe(false);
    expect(r.code).toBe(code);
    expect(fallback.sent).toHaveLength(0);
  });

  it('reports both refusals when the fallback fails too', async () => {
    const { sender } = pair(failing('E_SENDER_NOT_VERIFIED'), failing('E_INTERNAL_SERVER_ERROR'));
    const r = await sender.send(message);
    expect(r.delivered).toBe(false);
    expect(r.error).toMatch(/E_SENDER_NOT_VERIFIED.*fallback: E_INTERNAL_SERVER_ERROR/);
  });
});
