import { signWebhook } from '@commerceworker/core';
import { describe, expect, it } from 'vitest';
import { verifyCommerceWebhook } from '../src/webhooks.js';

// The sender is core's `signWebhook`, the code that signs outbound deliveries, so these tests hold
// the SDK's verifier to the real format rather than to a copy of it.
const body = JSON.stringify({
  id: 'd1',
  event: 'order.paid',
  orderId: 'o1',
  data: { total: 12.5 },
});
const now = 1_800_000_000;

describe('verifyCommerceWebhook', () => {
  it('accepts a delivery core signed', async () => {
    const header = await signWebhook('whsec_a', body, now);
    expect(await verifyCommerceWebhook(body, header, 'whsec_a', { nowSec: now })).toEqual({
      ok: true,
      timestamp: now,
    });
  });

  it('accepts the raw bytes as well as the text, and non-ASCII bodies', async () => {
    const text = JSON.stringify({ title: 'Café ☕ ünïcode' });
    const header = await signWebhook('s', text, now);
    const bytes = new TextEncoder().encode(text);
    expect((await verifyCommerceWebhook(bytes, header, 's', { nowSec: now })).ok).toBe(true);
  });

  it('names the integration a signature carries', async () => {
    const header = await signWebhook('s', body, now, 'int_1');
    expect(await verifyCommerceWebhook(body, header, 's', { nowSec: now })).toEqual({
      ok: true,
      timestamp: now,
      keyId: 'int_1',
    });
  });

  it('accepts either secret during a rotation, on either side of it', async () => {
    const rotating = await signWebhook(['new', 'old'], body, now);
    expect((await verifyCommerceWebhook(body, rotating, 'old', { nowSec: now })).ok).toBe(true);
    expect((await verifyCommerceWebhook(body, rotating, 'new', { nowSec: now })).ok).toBe(true);
    const oldOnly = await signWebhook('old', body, now);
    expect((await verifyCommerceWebhook(body, oldOnly, ['new', 'old'], { nowSec: now })).ok).toBe(
      true,
    );
  });

  it('refuses a wrong secret, a changed body and a tampered signature', async () => {
    const header = await signWebhook('right', body, now);
    const opts = { nowSec: now };
    expect(await verifyCommerceWebhook(body, header, 'wrong', opts)).toEqual({
      ok: false,
      reason: 'Signature mismatch',
    });
    expect((await verifyCommerceWebhook(`${body} `, header, 'right', opts)).ok).toBe(false);
    const flipped = header.replace(/v1=(.)/, (_m, c: string) => `v1=${c === 'a' ? 'b' : 'a'}`);
    expect((await verifyCommerceWebhook(body, flipped, 'right', opts)).ok).toBe(false);
  });

  it('refuses a replay outside the tolerance, in either direction, and honors a custom one', async () => {
    const header = await signWebhook('s', body, now);
    const late = await verifyCommerceWebhook(body, header, 's', { nowSec: now + 301 });
    expect(late).toEqual({ ok: false, reason: 'Timestamp outside the tolerance' });
    expect((await verifyCommerceWebhook(body, header, 's', { nowSec: now - 301 })).ok).toBe(false);
    expect(
      (await verifyCommerceWebhook(body, header, 's', { nowSec: now + 301, toleranceSec: 600 })).ok,
    ).toBe(true);
  });

  it('refuses a missing or malformed header without throwing', async () => {
    for (const header of [null, undefined, '', 'garbage', 't=abc,v1=ff', `t=${now}`, `v1=ff`]) {
      const r = await verifyCommerceWebhook(body, header, 's', { nowSec: now });
      expect(r.ok, String(header)).toBe(false);
    }
  });

  it('cannot be fooled by moving the timestamp: it is part of what is signed', async () => {
    const header = await signWebhook('s', body, now);
    const moved = header.replace(`t=${now}`, `t=${now + 10}`);
    expect((await verifyCommerceWebhook(body, moved, 's', { nowSec: now + 10 })).ok).toBe(false);
  });
});
