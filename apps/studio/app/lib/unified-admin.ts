/** Old bookmarks and OAuth browser entrypoints enter the commerce admin; machine URLs stay put. */
export function unifiedDestination(path: string): string {
  if (/^\/oauth\/(authorize|device)$/.test(path)) return `/content-api${path}`;
  if (/^\/(account|team|audit)(\/|$)/.test(path)) return path;
  if (path === '/setup' || path.startsWith('/setup/')) return '/team';
  if (path === '/login' || path.startsWith('/login/')) return '/login';
  if (path === '/' || path === '/dashboard') return '/content';
  if (path === '/media') return '/content/assets';
  if (/^\/content(\/|$)/.test(path)) return path.replace(/^\/content/, '/content/entries');
  return `/content${path}`;
}

export function unifiedRedirect(request: Request, origin: string): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response('Open this page in the CommerceWorker admin and try again.', {
      status: 410,
      headers: { 'cache-control': 'no-store' },
    });
  const from = new URL(request.url);
  const to = new URL(origin);
  to.pathname = unifiedDestination(from.pathname.replace(/\.data$/, ''));
  to.search = from.search;
  to.searchParams.delete('_routes');
  if (to.pathname === '/login') {
    const next = from.searchParams.get('next');
    to.searchParams.delete('next');
    if (next?.startsWith('/') && !next.startsWith('//'))
      to.searchParams.set('next', unifiedDestination(next));
  }
  return new Response(null, {
    status: 302,
    headers: { location: to.href, 'cache-control': 'no-store' },
  });
}
