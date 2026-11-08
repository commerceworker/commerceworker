import { beforeEach, describe, expect, it, vi } from 'vitest';

const env: Record<string, unknown> = {};
vi.mock('cloudflare:workers', () => ({ env, waitUntil: () => {} }));

const { emailSender, sendsEmail } = await import('~/lib/env.server');

const binding = { send: async () => ({ messageId: 'm' }) };

beforeEach(() => {
  for (const k of Object.keys(env)) delete env[k];
});

describe('the web Worker’s email settings', () => {
  it('send nothing without the EMAIL binding', () => {
    expect(sendsEmail()).toBe(false);
    expect(emailSender()).toBeUndefined();
  });

  it('send through the binding from EMAIL_FROM', async () => {
    Object.assign(env, { EMAIL: binding, EMAIL_FROM: 'cms@example.com' });
    expect(sendsEmail()).toBe(true);
    expect(await emailSender()!.send({ to: ['a@example.com'], subject: 's', text: 't' })).toEqual({
      delivered: true,
      id: 'm',
    });
  });

  it('refuse EMAIL bound without EMAIL_FROM, as the engine does, rather than send nothing', () => {
    Object.assign(env, { EMAIL: binding, EMAIL_FROM: '' });
    const error = /EMAIL send_email binding is set but EMAIL_FROM is not/;
    expect(() => sendsEmail()).toThrow(error);
    expect(() => emailSender()).toThrow(error);
  });
});
