import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoutesStub, Outlet } from 'react-router';

/**
 * A page drawn as the server draws it: under the root route, whose loader data is the store name
 * (`root.tsx`), with the page's own loader data and action data.
 */
export function drawPage(
  Component: () => React.JSX.Element,
  loaderData: Record<string, unknown>,
  storeName: string | null,
  actionData?: Record<string, unknown>,
) {
  const Stub = createRoutesStub([
    {
      id: 'root',
      path: '/',
      Component: Outlet,
      children: [{ id: 'page', path: 'p', Component: Component as never }],
    },
  ]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: ['/p'],
      hydrationData: {
        loaderData: { root: { storeName }, page: loaderData },
        ...(actionData ? { actionData: { page: actionData } } : {}),
      },
    }),
  );
}

/** What a route's `meta` is given of the root above it. */
export const rootMatches = (storeName: string | null) =>
  [{ id: 'root', loaderData: { storeName } }] as never;

/** A name that would be markup if a page drew it as HTML. */
export const MARKUP_NAME = 'Acme <b>Supply</b> & "Sons"';
