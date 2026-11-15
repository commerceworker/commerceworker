import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from './toast';

/**
 * App-wide TanStack Query provider. Query errors surface as toasts (the same
 * convention `run()` uses for mutations) unless the query opts out with
 * `meta: { silent: true }` — used for best-effort data like pickers and
 * extensions where the screen still works without the result.
 */
export function AppQueryProvider(props: { children: React.ReactNode }) {
  const toast = useToast();
  const [client] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          onError: (error, query) => {
            if (query.meta?.silent) return;
            toast.error(error instanceof Error ? error.message : String(error));
          },
        }),
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>;
}
