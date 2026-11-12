import { describe, expect, it } from 'vitest';
import {
  hashShopperCode,
  hashShopperSecret,
  maskShopperEmail,
  newShopperCode,
  newShopperSecret,
  parseShopperOrderCursor,
  SHOPPER_CODE,
  SHOPPER_SECRET,
  shopperCodeKey,
  shopperEmail,
  shopperLinkUrl,
  shopperOrderCursor,
  shopperSignInEmail,
  storefrontKey,
} from '../src';

describe('a shopper’s address', () => {
  it('is trimmed and lower-cased, and null for anything that isn’t an address', () => {
    expect(shopperEmail('  Pat@Example.COM ')).toBe('pat@example.com');
    for (const bad of [
      '',
      'pat',
      'pat@',
      '@example.com',
      'a b@example.com',
      `${'a'.repeat(250)}@x.co`,
      5,
      null,
      undefined,
      {},
    ])
      expect(shopperEmail(bad)).toBeNull();
  });
});

describe('a masked address', () => {
  it('keeps the first character and the domain', () => {
    expect(maskShopperEmail('pat@example.com')).toBe('p***@example.com');
    expect(maskShopperEmail('a@b.co')).toBe('a***@b.co');
    expect(maskShopperEmail('nope')).toBe('***');
  });
});

describe('what is minted', () => {
  it('makes six-digit codes with their leading zeros, and 32-byte secrets in hex', () => {
    const codes = Array.from({ length: 2000 }, newShopperCode);
    for (const c of codes) expect(c).toMatch(SHOPPER_CODE);
    // Uniform enough to show a leading zero (one in ten) and a spread of first digits.
    expect(codes.some((c) => c.startsWith('0'))).toBe(true);
    expect(new Set(codes.map((c) => c[0])).size).toBe(10);
    const secrets = new Set(Array.from({ length: 50 }, newShopperSecret));
    expect(secrets.size).toBe(50);
    for (const s of secrets) expect(s).toMatch(SHOPPER_SECRET);
  });
});

describe('what is stored', () => {
  it('hashes a secret as its SHA-256, and a hash of it is not the secret', async () => {
    // The same vector as sha256('abc').
    expect(await hashShopperSecret('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes a code under the key, bound to the address, so neither moves it', async () => {
    const key = await shopperCodeKey('principal-key');
    const base = await hashShopperCode(key, 'pat@example.com', '123456');
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashShopperCode(key, 'pat@example.com', '123456')).toBe(base);
    expect(await hashShopperCode(key, 'sam@example.com', '123456')).not.toBe(base);
    expect(await hashShopperCode(key, 'pat@example.com', '123457')).not.toBe(base);
    expect(
      await hashShopperCode(await shopperCodeKey('another-key'), 'pat@example.com', '123456'),
    ).not.toBe(base);
    // Not the bare SHA-256 of the code, which a copy of the table could be searched for.
    expect(base).not.toBe(await hashShopperSecret('123456'));
  });

  it('derives its key with a label of its own, neither the principal key nor the storefront’s', async () => {
    const key = await shopperCodeKey('principal-key');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe('principal-key');
    expect(key).not.toBe(await storefrontKey('principal-key'));
  });
});

describe('the sign-in email', () => {
  it('carries the code and the link, and its subject neither', () => {
    const link = shopperLinkUrl('https://shop.example/', 'ab'.repeat(32));
    expect(link).toBe(`https://shop.example/account/confirm/${'ab'.repeat(32)}`);
    const mail = shopperSignInEmail('042917', link);
    expect(mail.text).toContain('042917');
    expect(mail.text).toContain(link);
    expect(mail.html).toContain(`href="${link}"`);
    expect(mail.subject).not.toMatch(/042917|https/);
  });

  it('never names the platform: a buyer gets mail from the merchant’s sender, about their sign-in', () => {
    const mail = shopperSignInEmail('042917', 'https://shop.example/account/confirm/ab');
    expect([mail.subject, mail.text, mail.html].join('\n')).not.toMatch(/commerceworker/i);
  });

  it('escapes every value into its HTML part, so nothing is markup', () => {
    const mail = shopperSignInEmail('<img src=x onerror=alert(1)>', 'https://x.test/?a=1&b="2"');
    expect(mail.html).not.toMatch(/<img|"2"/);
    expect(mail.html).toContain('&lt;img');
    expect(mail.html).toContain('&amp;b=&quot;2&quot;');
  });
});

describe('an order list’s cursor', () => {
  it('round-trips the last order’s time and id', () => {
    const last = { createdAt: 1_700_000_000_000, id: 'ord_abc-123_x' };
    expect(parseShopperOrderCursor(shopperOrderCursor(last))).toEqual(last);
  });

  it('is null for anything the engine didn’t make, so a caller can’t steer the query', () => {
    for (const bad of [
      undefined,
      null,
      7,
      {},
      '',
      '12',
      ':abc',
      '12:',
      '-1:abc',
      '1.5:abc',
      '1234567890123456:abc',
      "12:x' or 1=1",
      '12:a b',
      '12:a:b',
      `12:${'x'.repeat(101)}`,
    ])
      expect(parseShopperOrderCursor(bad)).toBeNull();
  });
});
