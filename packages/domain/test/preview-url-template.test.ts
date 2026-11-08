import { describe, expect, it } from 'vitest';
import {
  checkPreviewTemplate,
  defineContentType,
  type FieldDefinition,
  fillPreviewTemplate,
  MAX_PREVIEW_TEMPLATE_LENGTH,
  previewOrigin,
  previewTemplateFields,
  reviseContentType,
  ValidationError,
} from '../src/index';

const field = (apiId: string, type: FieldDefinition['type'], position = 0): FieldDefinition => ({
  apiId,
  name: apiId,
  type,
  localized: false,
  required: false,
  position,
});

const FIELDS = [field('title', 'Symbol'), field('slug', 'Slug', 1), field('body', 'Text', 2)];
const TEMPLATE = 'https://site.example/__preview?entry={id}&token={token}';

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ValidationError) {
      expect(err.issues[0]?.field).toBe('preview.urlTemplate');
      return err.issues.map((i) => i.message).join('; ');
    }
    throw err;
  }
  throw new Error('expected a ValidationError');
};

const check = (t: string) => checkPreviewTemplate(t, FIELDS);

describe('preview URL template', () => {
  it('takes an https template with every placeholder', () => {
    const t =
      'https://site.example/{locale}/blog/{field:slug}?entry={id}&token={token}' +
      '&space={space}&env={environment}#{field:title}';
    expect(check(`  ${t} `)).toBe(t);
  });

  it('takes plain http only on localhost and 127.0.0.1, and only on a local stack', () => {
    const local = (t: string) => checkPreviewTemplate(t, FIELDS, { allowLoopback: true });
    expect(local('http://localhost:3000/__preview?token={token}')).toBeTruthy();
    expect(local('http://127.0.0.1:4321/p/{id}?token={token}')).toBeTruthy();
    expect(refusal(() => local('http://site.example/?token={token}'))).toMatch(/https/);
    expect(refusal(() => local('http://localhost.evil.example/?token={token}'))).toMatch(/https/);
    // A deployment, the default: no cleartext, not even to loopback.
    expect(refusal(() => check('http://localhost:3000/__preview?token={token}'))).toMatch(/https/);
    expect(check('https://localhost:3000/__preview?token={token}')).toBeTruthy();
  });

  it('refuses a wildcard or any host that isn’t a plain name or address', () => {
    for (const t of [
      'https://*/?token={token}',
      'https://*.example/?token={token}',
      'https://a%2a.example/?token={token}',
      'https://a_b.example/?token={token}',
      'https://-a.example/?token={token}',
    ]) {
      expect(
        refusal(() => check(t)),
        t,
      ).toMatch(/https URL with a fixed host/);
    }
    expect(previewOrigin('https://*/x')).toBeNull();
    expect(check('https://10.0.0.2/p?token={token}')).toBeTruthy();
    expect(check('https://[::1]:8443/p?token={token}')).toBeTruthy();
    expect(previewOrigin('https://xn--bcher-kva.example/p')).toBe('https://xn--bcher-kva.example');
    expect(previewOrigin('https://bücher.example/p')).toBe('https://xn--bcher-kva.example');
  });

  it('keeps the token out of the request line with a fragment', () => {
    const t = 'https://site.example/__preview?entry={id}#token={token}';
    expect(check(t)).toBe(t);
    expect(
      fillPreviewTemplate(t, {
        id: 'e1',
        token: 'pw_x',
        locale: 'en',
        space: 's',
        environment: 'e',
        fields: {},
      }),
    ).toBe('https://site.example/__preview?entry=e1#token=pw_x');
  });

  it('refuses other schemes, relative URLs and credentials', () => {
    for (const t of [
      'javascript:alert(1)//{token}',
      'data:text/html,{token}',
      '//site.example/?token={token}',
      '/__preview?token={token}',
      'https://user:pw@site.example/?token={token}',
      'not a url {token}',
      `https://site.example/${'a'.repeat(MAX_PREVIEW_TEMPLATE_LENGTH)}?t={token}`,
    ]) {
      expect(() => check(t), t).toThrow(ValidationError);
    }
  });

  it('refuses a placeholder in the scheme, host or port: the origin must be fixed', () => {
    for (const t of [
      'https://{space}.site.example/?token={token}',
      'https://site.{field:slug}/?token={token}',
      'https://site.example:{id}/?token={token}',
      '{field:slug}://site.example/?token={token}',
    ]) {
      expect(() => check(t), t).toThrow(ValidationError);
    }
  });

  it('requires {token} and knows only its placeholders', () => {
    expect(refusal(() => check('https://site.example/p/{id}'))).toMatch(/\{token\}/);
    expect(refusal(() => check('https://site.example/?t={token}&x={secret}'))).toMatch(
      /\{secret\} is not/,
    );
    expect(refusal(() => check('https://site.example/?t={token}&x={field:nope}'))).toMatch(
      /names no field/,
    );
    // Long text isn't a URL value.
    expect(refusal(() => check('https://site.example/?t={token}&x={field:body}'))).toMatch(/Slug/);
    expect(refusal(() => check('https://site.example/?t={token}}'))).toMatch(/\{name\}/);
  });

  it('reads its origin, or null for anything the admin must not frame', () => {
    expect(previewOrigin(TEMPLATE)).toBe('https://site.example');
    expect(previewOrigin('https://Site.Example:8443/x/{id}?t={token}')).toBe(
      'https://site.example:8443',
    );
    expect(previewOrigin('http://localhost:3000/?t={token}', { allowLoopback: true })).toBe(
      'http://localhost:3000',
    );
    expect(previewOrigin('http://localhost:3000/?t={token}')).toBeNull();
    expect(previewOrigin('https://{space}.site.example/')).toBeNull();
    expect(previewOrigin('http://site.example/')).toBeNull();
    expect(previewOrigin('ftp://site.example/')).toBeNull();
    expect(previewOrigin('nonsense')).toBeNull();
  });

  it('fills each placeholder URL-encoded', () => {
    const url = fillPreviewTemplate(
      'https://site.example/{locale}/{field:slug}?entry={id}&token={token}&s={space}&e={environment}&n={field:n}',
      {
        id: 'e 1',
        token: 'pw_a&b=c',
        locale: 'en-US',
        space: 's/1',
        environment: 'main',
        fields: { slug: 'hello world?', n: 3 },
      },
    );
    expect(url).toBe(
      'https://site.example/en-US/hello%20world%3F?entry=e%201&token=pw_a%26b%3Dc&s=s%2F1&e=main&n=3',
    );
    // A value can't move the URL to another origin.
    expect(
      new URL(
        fillPreviewTemplate('https://site.example/{field:slug}?t={token}', {
          id: 'x',
          token: 't',
          locale: 'en',
          space: 's',
          environment: 'e',
          fields: { slug: '//evil.example/@x' },
        }) as string,
      ).origin,
    ).toBe('https://site.example');
  });

  it('fills nothing while a field it names is empty', () => {
    const values = { id: 'e1', token: 't', locale: 'en', space: 's', environment: 'e' };
    const t = 'https://site.example/{field:slug}?t={token}';
    expect(fillPreviewTemplate(t, { ...values, fields: {} })).toBeNull();
    expect(fillPreviewTemplate(t, { ...values, fields: { slug: '' } })).toBeNull();
    expect(fillPreviewTemplate(t, { ...values, fields: { slug: { not: 'text' } } })).toBeNull();
    expect(previewTemplateFields(t)).toEqual(['slug']);
  });
});

describe('a content type’s preview setting', () => {
  const define = (preview: unknown) =>
    defineContentType({
      apiId: 'article',
      name: 'Article',
      displayField: 'title',
      fields: FIELDS,
      // biome-ignore lint/suspicious/noExplicitAny: an unchecked request body
      preview: preview as any,
    });

  it('is kept, trimmed, on a define and a revision that leaves it out', () => {
    const ct = define({ urlTemplate: ` ${TEMPLATE}` });
    expect(ct.preview).toEqual({ urlTemplate: TEMPLATE });
    expect(reviseContentType(ct, { name: 'Post' }).preview).toEqual({ urlTemplate: TEMPLATE });
  });

  it('is cleared by null or a blank template', () => {
    const ct = define({ urlTemplate: TEMPLATE });
    expect(reviseContentType(ct, { preview: null }).preview).toBeUndefined();
    expect(reviseContentType(ct, { preview: { urlTemplate: '  ' } }).preview).toBeUndefined();
    expect(define(null).preview).toBeUndefined();
  });

  it('refuses a bad template, and one sent with a revision that removes its field', () => {
    expect(() => define({ urlTemplate: 'http://site.example/?t={token}' })).toThrow(
      ValidationError,
    );
    expect(() => define({ urlTemplate: 42 })).toThrow(ValidationError);
    const urlTemplate = 'https://site.example/{field:slug}?t={token}';
    const ct = define({ urlTemplate });
    const noSlug = FIELDS.filter((f) => f.apiId !== 'slug');
    expect(
      refusal(() => reviseContentType(ct, { fields: noSlug, preview: { urlTemplate } })),
    ).toMatch(/names no field/);
  });

  it('drops a kept template that no longer checks, rather than refusing a save that left it out', () => {
    // As code that never heard of the setting leaves it: the field it names gone.
    const stale = {
      ...define(null),
      fields: FIELDS.filter((f) => f.apiId !== 'slug'),
      preview: { urlTemplate: 'https://site.example/{field:slug}?t={token}' },
    };
    const revised = reviseContentType(stale, { name: 'Post' });
    expect(revised.name).toBe('Post');
    expect(revised).not.toHaveProperty('preview');
    // A kept template that still checks stays.
    const kept = define({ urlTemplate: TEMPLATE });
    expect(reviseContentType(kept, { name: 'Post' }).preview).toEqual({ urlTemplate: TEMPLATE });
  });

  it('allows loopback http on a local stack only, and keeps a stored one editable', () => {
    const local = 'http://localhost:3000/p?t={token}';
    expect(() => define({ urlTemplate: local })).toThrow(ValidationError);
    const ct = defineContentType(
      {
        apiId: 'article',
        name: 'Article',
        displayField: 'title',
        fields: FIELDS,
        preview: { urlTemplate: local },
      },
      { previewLoopback: true },
    );
    expect(ct.preview).toEqual({ urlTemplate: local });
    // Sent back as stored on a deployment, it passes as it stands; a new one doesn't.
    expect(reviseContentType(ct, { preview: { urlTemplate: local } }).preview).toEqual({
      urlTemplate: local,
    });
    expect(() =>
      reviseContentType(ct, { preview: { urlTemplate: 'http://127.0.0.1/p?t={token}' } }),
    ).toThrow(ValidationError);
  });
});
