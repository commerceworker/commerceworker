import type { ReactNode } from 'react';
import { Form, NavLink } from 'react-router';
import { useStoreName } from '~/lib/store-name';

/**
 * The frame of every account page: the store's name and one narrow column, padded for the notch, the
 * status bar and the home indicator. `wide` is for the pages that list things (orders, addresses),
 * which have room to.
 */
export function AccountShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const storeName = useStoreName();
  return (
    <main
      id="main"
      className={`mx-auto flex min-h-dvh flex-col px-safe-4 pt-safe-6 pb-safe-8 sm:px-safe-6 ${wide ? 'max-w-2xl' : 'max-w-md'}`}
    >
      {/* The merchant's name, or a neutral label: never the platform's. */}
      <p className="mb-8 font-semibold text-brand tracking-title">{storeName ?? 'Your account'}</p>
      {children}
    </main>
  );
}

const link =
  'inline-flex min-h-11 items-center rounded-full px-4 text-base text-muted-foreground aria-[current=page]:bg-muted aria-[current=page]:font-medium aria-[current=page]:text-foreground';

/**
 * A signed-in shopper's page: who they are, where they can go, and sign out. Orders and Addresses
 * are plain links and sign out a plain form, so nothing here needs a script.
 */
export function SignedInShell({ email, children }: { email: string; children: ReactNode }) {
  return (
    <AccountShell wide>
      <nav aria-label="Your account" className="-mx-4 mb-6 flex flex-wrap gap-1">
        <NavLink to="/account" end className={link}>
          Orders
        </NavLink>
        <NavLink to="/account/addresses" className={link}>
          Addresses
        </NavLink>
        <NavLink to="/account/apps" className={link}>
          Linked apps
        </NavLink>
      </nav>
      {children}
      <footer className="mt-10 border-t pt-6">
        <p className="text-muted-foreground">
          Signed in as <span className="break-all font-medium text-foreground">{email}</span>.
        </p>
        <Form method="post" action="/account" className="mt-4">
          <button type="submit" className={accountButton}>
            Sign out
          </button>
        </Form>
      </footer>
    </AccountShell>
  );
}

/** The one button of an account form: a pill, 44px tall, full width. */
export const accountButton =
  'inline-flex min-h-11 w-full items-center justify-center rounded-full bg-primary px-6 text-base font-medium text-primary-foreground disabled:opacity-50';

/** The quieter button beside it: an outline, as tall. */
export const accountButtonQuiet =
  'inline-flex min-h-11 w-full items-center justify-center rounded-full border border-border bg-background px-6 text-base font-medium text-foreground disabled:opacity-50';
