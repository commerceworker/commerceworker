/**
 * Share links on the media origin: `/s/<space>/<env>/<linkId>/<token>` opens a read-only page of
 * what the link's target (an asset, or a collection) publishes now, and `…/f/<asset>/<file>`
 * serves one of those files. Nothing here writes anything.
 *
 * Every request is refused for the price of one MAC until its token checks out, so a guessed or
 * edited link id costs no lookup. Then the link's row is read from a D1 replica, on every request,
 * so an expired link answers 410 at once and a revoked one as soon as the replica has the revoke. A link with a password asks for it first (a POST to
 * `…/unlock`, limited per link and address) and remembers it in a cookie scoped to the link's
 * path, MAC'd under the media secret.
 *
 * The page is rendered by the cached `Media` entrypoint, tagged with the link, its target and the
 * environment: revoking the link, or a change to what it lists, purges it. Files go through the
 * published file's own cached URL, so a shared file costs no second copy in the cache.
 */
import {
  openShareLink,
  sharedAssetFile,
  sharedAssets,
  sharedText,
} from '@commerceworker/application';
import { palette, type Scheme } from '@commerceworker/design/tokens';
import { parseShareLinkPath, type ShareLinkAddress } from '@commerceworker/domain';
import {
  mediaAssetTag,
  mediaCollectionTag,
  mediaEnvironmentTag,
  mediaShareLinkTag,
} from '@commerceworker/platform/messages';
import type {
  ContentStore,
  MediaPathSigner,
  PasswordHasher,
  PublishedAsset,
  ShareLinkGateEntry,
} from '@commerceworker/ports';
import { canonicalMediaUrl, contentDisposition, INTERNAL_ORIGIN, singleByteRange } from './serve';

export interface ShareDeps {
  readonly paths: MediaPathSigner;
  /** Read-only, through a replica. */
  readonly store?: Pick<ContentStore, 'assets' | 'assetShareLinks' | 'assetCollections' | 'spaces'>;
  readonly passwords: PasswordHasher;
  /** Password attempts, per link and client address. */
  readonly limiter?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  /** Milliseconds since the epoch; injected for tests. */
  readonly now?: () => number;
}

/** The cached entrypoint, as the gateway calls it. */
export interface MediaEntrypoint {
  fetch(request: Request): Promise<Response>;
  range(url: string, range: string, ifRange: string | null): Promise<Response>;
}

/** How long an unlocked link stays unlocked in a browser (never past the link's expiry). */
export const UNLOCK_SECONDS = 12 * 60 * 60;
/** How long a shared page may be cached (and never past the link's expiry). */
const PAGE_MAX_AGE = 3600;
const COOKIE = 'cw_share';
/** The largest unlock form read. */
const MAX_FORM_BYTES = 4096;

const PAGE_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
};

const nowOf = (deps: Pick<ShareDeps, 'now'>) => deps.now?.() ?? Date.now();

function plain(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

/** The address, when the path is a share path whose token checks out; `null` before any lookup. */
export function verifiedShare(pathname: string, paths: MediaPathSigner): ShareLinkAddress | null {
  const a = parseShareLinkPath(pathname);
  if (!a || !paths.verifyLink(a.scope, a.linkId, a.token)) return null;
  return a;
}

/** The link as it stands now (a replica read): its entry, `gone` (410), or `null` (404). */
export async function shareLinkEntry(
  deps: ShareDeps,
  a: ShareLinkAddress,
): Promise<ShareLinkGateEntry | 'gone' | null> {
  if (!deps.store) return null;
  return openShareLink(deps.store, a.scope, a.linkId, nowOf(deps));
}

/** The share page's path (no trailing slash), as the browser has it. */
const pagePath = (pathname: string, a: ShareLinkAddress): string =>
  a.request.kind === 'page'
    ? pathname
    : pathname.slice(0, pathname.lastIndexOf(`/${a.token}/`) + a.token.length + 1);

/** The unlock cookie's token for `exp` (seconds): a MAC no link's own token can ever equal. */
const unlockToken = (paths: MediaPathSigner, a: ShareLinkAddress, exp: number) =>
  paths.linkToken(a.scope, `${a.linkId}:unlock:${exp}`);

/** Whether the request carries this link's unlock cookie, unexpired. */
function unlocked(request: Request, deps: ShareDeps, a: ShareLinkAddress): boolean {
  const cookies = request.headers.get('cookie') ?? '';
  const nowSeconds = Math.floor(nowOf(deps) / 1000);
  for (const part of cookies.split(';')) {
    const [name, value] = part.trim().split('=');
    if (name !== COOKIE || !value) continue;
    const [expRaw, token] = value.split('.');
    const exp = Number(expRaw);
    if (!Number.isSafeInteger(exp) || exp <= nowSeconds || !token) continue;
    if (deps.paths.verifyLink(a.scope, `${a.linkId}:unlock:${exp}`, token)) return true;
  }
  return false;
}

const html = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/**
 * The share page wears Ledger (the admin's tokens, light and dark) but not the commerceworker mark:
 * whoever opens a link is the deployment's contact, not ours. Brand marks only focus here.
 */
const PAGE_CSS = (() => {
  const vars = (scheme: Scheme) => {
    const p = palette(scheme);
    return (
      [
        'background',
        'foreground',
        'muted-foreground',
        'card',
        'rule',
        'input',
        'link',
        'brand',
        'destructive',
        'primary',
        'primary-foreground',
      ] as const
    )
      .map((t) => `--${t}:${p[t]}`)
      .join(';');
  };
  return `:root{color-scheme:light dark;${vars('light')}}
@media (prefers-color-scheme:dark){:root{${vars('dark')}}}
:root{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5;background:var(--background);color:var(--foreground)}
body{margin:0 auto;max-width:56rem;padding:2.5rem 1rem}
h1{font-size:1.5rem;font-weight:600;letter-spacing:-.01em;margin:0 0 .25rem}
ul{list-style:none;padding:0;display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))}
li{background:var(--card);border:1px solid var(--rule);border-radius:.75rem;padding:.75rem}
img{display:block;max-width:100%;height:auto;border-radius:.375rem;margin-bottom:.5rem}
a{color:var(--link);text-underline-offset:3px}
a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
::selection{background:color-mix(in oklch,var(--brand) 22%,transparent)}
.meta{font-size:.875rem;color:var(--muted-foreground)}
label{display:block;margin:.75rem 0 .25rem;font-size:.875rem;font-weight:500}
input,button{font:inherit;padding:.5rem .75rem;border-radius:.5rem}
input{background:transparent;color:inherit;border:1px solid var(--input)}
button{margin-top:.75rem;border:0;background:var(--primary);color:var(--primary-foreground);font-weight:500;cursor:pointer}
[role=alert]{color:var(--destructive)}`;
})();

function page(status: number, title: string, body: string, extra: Record<string, string> = {}) {
  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
  return new Response(doc, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...PAGE_HEADERS, ...extra },
  });
}

const goneBody = `<h1>This link is no longer available</h1>
<p>It has expired or was revoked. Ask whoever shared it for a new one.</p>`;

function unlockForm(path: string, error?: string) {
  return page(
    401,
    'Password required',
    `<h1>Password required</h1>
<p>Enter the password you were given to open this link.</p>
${error ? `<p role="alert" id="unlock-error">${html(error)}</p>` : ''}
<form method="post" action="${html(path)}/unlock">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required${error ? ' aria-describedby="unlock-error" aria-invalid="true"' : ''}>
<button type="submit">Open</button>
</form>`,
    { 'cache-control': 'no-store' },
  );
}

function humanSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  return `${u === 0 ? n : n.toFixed(1)} ${units[u]}`;
}

const fileHref = (path: string, s: PublishedAsset) =>
  `${path}/f/${encodeURIComponent(s.assetId)}/${encodeURIComponent(s.file.fileName)}`;

/**
 * The share page (the cached entrypoint's miss path): the target's published files, as HTML
 * (`?f=html`) or JSON (`?f=json`). Tagged so revoking the link, a change to the collection, a
 * publish or unpublish of the asset, or deleting the environment purges it; cached no longer than
 * the link lasts. A link that no longer opens, or whose target is gone, is `no-store`. Titles and
 * alt text are the default locale's, else the first the space delivers (`sharedText`); turning a
 * locale off purges Delivery, not these pages, so a cached one catches up within PAGE_MAX_AGE.
 */
export async function serveSharePage(request: Request, deps: ShareDeps): Promise<Response> {
  const url = new URL(request.url);
  const a = verifiedShare(url.pathname, deps.paths);
  if (a?.request.kind !== 'page') return plain(404, 'not found');
  const entry = await shareLinkEntry(deps, a);
  if (entry === null) return plain(404, 'not found');
  if (entry === 'gone')
    return page(410, 'Link unavailable', goneBody, { 'cache-control': 'no-store' });
  const shared = deps.store ? await sharedAssets(deps.store, a.scope, entry) : null;
  if (!shared) return plain(404, 'not found');
  const { spaceId, environmentId } = a.scope;
  const tags = [
    mediaShareLinkTag(spaceId, environmentId, a.linkId),
    mediaEnvironmentTag(spaceId, environmentId),
    entry.targetType === 'asset'
      ? mediaAssetTag(spaceId, environmentId, entry.targetId)
      : mediaCollectionTag(spaceId, environmentId, entry.targetId),
  ];
  const left = Math.floor((Date.parse(entry.expiresAt) - nowOf(deps)) / 1000);
  const caching = {
    'cache-control': `public, max-age=${Math.max(0, Math.min(PAGE_MAX_AGE, left))}`,
    'cache-tag': tags.join(','),
  };
  const path = url.pathname;
  if (url.searchParams.get('f') === 'json') {
    const body = {
      title: shared.title,
      ...(shared.description ? { description: shared.description } : {}),
      expiresAt: entry.expiresAt,
      allowDownload: entry.allowDownload,
      files: shared.items.map((s) => ({
        assetId: s.assetId,
        title: sharedText(s.title, shared.locales) || s.file.fileName,
        fileName: s.file.fileName,
        contentType: s.file.contentType,
        ...(s.file.size !== undefined ? { size: s.file.size } : {}),
        ...(s.file.width !== undefined ? { width: s.file.width } : {}),
        ...(s.file.height !== undefined ? { height: s.file.height } : {}),
        href: fileHref(path, s),
        ...(entry.allowDownload ? { downloadHref: `${fileHref(path, s)}?download` } : {}),
      })),
    };
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json; charset=utf-8', ...PAGE_HEADERS, ...caching },
    });
  }
  const items = shared.items
    .filter((s) => !s.file.video)
    .map((s) => {
      const title = sharedText(s.title, shared.locales) || s.file.fileName;
      const href = fileHref(path, s);
      const alt = sharedText(s.metadata.altText, shared.locales);
      const preview =
        s.file.contentType.startsWith('image/') && s.file.contentType !== 'image/svg+xml'
          ? `<img src="${html(href)}" alt="${html(alt)}" loading="lazy"${s.file.width && s.file.height ? ` width="${s.file.width}" height="${s.file.height}"` : ''}>`
          : '';
      const download = entry.allowDownload
        ? ` · <a href="${html(href)}?download" download>Download<span class="visually-hidden"> ${html(title)}</span></a>`
        : '';
      return `<li>${preview}<a href="${html(href)}">${html(title)}</a>
<div class="meta">${html(s.file.contentType)}${s.file.size !== undefined ? ` · ${humanSize(s.file.size)}` : ''}${download}</div></li>`;
    });
  const expires = new Date(entry.expiresAt).toUTCString();
  return page(
    200,
    shared.title,
    `<h1>${html(shared.title)}</h1>
${shared.description ? `<p>${html(shared.description)}</p>` : ''}
<p class="meta">Shared with you until ${html(expires)}. ${items.length} file${items.length === 1 ? '' : 's'}.</p>
${items.length > 0 ? `<ul>${items.join('\n')}</ul>` : '<p>Nothing has been published here yet.</p>'}
<style>.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}</style>`,
    caching,
  );
}

/**
 * The gateway's share handling: verify, read the link, ask for its password when it has one, then
 * the page (from the cached entrypoint) or one file (through the published file's cached URL).
 */
export async function handleShareRequest(
  request: Request,
  deps: ShareDeps,
  media: MediaEntrypoint,
): Promise<Response> {
  const url = new URL(request.url);
  const a = verifiedShare(url.pathname, deps.paths);
  if (!a) return plain(404, 'not found');
  const isPost = request.method === 'POST';
  if (isPost !== (a.request.kind === 'unlock')) {
    return plain(405, 'method not allowed', { allow: isPost ? 'GET, HEAD' : 'POST' });
  }
  const entry = await shareLinkEntry(deps, a);
  if (entry === null) return plain(404, 'not found');
  if (entry === 'gone')
    return page(410, 'Link unavailable', goneBody, { 'cache-control': 'no-store' });
  const path = pagePath(url.pathname, a);

  if (a.request.kind === 'unlock') return unlock(request, deps, a, entry, path);
  if (entry.passwordHash && !unlocked(request, deps, a)) {
    return a.request.kind === 'page' ? unlockForm(path) : plain(401, 'password required');
  }

  if (a.request.kind === 'page') {
    const accept = request.headers.get('accept') ?? '';
    const json =
      url.searchParams.get('format') === 'json' ||
      (accept.includes('application/json') && !accept.includes('text/html'));
    const upstream = await media.fetch(
      new Request(`${INTERNAL_ORIGIN}${url.pathname}?f=${json ? 'json' : 'html'}`),
    );
    const out = new Response(upstream.body, upstream);
    // The browser keeps nothing: the link is checked again on every visit.
    out.headers.set('cache-control', 'private, no-store');
    out.headers.delete('cache-tag');
    return out;
  }

  const file = a.request;
  const snapshot = deps.store
    ? await sharedAssetFile(deps.store, a.scope, entry, file.assetId)
    : null;
  if (!snapshot || snapshot.file.video) return plain(404, 'not found');
  const version = snapshot.version ?? 1;
  const e = encodeURIComponent;
  const publicPath = `/${e(a.scope.spaceId)}/${e(a.scope.environmentId)}/${e(snapshot.assetId)}/v${version}/${deps.paths.token(a.scope, snapshot.assetId, version)}/o/${e(snapshot.file.fileName)}`;
  const canonical = canonicalMediaUrl(new URL(publicPath, INTERNAL_ORIGIN), null, deps.paths);
  if (!canonical) return plain(404, 'not found');
  const range = singleByteRange(request.headers.get('range'));
  const forwarded = new Headers();
  if (range) forwarded.set('range', range);
  let upstream = await media.fetch(new Request(canonical.url, { headers: forwarded }));
  if (range && upstream.status === 200) {
    await upstream.body?.cancel();
    upstream = await media.range(canonical.url, range, null);
  }
  if (request.method === 'HEAD') await upstream.body?.cancel();
  const out = new Response(request.method === 'HEAD' ? null : upstream.body, upstream);
  if (upstream.status === 200 || upstream.status === 206) {
    const download = entry.allowDownload && url.searchParams.has('download');
    // A type that may never render here (SVG, HTML) stays an attachment, whatever was asked.
    const forced = upstream.headers.get('content-disposition')?.startsWith('attachment');
    out.headers.set(
      'content-disposition',
      contentDisposition(download || forced ? 'attachment' : 'inline', snapshot.file.fileName),
    );
    // Not past a revocation: the browser asks again within minutes.
    out.headers.set('cache-control', 'private, max-age=300');
  }
  out.headers.set('referrer-policy', 'no-referrer');
  out.headers.set('x-robots-tag', 'noindex, nofollow');
  out.headers.delete('cache-tag');
  return out;
}

async function unlock(
  request: Request,
  deps: ShareDeps,
  a: ShareLinkAddress,
  entry: ShareLinkGateEntry,
  path: string,
): Promise<Response> {
  const back = () =>
    new Response(null, { status: 303, headers: { location: path, 'cache-control': 'no-store' } });
  if (!entry.passwordHash) return back();
  const address = request.headers.get('cf-connecting-ip') ?? 'unknown';
  // Per address, and per link from everywhere at once (no spreading guesses over many addresses).
  const limited = async (key: string) =>
    deps.limiter ? !(await deps.limiter.limit({ key })).success : false;
  if ((await limited(`${a.linkId}:${address}`)) || (await limited(`${a.linkId}:*`))) {
    return page(
      429,
      'Too many attempts',
      '<h1>Too many attempts</h1><p>Wait a minute, then try again.</p>',
      {
        'cache-control': 'no-store',
        'retry-after': '60',
      },
    );
  }
  const length = Number(request.headers.get('content-length') ?? '0');
  if (!(length > 0) || length > MAX_FORM_BYTES) return unlockForm(path, 'Enter the password.');
  let password = '';
  try {
    const form = await request.formData();
    const value = form.get('password');
    password = typeof value === 'string' ? value : '';
  } catch {
    return unlockForm(path, 'Enter the password.');
  }
  if (!password || !(await deps.passwords.verify(password, entry.passwordHash))) {
    return unlockForm(path, 'That password is not right.');
  }
  const nowSeconds = Math.floor(nowOf(deps) / 1000);
  const exp = Math.min(nowSeconds + UNLOCK_SECONDS, Math.floor(Date.parse(entry.expiresAt) / 1000));
  const value = `${exp}.${unlockToken(deps.paths, a, exp)}`;
  const res = back();
  res.headers.append(
    'set-cookie',
    `${COOKIE}=${value}; Path=${path}; Max-Age=${Math.max(0, exp - nowSeconds)}; HttpOnly; Secure; SameSite=Lax`,
  );
  return res;
}
