/**
 * What the back office's screens share (Customers, Sellers, Inventory, Pricing, Records): a
 * screen's search, a list's count and pager, the mark for something switched off, and reserved
 * stock linked to the orders holding it.
 */
import { Button } from '@commerceworker/ui/button';
import { Input } from '@commerceworker/ui/input';
import { count } from '@commerceworker/ui/lib/format';
import { cn } from '@commerceworker/ui/lib/utils';
import { Form, Link, useLocation, useSearchParams } from 'react-router';
import { type Paged, pageHref, shown } from '~/lib/commerce-pages';

/**
 * A screen's one search, kept in the URL as `q`. Every list on the screen shows only what matches;
 * the lists' pages start over.
 */
export function FindBar({
  q,
  label,
  matched = 'Every list shows only what matches',
}: {
  q: string;
  /** What it finds, as the field's placeholder and name: "Find a customer". */
  label: string;
  matched?: string;
}) {
  const { pathname } = useLocation();
  return (
    <Form method="get" className="mb-3 flex flex-wrap items-center gap-2" role="search">
      <Input
        name="q"
        type="search"
        enterKeyHint="search"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        defaultValue={q}
        placeholder={label}
        aria-label={label}
        className="h-8 w-full sm:w-80"
      />
      <Button type="submit" size="sm" variant="outline">
        Find
      </Button>
      {q ? (
        <>
          <Link to={pathname} className="hit-area text-link text-sm hover:underline">
            Clear
          </Link>
          <p className="w-full text-muted-foreground text-xs" role="status">
            {matched} “{q}”.
          </p>
        </>
      ) : null}
    </Form>
  );
}

/** A list's count, in its section's header, once it runs past a page: "2,000 items". */
export function Total({ list, noun }: { list: Paged<unknown>; noun: string }) {
  return list.total > list.size ? (
    <span className="text-muted-foreground text-xs tabular">
      {count(list.total)} {noun}s
    </span>
  ) : null;
}

/**
 * Where a list is ("26–50 of 2,000") and the pages either side, for a list longer than a page.
 * Links keep the search and every other list's page, and come back to `hash` when the screen has
 * more than one section.
 */
export function Pager({
  list,
  listKey,
  hash,
  label,
  inset = false,
}: {
  list: Paged<unknown>;
  listKey: string;
  hash?: string;
  label: string;
  inset?: boolean;
}) {
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  if (list.total <= list.size) return null;
  const { first, last } = shown(list);
  const step = (page: number, text: string) =>
    page >= 1 && (page - 1) * list.size < list.total ? (
      <Link
        to={pageHref(pathname, params, listKey, page, hash)}
        className="hit-area text-link hover:underline"
        aria-label={`${text} page of ${label.toLowerCase()}`}
      >
        {text}
      </Link>
    ) : (
      <span className="text-muted-foreground" aria-hidden="true">
        {text}
      </span>
    );
  return (
    <nav
      aria-label={`${label} pages`}
      className={cn(
        'flex items-center gap-4 py-2 pr-4 text-xs',
        inset ? 'pl-8 sm:pl-10' : 'border-t pl-4',
      )}
    >
      <span className="text-muted-foreground tabular">
        {count(first)}–{count(last)} of {count(list.total)}
      </span>
      <span className="ml-auto flex gap-4">
        {step(list.page - 1, 'Previous')}
        {step(list.page + 1, 'Next')}
      </span>
    </nav>
  );
}

/** The one mark for something switched off: a seller who takes no orders, an unused price source. */
export function Off() {
  return <span className="ml-1.5 text-muted-foreground text-xs">Off</span>;
}

/** Reserved stock, linked to the orders holding it (Records, Stock holds, for that SKU). */
export function Held({ sku, n }: { sku: string; n: number }) {
  if (!n) return <>{count(0)}</>;
  return (
    <Link
      to={`/records?q=${encodeURIComponent(sku)}&records=holds`}
      className="text-link hover:underline"
      aria-label={`${count(n)} reserved: see the orders holding ${sku}`}
    >
      {count(n)}
    </Link>
  );
}
