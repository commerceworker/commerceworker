import { useRouteLoaderData } from 'react-router';

/**
 * The merchant's name for buyer pages, which the root route loads (`StorefrontRpc.storefrontSettings`)
 * and every page reads here. Null when none is set: buyer pages then name no one, never the platform
 * the store runs on. The name is the merchant's text, so it only ever goes into the page as text.
 */
export const useStoreName = (): string | null =>
  useRouteLoaderData<{ storeName: string | null }>('root')?.storeName ?? null;

/** What a route's `meta` is given of the matches above it: the root's loader data is among them. */
type Matches = ReadonlyArray<{ id: string; loaderData?: unknown } | undefined>;

/** The store name from a `meta` function's matches, or null. */
export function storeNameOf(matches: Matches): string | null {
  const root = matches.find((m) => m?.id === 'root')?.loaderData as
    | { storeName?: string | null }
    | undefined;
  return root?.storeName ?? null;
}

/** A page's `<title>`: the page, then the store's name when it has one. */
export const pageTitle = (matches: Matches, page: string) => {
  const store = storeNameOf(matches);
  return store ? `${page} · ${store}` : page;
};
