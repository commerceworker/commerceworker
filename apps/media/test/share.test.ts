import { SELF } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { createKvAssetGate } from '@commerceworker/adapters/asset-gate-kv';
import { createMediaPathSigner } from '@commerceworker/adapters/blob-r2';
import {
  type AppContext,
  addToAssetCollection,
  createAsset,
  createAssetCollection,
  createAssetShareLink,
  createSpace,
  publishAsset,
  revokeAssetShareLink,
  setAssetMetadata,
  setLocaleSettings,
  shareLinkUrl,
  syncAssetGate,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { pbkdf2PasswordHasher } from '@commerceworker/security/credentials';
import { createD1Store } from '@commerceworker/store';
import { FakeBlobStore } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { handleShareRequest } from '../src/share';

const ORIGIN = 'https://media.example.test';
const paths = createMediaPathSigner(env.MEDIA_SIGNING_SECRET);
const assetGate = createKvAssetGate(env.KV_CACHE);
const textOf = async (res: Response) => new TextDecoder().decode(await res.arrayBuffer());

let seq = 0;
function context(): AppContext {
  return {
    store: createD1Store(env.DB),
    clock: { now: () => new Date() },
    ids: { newId: () => crypto.randomUUID() },
    mediaPublicUrl: ORIGIN,
    mediaPaths: paths,
    passwords: pbkdf2PasswordHasher,
  };
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

/** A space with a collection of a published image, a draft and a published PDF. */
async function sharedCollection(opts: { allowDownload?: boolean; password?: string } = {}) {
  const ctx = context();
  const scope = { spaceId: `share-space-${++seq}`, environmentId: 'main' };
  await createSpace(ctx, { spaceId: scope.spaceId, name: 'Share', defaultLocale: 'en-US' });
  const blob = new FakeBlobStore();
  const make = async (fileName: string, contentType: string, bytes: string, publish: boolean) => {
    const { asset } = await createAsset(ctx, blob, scope, { fileName, contentType });
    await env.MEDIA_BUCKET.put(asset.r2Key as string, bytes, { httpMetadata: { contentType } });
    if (publish) {
      await publishAsset(ctx, scope, asset.id);
      await syncAssetGate(ctx, assetGate, scope, asset.id);
    }
    return asset;
  };
  const image = await make('logo <b>.png', 'image/png', 'PNG-BYTES', true);
  const draft = await make('secret.png', 'image/png', 'DRAFT', false);
  const pdf = await make('brief.pdf', 'application/pdf', 'PDF-BYTES', true);
  const collection = await createAssetCollection(ctx, scope, { name: 'Press kit' });
  await addToAssetCollection(ctx, scope, collection.id, [pdf.id, draft.id, image.id]);
  const link = await createAssetShareLink(ctx, scope, {
    targetType: 'collection',
    targetId: collection.id,
    expiresAt: inDays(7),
    ...opts,
  });
  const url = shareLinkUrl(ctx, scope, link.id) as string;
  return { ctx, scope, link, url, image, draft, pdf, collection };
}

const fileUrl = (base: string, asset: { id: string; file: { fileName: string } }) =>
  `${base}/f/${encodeURIComponent(asset.id)}/${encodeURIComponent(asset.file.fileName)}`;

describe('share links on the media origin', () => {
  it('opens a page of the published members only, escaped, never cached by the browser', async () => {
    const s = await sharedCollection();
    const res = await SELF.fetch(s.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    const html = await textOf(res);
    expect(html).toContain('<h1>Press kit</h1>');
    expect(html).toContain('logo &lt;b&gt;.png');
    expect(html).toContain('brief.pdf');
    expect(html).not.toContain('secret.png');
    // No download links unless the link allows them.
    expect(html).not.toContain('?download');
    // Ledger in both schemes, focus in the brand accent, and no commerceworker mark.
    expect(html).toContain('@media (prefers-color-scheme:dark)');
    expect(html).toContain('outline:2px solid var(--brand)');
    expect(html).not.toContain('<svg');
    const json = await SELF.fetch(`${s.url}?format=json`);
    const body = (await json.json()) as { files: { assetId: string; href: string }[] };
    expect(body.files.map((f) => f.assetId)).toEqual([s.pdf.id, s.image.id]);
    expect(body.files[0]?.href).toBe(new URL(fileUrl(s.url, s.pdf)).pathname);
  });

  it('caches the page in the Media entrypoint tagged by link, collection and environment', async () => {
    const s = await sharedCollection();
    const path = new URL(s.url).pathname;
    const media = (exports as unknown as { Media: { fetch(r: Request): Promise<Response> } }).Media;
    const res = await media.fetch(new Request(`https://media.internal${path}?f=html`));
    expect(res.status).toBe(200);
    const tags = res.headers.get('cache-tag')?.split(',') ?? [];
    const { spaceId, environmentId } = s.scope;
    expect(tags).toEqual(
      expect.arrayContaining([
        `cws:${spaceId}:${environmentId}:${s.link.id}`,
        `cwc:${spaceId}:${environmentId}:${s.collection.id}`,
        `cwe:${spaceId}:${environmentId}`,
      ]),
    );
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(3600);
    await res.body?.cancel();
  });

  it('titles a file in the default locale, else a delivered one, never one turned off', async () => {
    const ctx = context();
    const scope = { spaceId: `share-space-${++seq}`, environmentId: 'main' };
    await createSpace(ctx, {
      spaceId: scope.spaceId,
      name: 'Locales',
      defaultLocale: 'en-US',
      locales: ['en-US', 'fr', 'de'],
    });
    await setLocaleSettings(
      ctx,
      { spaceId: scope.spaceId, kind: 'cma', scopes: [SCOPES.spaceAdmin] },
      scope,
      { fr: { delivered: false } },
    );
    const blob = new FakeBlobStore();
    const shared = async (title: Record<string, string>, alt: Record<string, string>) => {
      const { asset } = await createAsset(ctx, blob, scope, {
        fileName: 'pic.png',
        contentType: 'image/png',
        title,
      });
      await setAssetMetadata(ctx, scope, asset.id, { altText: alt });
      await env.MEDIA_BUCKET.put(asset.r2Key as string, 'PNG', {
        httpMetadata: { contentType: 'image/png' },
      });
      await publishAsset(ctx, scope, asset.id);
      const link = await createAssetShareLink(ctx, scope, {
        targetType: 'asset',
        targetId: asset.id,
        expiresAt: inDays(7),
      });
      const path = new URL(shareLinkUrl(ctx, scope, link.id) as string).pathname;
      const media = (exports as unknown as { Media: { fetch(r: Request): Promise<Response> } })
        .Media;
      const json = await media.fetch(new Request(`https://media.internal${path}?f=json`));
      const html = await textOf(
        await media.fetch(new Request(`https://media.internal${path}?f=html`)),
      );
      return { json: (await json.json()) as { title: string; files: { title: string }[] }, html };
    };

    // fr comes first in the map and is turned off: the delivered de text stands in.
    const hidden = await shared(
      { fr: 'Titre caché', de: 'Bild' },
      { fr: 'Texte caché', de: 'Alt' },
    );
    expect(hidden.json.title).toBe('Bild');
    expect(hidden.json.files.map((f) => f.title)).toEqual(['Bild']);
    expect(hidden.html).toContain('alt="Alt"');
    expect(hidden.html).not.toContain('caché');
    // The default locale wins over whichever comes first.
    const preferred = await shared({ de: 'Bild', 'en-US': 'Picture' }, { de: 'Alt', 'en-US': 'A' });
    expect(preferred.json.title).toBe('Picture');
    expect(preferred.html).toContain('alt="A"');
    // Only a hidden locale's text: the file name, never the hidden title.
    const only = await shared({ fr: 'Seulement' }, { fr: 'Seulement' });
    expect(only.json.title).toBe('pic.png');
    expect(only.html).not.toContain('Seulement');
  });

  it('serves a member’s file inline, a download only when allowed, and nothing else', async () => {
    const s = await sharedCollection();
    const res = await SELF.fetch(fileUrl(s.url, s.pdf));
    expect(res.status).toBe(200);
    expect(await textOf(res)).toBe('PDF-BYTES');
    expect(res.headers.get('content-disposition')).toMatch(/^inline/);
    const asked = await SELF.fetch(`${fileUrl(s.url, s.pdf)}?download`);
    expect(asked.headers.get('content-disposition')).toMatch(/^inline/);
    await asked.body?.cancel();
    // A draft member and an asset outside the collection: 404.
    expect((await SELF.fetch(fileUrl(s.url, s.draft))).status).toBe(404);
    const other = await sharedCollection();
    expect((await SELF.fetch(fileUrl(s.url, other.image))).status).toBe(404);

    const downloads = await sharedCollection({ allowDownload: true });
    const dl = await SELF.fetch(`${fileUrl(downloads.url, downloads.pdf)}?download`);
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment; filename="brief.pdf"/);
    await dl.body?.cancel();
  });

  it('answers 410 once revoked or expired, then purges (the engine sends the link’s tag)', async () => {
    const s = await sharedCollection();
    await revokeAssetShareLink(s.ctx, s.scope, s.link.id);
    expect((await SELF.fetch(s.url)).status).toBe(410);
    expect((await SELF.fetch(fileUrl(s.url, s.pdf))).status).toBe(410);

    // Expired: the replica's row says so.
    const e = await sharedCollection();
    await env.DB.prepare('UPDATE asset_share_links SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1000, e.link.id)
      .run();
    const gone = await SELF.fetch(e.url);
    expect(gone.status).toBe(410);
    expect(await textOf(gone)).toContain('no longer available');
    // Revoked straight in the row (no engine step at all): the next request answers 410.
    const r = await sharedCollection();
    await env.DB.prepare('UPDATE asset_share_links SET revoked_at = ? WHERE id = ?')
      .bind(Date.now(), r.link.id)
      .run();
    expect((await SELF.fetch(r.url)).status).toBe(410);
  });

  it('refuses a bad token or a forged link before any lookup', async () => {
    const s = await sharedCollection();
    const token = s.url.split('/').at(-1) as string;
    const tampered = s.url.replace(
      token,
      `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`,
    );
    expect((await SELF.fetch(tampered)).status).toBe(404);
    // Another link id under the same token, and the asset path's token, are both refused.
    expect((await SELF.fetch(s.url.replace(s.link.id, crypto.randomUUID()))).status).toBe(404);
    // Proof that nothing was read: a gate and store that throw on any call are never touched.
    const explode = () => {
      throw new Error('looked up');
    };
    const deps = {
      paths,
      passwords: { hash: explode, verify: explode },
      store: new Proxy({}, { get: explode }) as never,
    };
    const media = { fetch: explode, range: explode };
    const res = await handleShareRequest(new Request(tampered), deps as never, media as never);
    expect(res.status).toBe(404);
    const unknown = `${ORIGIN}/s/${s.scope.spaceId}/main/${crypto.randomUUID()}/aaaaaaaaaaaaaaaaaaaaaa`;
    expect(
      (await handleShareRequest(new Request(unknown), deps as never, media as never)).status,
    ).toBe(404);
  });

  it('asks for a password first, refuses a wrong one, and remembers the right one', async () => {
    const s = await sharedCollection({ password: 'open sesame!' });
    const page = await SELF.fetch(s.url);
    expect(page.status).toBe(401);
    const form = await textOf(page);
    expect(form).toContain('<label for="password">Password</label>');
    expect(form).not.toContain('brief.pdf');
    expect((await SELF.fetch(fileUrl(s.url, s.pdf))).status).toBe(401);

    const unlock = (password: string) => {
      const body = new URLSearchParams({ password }).toString();
      return SELF.fetch(`${s.url}/unlock`, {
        method: 'POST',
        body,
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': String(body.length),
        },
      });
    };
    const wrong = await unlock('nope nope nope');
    expect(wrong.status).toBe(401);
    expect(await textOf(wrong)).toContain('That password is not right.');
    const right = await unlock('open sesame!');
    expect(right.status).toBe(303);
    const cookie = right.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect(cookie).toContain(`Path=${new URL(s.url).pathname};`);
    const value = cookie.split(';')[0] as string;
    const opened = await SELF.fetch(s.url, { headers: { cookie: value } });
    expect(opened.status).toBe(200);
    expect(await textOf(opened)).toContain('brief.pdf');
    const file = await SELF.fetch(fileUrl(s.url, s.pdf), { headers: { cookie: value } });
    expect(await textOf(file)).toBe('PDF-BYTES');
    // The cookie opens this link only.
    const other = await sharedCollection({ password: 'open sesame!' });
    expect((await SELF.fetch(other.url, { headers: { cookie: value } })).status).toBe(401);
    // A GET to unlock, and a POST to the page, are refused.
    expect((await SELF.fetch(`${s.url}/unlock`)).status).toBe(405);
    expect((await SELF.fetch(s.url, { method: 'POST' })).status).toBe(405);
  });

  it('limits password attempts per link from every address together', async () => {
    const s = await sharedCollection({ password: 'open sesame!' });
    const counts = new Map<string, number>();
    const limiter = {
      async limit({ key }: { key: string }) {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return { success: n <= 2 };
      },
    };
    const deps = { paths, passwords: pbkdf2PasswordHasher, store: createD1Store(env.DB), limiter };
    const media = {
      fetch: () => Promise.reject(new Error('unused')),
      range: () => Promise.reject(new Error('unused')),
    };
    const attempt = (ip: string) => {
      const body = 'password=wrong-guess';
      return handleShareRequest(
        new Request(`${s.url}/unlock`, {
          method: 'POST',
          body,
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': String(body.length),
            'cf-connecting-ip': ip,
          },
        }),
        deps,
        media as never,
      );
    };
    // Three addresses, one guess each: the link's own budget (2 here) runs out on the third.
    expect((await attempt('10.0.0.1')).status).toBe(401);
    expect((await attempt('10.0.0.2')).status).toBe(401);
    expect((await attempt('10.0.0.3')).status).toBe(429);
  });

  it('leaves a space named `s` its published media URLs', async () => {
    const ctx = context();
    const scope = { spaceId: 's', environmentId: 'main' };
    await createSpace(ctx, { spaceId: 's', name: 'S', defaultLocale: 'en-US' });
    const { asset } = await createAsset(ctx, new FakeBlobStore(), scope, {
      fileName: 'pic.png',
      contentType: 'image/png',
    });
    await env.MEDIA_BUCKET.put(asset.r2Key as string, 'S-BYTES', {
      httpMetadata: { contentType: 'image/png' },
    });
    await publishAsset(ctx, scope, asset.id);
    await syncAssetGate(ctx, assetGate, scope, asset.id);
    const res = await SELF.fetch(
      `${ORIGIN}/s/main/${asset.id}/v1/${paths.token(scope, asset.id, 1)}/o/pic.png`,
    );
    expect(res.status).toBe(200);
    expect(await textOf(res)).toBe('S-BYTES');
  });
});
