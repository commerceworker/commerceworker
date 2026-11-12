import { Empty } from '@commerceworker/ui/page';
import { TriangleAlert, UserRound } from 'lucide-react';
import { isRouteErrorResponse, useRouteError } from 'react-router';

/**
 * The error boundary of the account pages: the reason a loader or action refused, with a way back
 * to asking for a new code, since a link that has been used or has expired is the usual one.
 */
export function AccountRefusal() {
  const error = useRouteError();
  const said = isRouteErrorResponse(error) && typeof error.data === 'string' ? error.data : null;
  return (
    <main id="main" className="mx-auto max-w-md px-safe-4 py-24 sm:px-safe-6">
      <Empty
        icon={said ? <UserRound aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
        title={
          <h1 className="text-xl tracking-title">
            {said ? 'We couldn’t sign you in' : 'Something went wrong'}
          </h1>
        }
      >
        {said ?? 'Try again in a moment.'}
        <a href="/account/sign-in" className="mt-4 inline-flex min-h-11 items-center underline">
          Get a new code
        </a>
      </Empty>
    </main>
  );
}
