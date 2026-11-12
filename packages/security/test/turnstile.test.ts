import { describe, expect, it, vi } from 'vitest';
import { checkTurnstileForm, siteverify, TOKEN_FIELD } from '../src/turnstile';

/** A Siteverify that answers `body`, recording what it was asked. */
function fake(body: unknown, status = 200) {
  const asked: URLSearchParams[] = [];
  const fetcher = vi.fn(async (_u: unknown, init?: RequestInit) => {
    asked.push(init?.body as URLSearchParams);
    return new Response(JSON.stringify(body), { status });
  });
  return { fetcher: fetcher as unknown as typeof fetch, asked };
}

const pass = { success: true, hostname: 'shop.test', action: 'checkout_pay' };
const form = (token?: string) => {
  const f = new FormData();
  if (token !== undefined) f.set(TOKEN_FIELD, token);
  return f;
};
const input = (over: Record<string, unknown> = {}) => ({
  siteKey: '0x4AAAAAAAtest' as string | null,
  secret: 's3cret' as string | undefined,
  request: new Request('https://shop.test/checkout/chk_1', {
    headers: { 'cf-connecting-ip': '203.0.113.7' },
  }),
  form: form('tok'),
  action: 'checkout_pay' as const,
  unavailable: 'Not available.',
  ...over,
});

describe('Turnstile for a form', () => {
  it('passes a token that passed Siteverify for this action on this host, and sends who asked', async () => {
    const { fetcher, asked } = fake(pass);
    expect(await checkTurnstileForm(input(), fetcher)).toBeNull();
    expect(Object.fromEntries(asked[0]!)).toEqual({
      secret: 's3cret',
      response: 'tok',
      remoteip: '203.0.113.7',
    });
  });

  it('is no check at all for a deployment with no site key, and asks nobody', async () => {
    const { fetcher } = fake(pass);
    expect(await checkTurnstileForm(input({ siteKey: null }), fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses everything for a site key with no secret, saying only what the caller wrote', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fetcher } = fake(pass);
    expect(await checkTurnstileForm(input({ secret: undefined }), fetcher)).toEqual({
      error: 'Not available.',
      status: 503,
    });
    expect(fetcher).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('refuses no token, another action, another host, a failure and an unreachable Siteverify', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await checkTurnstileForm(input({ form: form() }), fake(pass).fetcher)).toMatchObject({
      status: 400,
    });
    expect(
      await checkTurnstileForm(input(), fake({ ...pass, action: 'login' }).fetcher),
    ).toMatchObject({ status: 403 });
    expect(
      await checkTurnstileForm(input(), fake({ ...pass, hostname: 'other.test' }).fetcher),
    ).toMatchObject({ status: 403 });
    expect(await checkTurnstileForm(input(), fake({ success: false }).fetcher)).toMatchObject({
      status: 403,
    });
    expect(await checkTurnstileForm(input(), fake({}, 500).fetcher)).toMatchObject({ status: 503 });
    log.mockRestore();
  });

  it('knows the checkout_pay action: a token for it passes siteverify, one for sign-in does not', async () => {
    const base = { secret: 's', token: 't', hostname: 'shop.test' };
    expect(await siteverify({ ...base, action: 'checkout_pay' }, fake(pass).fetcher)).toEqual({
      ok: true,
    });
    expect(await siteverify({ ...base, action: 'login' }, fake(pass).fetcher)).toEqual({
      ok: false,
      reason: 'wrong-action',
    });
  });
});
