import type { ReactNode } from 'react';

/**
 * The frame of every account page: the wordmark and one narrow column, padded for the notch, the
 * status bar and the home indicator. A shopper has no navigation here yet, so there is none.
 */
export function AccountShell({ children }: { children: ReactNode }) {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh max-w-md flex-col px-safe-4 pt-safe-6 pb-safe-8 sm:px-safe-6"
    >
      {/* TODO(S7): the merchant's store name, which the wordmark stands in for until then. */}
      <p className="mb-8 font-semibold text-brand tracking-title">CommerceWorker</p>
      {children}
    </main>
  );
}

/** The one button of an account form: a pill, 44px tall, full width. */
export const accountButton =
  'inline-flex min-h-11 w-full items-center justify-center rounded-full bg-primary px-6 text-base font-medium text-primary-foreground disabled:opacity-50';
