import type { ShouldRevalidateFunctionArgs } from 'react-router';

/**
 * A layout's `shouldRevalidate`: a change to the search alone, on the same page, is that page's
 * own state (the entries list writes its filters there as they're typed) and asks nothing new of
 * a layout's server loader. A submission, a new page or an explicit revalidate goes on as usual.
 */
export function revalidateUnlessSearchOnly({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
  const searchOnly =
    !formMethod && currentUrl.pathname === nextUrl.pathname && currentUrl.search !== nextUrl.search;
  return searchOnly ? false : defaultShouldRevalidate;
}
