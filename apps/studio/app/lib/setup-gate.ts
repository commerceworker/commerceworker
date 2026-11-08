/**
 * What a deployed workspace answers before its first admin exists (`awaitingSetup`): the setup
 * page, the requests that page itself makes, and the built files (`/_static/`, vite.config.ts).
 * Everything else redirects a browser to /setup or answers 503 (workers/app.ts).
 *
 * The setup page is a React Router route, so besides `/setup` itself it loads and submits through
 * `/setup.data` (single fetch: the loader's data and the form's action) and discovers routes
 * through `/__manifest` (lazy route discovery; nothing there that the public client bundles don't
 * already hold). Static files in `public/` are served before the Worker runs.
 */
export function answersBeforeSetup(pathname: string): boolean {
  return (
    pathname === '/setup' ||
    pathname === '/setup.data' ||
    pathname === '/__manifest' ||
    pathname.startsWith('/_static/')
  );
}
