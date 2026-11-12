import { useNonce } from '@commerceworker/ui/lib/nonce';
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from 'react-router';
import { storefrontSettings } from '~/lib/hosted-checkout.server';
import { storeNameOf } from '~/lib/store-name';
import type { Route } from './+types/root';
// Inter (one variable file for every weight) and IBM Plex Mono, served from this origin (no
// render-blocking third-party stylesheet). Each file's unicode-range means a browser fetches only
// the subsets a page uses.
import '@fontsource-variable/inter/wght.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import interLatin from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import './app.css';

/** Running text and titles: fetched with the page rather than once the stylesheet is parsed. */
const fontPreload = (href: string) =>
  ({ rel: 'preload', href, as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' }) as const;

export const links: Route.LinksFunction = () => [
  fontPreload(interLatin),
  { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
];

/**
 * The merchant's store name, for every page's heading and title. A settings read that fails costs
 * the name, not the page: buyer pages then name no one.
 */
export async function loader() {
  const storeName = await storefrontSettings()
    .then((s) => s.storeName)
    .catch(() => null);
  return { storeName };
}

export const meta: Route.MetaFunction = ({ matches }) => [
  // The routes set their own titles; this one is for a page that has none (an error).
  { title: storeNameOf(matches) ?? 'Checkout' },
  { name: 'format-detection', content: 'telephone=no' },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const nonce = useNonce();
  return (
    <html lang="en" data-theme="light">
      <head>
        <meta charSet="utf-8" />
        {/* viewport-fit=cover lets pages pad themselves with the safe-area insets (app.css). */}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#ffffff" />
        <Meta />
        <Links nonce={nonce} />
      </head>
      <body>
        {children}
        <ScrollRestoration nonce={nonce} />
        <Scripts nonce={nonce} />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * Anything a route's own boundary doesn't catch (the cart pages have one that says why). A buyer
 * has no app to go back to, so the way out is their purchasing system.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const found = isRouteErrorResponse(error) && error.status === 404;
  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="tracking-title font-semibold text-3xl">
        {found ? 'Not found' : 'Something went wrong'}
      </h1>
      <p className="mt-2 text-muted-foreground">
        {found
          ? 'That page does not exist.'
          : 'Go back to your purchasing system and open the catalog again.'}
      </p>
    </main>
  );
}
