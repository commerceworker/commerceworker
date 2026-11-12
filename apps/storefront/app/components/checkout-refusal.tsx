import { Empty } from '@commerceworker/ui/page';
import { ShoppingCart, TriangleAlert } from 'lucide-react';
import { isRouteErrorResponse, useRouteError } from 'react-router';

/**
 * The error boundary of a hosted checkout's pages: the reason a loader refused
 * (`checkoutRefusal`), with no way into the app around it, since the buyer has no sign-in here.
 */
export function CheckoutRefusal() {
  const error = useRouteError();
  const said = isRouteErrorResponse(error) && typeof error.data === 'string' ? error.data : null;
  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-24">
      <Empty
        icon={said ? <ShoppingCart aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
        title={
          <h1 className="text-xl tracking-title">
            {said ? 'This checkout isn’t available' : 'Something went wrong'}
          </h1>
        }
      >
        {said ?? 'Ask the business for a new checkout link.'}
      </Empty>
    </main>
  );
}
