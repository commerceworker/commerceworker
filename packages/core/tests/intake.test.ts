import { describe, expect, it } from 'vitest';
import {
  authenticated,
  composeDocument,
  DEFAULT_INTAKE_MAILBOXES,
  flowForMailbox,
  htmlToText,
  MAX_DOCUMENT_CHARS,
  parseMailboxes,
  resolveSender,
  splitAddress,
} from '../src';

const customers = [
  { id: 'cus_northwind', email: 'purchasing@northwind.example' },
  { id: 'cus_ada', email: 'ada@gmail.com' },
];

describe('mailboxes', () => {
  it('maps local parts to flows, ignoring case and +tags', () => {
    expect(flowForMailbox('Orders@commerceworker.com', DEFAULT_INTAKE_MAILBOXES)).toBe(
      'tpl-b2b-order',
    );
    expect(flowForMailbox('orders+acme@commerceworker.com', DEFAULT_INTAKE_MAILBOXES)).toBe(
      'tpl-b2b-order',
    );
    expect(flowForMailbox('purchasing@commerceworker.com', DEFAULT_INTAKE_MAILBOXES)).toBe(
      'tpl-purchase-request',
    );
    expect(flowForMailbox('hello@commerceworker.com', DEFAULT_INTAKE_MAILBOXES)).toBeUndefined();
  });

  it('parses configured mailboxes and falls back on bad config', () => {
    expect(parseMailboxes('{"Sales":"flow-x"}')).toEqual({ sales: 'flow-x' });
    expect(parseMailboxes('not json')).toBe(DEFAULT_INTAKE_MAILBOXES);
    expect(parseMailboxes('')).toBe(DEFAULT_INTAKE_MAILBOXES);
  });
});

describe('senders', () => {
  it('matches a customer address exactly, or by company domain', () => {
    expect(resolveSender('Purchasing@Northwind.example', customers, '')).toMatchObject({
      allowed: true,
      customerId: 'cus_northwind',
      via: 'customer',
    });
    expect(resolveSender('priya@northwind.example', customers, '')).toMatchObject({
      allowed: true,
      customerId: 'cus_northwind',
      via: 'domain',
    });
  });

  it('never matches a webmail domain by domain alone', () => {
    expect(resolveSender('ada@gmail.com', customers, '')).toMatchObject({ customerId: 'cus_ada' });
    expect(resolveSender('mallory@gmail.com', customers, '')).toEqual({ allowed: false });
  });

  it('accepts allowlisted addresses and domains without a customer', () => {
    expect(resolveSender('me@example.org', customers, 'me@example.org')).toEqual({
      allowed: true,
      via: 'allowlist',
    });
    expect(resolveSender('anyone@partner.io', customers, 'x@y.com, @partner.io')).toEqual({
      allowed: true,
      via: 'allowlist',
    });
    expect(resolveSender('anyone@other.io', customers, '@partner.io')).toEqual({ allowed: false });
  });
});

describe('authentication', () => {
  const from = 'Buyer <buyer@northwind.example>';

  it('accepts a pass for the From domain recorded by Email Routing', () => {
    expect(
      authenticated('mx.cloudflare.net; dkim=pass header.d=northwind.example; spf=fail', from),
    ).toBe(true);
    expect(authenticated('mx.cloudflare.net; dmarc=pass header.from=northwind.example', from)).toBe(
      true,
    );
    expect(
      authenticated(
        'mx.cloudflare.net; spf=pass smtp.mailfrom=bounce@mail.northwind.example',
        from,
      ),
    ).toBe(true);
  });

  it('refuses a pass for another domain', () => {
    expect(authenticated('mx.cloudflare.net; dkim=pass header.d=attacker.example', from)).toBe(
      false,
    );
    expect(authenticated('mx.cloudflare.net; dmarc=pass header.from=attacker.example', from)).toBe(
      false,
    );
    expect(
      authenticated('mx.cloudflare.net; spf=pass smtp.mailfrom=x@evilnorthwind.example', from),
    ).toBe(false);
    expect(authenticated('mx.cloudflare.net; dkim=pass header.d=example', from)).toBe(false);
  });

  it('reads only the first header, and only when Email Routing wrote it', () => {
    expect(
      authenticated(
        'mx.cloudflare.net; dmarc=fail; spf=softfail, mx.cloudflare.net; dkim=pass header.d=northwind.example',
        from,
      ),
    ).toBe(false);
    expect(authenticated('mx.attacker.example; dkim=pass header.d=northwind.example', from)).toBe(
      false,
    );
  });

  it('refuses failures and missing results', () => {
    expect(authenticated('mx.cloudflare.net; dmarc=fail; spf=softfail', from)).toBe(false);
    expect(authenticated(null, from)).toBe(false);
  });
});

describe('document', () => {
  it('combines body and attachments, and caps length', () => {
    const doc = composeDocument({
      from: 'a@b.c',
      subject: 'PO 1',
      text: 'Please ship 5 x WID-100',
      attachments: [
        { filename: 'po.pdf', text: '10 x GSK-010' },
        { filename: 'logo.png', text: '' },
      ],
    });
    expect(doc).toContain('--- Attachment: po.pdf ---');
    expect(doc).not.toContain('logo.png');
    const long = composeDocument({
      from: 'a',
      subject: 's',
      text: 'x'.repeat(60_000),
      attachments: [],
    });
    expect(long.length).toBeLessThanOrEqual(MAX_DOCUMENT_CHARS);
  });

  it('turns an HTML body into text', () => {
    expect(
      htmlToText('<p>Ship <b>5</b> x WID-100</p><style>p{}</style><div>Thanks &amp; regards</div>'),
    ).toBe('Ship 5 x WID-100\n Thanks & regards');
  });

  it('decodes an entity once, drops script and style whole, keeps a stray bracket', () => {
    expect(htmlToText('a &amp;lt; b &lt;i&gt; c&nbsp;d')).toBe('a &lt; b <i> c d');
    expect(htmlToText('x<SCRIPT type="a">alert(1)</SCRIPT>y<style>p{}</style>z')).toBe('xyz');
    expect(htmlToText('a < b and c<br/>d<br >e</h2>f')).toBe('a < b and c\nd\ne\nf');
    expect(htmlToText('<script>never closed')).toBe('never closed');
  });

  it('reads a hostile body in linear time', () => {
    const start = performance.now();
    htmlToText('<style'.repeat(50_000));
    htmlToText(`<script>${'<script>'.repeat(50_000)}`);
    htmlToText('<'.repeat(100_000));
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('takes the address out of a display name, and survives a long run of brackets', () => {
    expect(splitAddress('Acme Orders <Orders+X@Acme.test>')).toEqual({
      local: 'orders+x',
      domain: 'acme.test',
    });
    expect(splitAddress('  a@b.c ')).toEqual({ local: 'a', domain: 'b.c' });
    const start = performance.now();
    splitAddress(`>${'>'.repeat(100_000)}`);
    splitAddress('<'.repeat(100_000));
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
