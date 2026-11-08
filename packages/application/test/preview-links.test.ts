import { ForbiddenError, NotFoundError, SCOPES, ValidationError } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  cloneContentType,
  createContentType,
  createEntry,
  createPreviewLink,
  createSpace,
  principalFromPreviewToken,
  SYSTEM_CALLER,
  updateContentType,
} from '../src/index';

const scope = { spaceId: 'site', environmentId: 'main' };
const other = { spaceId: 'other', environmentId: 'main' };
const hasher = { hash: (s: string) => `h:${s}` };
const BASE = { previewBaseUrl: 'https://api.example/' };

const field = (apiId: string, type: 'Symbol' | 'Slug', localized: boolean, position: number) => ({
  apiId,
  name: apiId,
  type,
  localized,
  required: false,
  position,
});

let ctx: AppContext;
let clock: FixedClock;

async function article(urlTemplate?: string) {
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [field('title', 'Symbol', false, 0), field('slug', 'Slug', true, 1)],
    ...(urlTemplate ? { preview: { urlTemplate } } : {}),
  });
}

const entry = async (slug: Record<string, string>) =>
  (
    await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Hello' }, slug },
    })
  ).entry.id;

beforeEach(async () => {
  clock = new FixedClock();
  ctx = { store: new InMemoryContentStore(), clock, ids: new SequenceIdGenerator('p') };
  await createSpace(ctx, {
    spaceId: 'site',
    name: 'Site',
    defaultLocale: 'en-US',
    locales: ['en-US', 'fr'],
  });
  await createSpace(ctx, { spaceId: 'other', name: 'Other', defaultLocale: 'en-US' });
});

describe('preview links', () => {
  it('returns only the Preview API URL when the type has no preview template', async () => {
    await article();
    const id = await entry({ 'en-US': 'hello' });
    const link = await createPreviewLink(ctx, hasher, scope, id, BASE);
    expect(link.url).toBe(
      `https://api.example/preview/site/main/entries/${id}?preview_token=${link.token}`,
    );
    expect(link).not.toHaveProperty('frontendUrl');
  });

  it('fills the type’s template with the entry, the token and the locale', async () => {
    await article(
      'https://site.example/{locale}/blog/{field:slug}?entry={id}&token={token}&s={space}&e={environment}',
    );
    const id = await entry({ 'en-US': 'hello world', fr: 'bonjour' });
    const en = await createPreviewLink(ctx, hasher, scope, id, BASE);
    expect(en.frontendUrl).toBe(
      `https://site.example/en-US/blog/hello-world?entry=${id}&token=${en.token}&s=site&e=main`,
    );
    const fr = await createPreviewLink(ctx, hasher, scope, id, { ...BASE, locale: 'fr' });
    expect(fr.frontendUrl).toBe(
      `https://site.example/fr/blog/bonjour?entry=${id}&token=${fr.token}&s=site&e=main`,
    );
    // Each link mints its own token, and the frontend URL's reads the entry, as the API URL's does.
    expect(fr.token).not.toBe(en.token);
    const principal = await principalFromPreviewToken(ctx, hasher, scope, id, fr.token);
    expect(principal?.contentGrants).toEqual([{ contentTypeApiId: 'article', actions: ['read'] }]);
  });

  it('leaves the frontend URL out while a localized field it names is empty in the locale', async () => {
    await article('https://site.example/blog/{field:slug}?token={token}');
    const id = await entry({ 'en-US': 'hello' });
    // A localized slug never borrows the default locale's value: that is another page.
    const fr = await createPreviewLink(ctx, hasher, scope, id, { ...BASE, locale: 'fr' });
    expect(fr).not.toHaveProperty('frontendUrl');
    expect(fr.url).toContain(fr.token);
  });

  it('refuses a locale the space doesn’t have', async () => {
    await article('https://site.example/{locale}?token={token}');
    const id = await entry({ 'en-US': 'hello' });
    await expect(
      createPreviewLink(ctx, hasher, scope, id, { ...BASE, locale: 'de' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('keeps the token to its entry and scope', async () => {
    await article('https://site.example/p?entry={id}&token={token}');
    const id = await entry({ 'en-US': 'hello' });
    const second = await entry({ 'en-US': 'second' });
    const link = await createPreviewLink(ctx, hasher, scope, id, BASE);
    expect(await principalFromPreviewToken(ctx, hasher, scope, second, link.token)).toBeNull();
    expect(await principalFromPreviewToken(ctx, hasher, other, id, link.token)).toBeNull();
    await expect(createPreviewLink(ctx, hasher, other, id, BASE)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('expires the token, the frontend URL’s with it', async () => {
    await article('https://site.example/p?entry={id}&token={token}');
    const id = await entry({ 'en-US': 'hello' });
    const link = await createPreviewLink(ctx, hasher, scope, id, { ...BASE, ttlHours: 1 });
    expect(await principalFromPreviewToken(ctx, hasher, scope, id, link.token)).not.toBeNull();
    clock.advance(60 * 60 * 1000 + 1);
    expect(await principalFromPreviewToken(ctx, hasher, scope, id, link.token)).toBeNull();
  });
});

describe('who may set a type’s preview URL', () => {
  const modeller = {
    spaceId: 'site',
    kind: 'cma' as const,
    scopes: [SCOPES.contentManage],
    contentGrants: [{ contentTypeApiId: 'page', actions: ['read' as const] }],
  };
  const draft = (urlTemplate?: string | null) => ({
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [field('title', 'Symbol', false, 0)],
    ...(urlTemplate !== undefined
      ? { preview: urlTemplate === null ? null : { urlTemplate } }
      : {}),
  });
  const T = 'https://site.example/p?entry={id}&token={token}';

  it('holds a caller without read on the type to the stored value', async () => {
    await expect(createContentType(ctx, modeller, scope, draft(T))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await createContentType(ctx, SYSTEM_CALLER, scope, draft(T));
    await expect(
      createContentType(ctx, modeller, scope, draft('https://elsewhere.example/?t={token}')),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Unchanged (trimmed), left out, or cleared: nothing more to authorize.
    await createContentType(ctx, modeller, scope, draft(` ${T}`));
    await createContentType(ctx, modeller, scope, draft());
    expect((await createContentType(ctx, modeller, scope, draft(null))).preview).toBeUndefined();
    // Read on the type is enough.
    const reader = {
      ...modeller,
      contentGrants: [{ contentTypeApiId: 'article', actions: ['read' as const] }],
    };
    expect((await createContentType(ctx, reader, scope, draft(T))).preview).toEqual({
      urlTemplate: T,
    });
  });

  it('fails closed for a caller that is neither a principal nor the system marker', async () => {
    // What a handler that dropped its principal, or passed arguments out of place, would send.
    for (const caller of [undefined, null, 'system', {}, scope]) {
      const as = caller as never;
      // Before anything is read or written, whether or not a preview URL is set.
      await expect(createContentType(ctx, as, scope, draft())).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(createContentType(ctx, as, scope, draft(T))).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    expect(await ctx.store.contentTypes.get(scope, 'article')).toBeNull();
    await createContentType(ctx, SYSTEM_CALLER, scope, draft(T));
    await expect(
      updateContentType(ctx, undefined as never, scope, 'article', { name: 'Post' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      cloneContentType(ctx, undefined as never, scope, 'article', 'story', 'Story'),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // A request's principal is held to the read rule on the clone it would point elsewhere.
    await expect(
      cloneContentType(ctx, modeller, scope, 'article', 'story', 'Story'),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('takes a plain-http dev server only on a local stack', async () => {
    const local = 'http://localhost:3000/p?token={token}';
    await expect(createContentType(ctx, SYSTEM_CALLER, scope, draft(local))).rejects.toBeInstanceOf(
      ValidationError,
    );
    const dev = { ...ctx, previewLoopback: true };
    expect((await createContentType(dev, SYSTEM_CALLER, scope, draft(local))).preview).toEqual({
      urlTemplate: local,
    });
  });
});
