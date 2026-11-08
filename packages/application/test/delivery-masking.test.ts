import type { Principal } from '@commerceworker/domain';
import { describe, expect, it } from 'vitest';
import { maskDeliveredFields } from '../src/index';

const granular: Principal = {
  kind: 'cda',
  spaceId: 's1',
  scopes: ['delivery:read'],
  contentGrants: [
    { contentTypeApiId: 'post', actions: ['read'], deniedFields: ['internalNotes'] },
    { contentTypeApiId: 'author', actions: ['read'], deniedFields: ['email'] },
    // no grant on 'secretDoc' at all
  ],
};

const embeddedAuthor = {
  id: 'a1',
  contentType: 'author',
  publishedAt: '2026-01-01T00:00:00.000Z',
  fields: { name: 'Ada', email: 'ada@example.com' },
};

const embeddedSecret = {
  id: 'x1',
  contentType: 'secretDoc',
  publishedAt: '2026-01-01T00:00:00.000Z',
  fields: { payload: 'classified' },
};

describe('maskDeliveredFields (include-depth field RBAC)', () => {
  it('masks denied fields on the root AND on embedded entries (flattened)', () => {
    const out = maskDeliveredFields(granular, 'post', {
      title: 'Hello',
      internalNotes: 'root secret',
      author: embeddedAuthor,
    });
    expect(out.internalNotes).toBeUndefined();
    expect(out.title).toBe('Hello');
    const author = out.author as typeof embeddedAuthor;
    expect(author.fields.name).toBe('Ada');
    expect(author.fields.email).toBeUndefined();
  });

  it('reverts an embed of an ungranted type to the unresolved link stub', () => {
    const out = maskDeliveredFields(granular, 'post', { doc: embeddedSecret });
    expect(out.doc).toEqual({ id: 'x1', linkType: 'Entry' });
  });

  it('reaches embeds inside per-locale maps and arrays', () => {
    const out = maskDeliveredFields(granular, 'post', {
      author: { 'en-US': embeddedAuthor },
      related: { 'en-US': [embeddedAuthor, embeddedSecret] },
    });
    const byLocale = out.author as Record<string, typeof embeddedAuthor>;
    expect(byLocale['en-US']?.fields.email).toBeUndefined();
    const related = (out.related as Record<string, unknown[]>)['en-US'];
    const first = related?.[0] as typeof embeddedAuthor | undefined;
    expect(first?.fields.email).toBeUndefined();
    expect(related?.[1]).toEqual({ id: 'x1', linkType: 'Entry' });
  });

  it('masks nested embeds (include depth > 1) recursively', () => {
    const deep = {
      id: 'p2',
      contentType: 'post',
      publishedAt: '2026-01-01T00:00:00.000Z',
      fields: { internalNotes: 'nested secret', author: embeddedAuthor },
    };
    const out = maskDeliveredFields(granular, 'post', { parent: deep });
    const parent = out.parent as typeof deep;
    expect(parent.fields.internalNotes).toBeUndefined();
    expect((parent.fields.author as typeof embeddedAuthor).fields.email).toBeUndefined();
  });

  it('reverts embedded assets to stubs (granular principals have no asset access)', () => {
    const embeddedAsset = {
      id: 'as1',
      file: { url: 'https://cdn.example.com/x.jpg', fileName: 'x.jpg' },
      title: 'X',
    };
    const out = maskDeliveredFields(granular, 'post', {
      hero: embeddedAsset,
      gallery: { 'en-US': [embeddedAsset] },
    });
    expect(out.hero).toEqual({ id: 'as1', linkType: 'Asset' });
    expect((out.gallery as Record<string, unknown[]>)['en-US']?.[0]).toEqual({
      id: 'as1',
      linkType: 'Asset',
    });
  });

  it('passes fields through untouched for unrestricted principals', () => {
    const full: Principal = { kind: 'cda', spaceId: 's1', scopes: ['delivery:read'] };
    const fields = { author: embeddedAuthor, internalNotes: 'visible' };
    expect(maskDeliveredFields(full, 'post', fields)).toBe(fields);
  });
});
