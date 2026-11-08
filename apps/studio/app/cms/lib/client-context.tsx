import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  type Connection,
  createManagementClient,
  type ManagementClient,
  type SpaceRef,
} from './management';
import { useToast } from './toast';

/**
 * The CMS screens' shared scope: which space, environment and locale they work in, a memoized
 * Management client for it, and a `run()` helper that wraps the page's primary mutation with a
 * busy flag and surfaces errors as toasts.
 *
 * There is no token here. The browser talks to its own origin and the web Worker's gateway
 * signs the signed-in person into every request it forwards to the api Worker, so being on
 * this page already means being signed in. The scope lives in localStorage (and can be set by
 * `?space=` / `?env=` / `?locale=` on any CMS URL, so a link can carry it); the spaces to pick
 * from come from `GET /spaces`.
 *
 * `busy`/`run` are for the surface's PRIMARY mutation (saving a form, publishing): the flag is
 * page-global, so a side panel using it would disable the main action while it fetches. Panels
 * read through TanStack Query and run their own mutations through `useLocalRun()` instead.
 */
interface ClientApi {
  readonly conn: Connection;
  readonly updateConn: (patch: Partial<Connection>) => void;
  readonly client: ManagementClient;
  readonly busy: boolean;
  /** The spaces this person can reach, once loaded. */
  readonly spaces: readonly SpaceRef[] | undefined;
  /** True once the scope is known (after hydration and the spaces list). */
  readonly ready: boolean;
  /** Signing out is the web app's own form (shell.tsx), submitted here for the palette. */
  signOut(): void;
  run(fn: () => Promise<void>): Promise<void>;
}

const Ctx = createContext<ClientApi | null>(null);

export function useClient(): ClientApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('useClient must be used within <ClientProvider>');
  return api;
}

/** The client scope when one is mounted, else null (the shell's switchers outside the CMS). */
export const useOptionalClient = () => useContext(Ctx);

/**
 * A busy flag + error-toasting runner scoped to the calling component. Same contract as the
 * context's `run`, but concurrent panels can't disable each other's controls or race the flag.
 */
export function useLocalRun(): { busy: boolean; run: (fn: () => Promise<void>) => Promise<void> } {
  const toast = useToast();
  const [pending, setPending] = useState(0);
  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setPending((n) => n + 1);
      try {
        await fn();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setPending((n) => n - 1);
      }
    },
    [toast],
  );
  return { busy: pending > 0, run };
}

export const SCOPE_KEY = 'commerceworker-scope';

const DEFAULT_SCOPE: Connection = { space: '', environment: 'main', locale: '' };

/** The stored scope, overlaid with any `?space=`, `?env=` or `?locale=` in the URL. */
export function readScope(search = '', storage?: Pick<Storage, 'getItem'>): Connection {
  let stored: Partial<Connection> = {};
  try {
    const raw = (storage ?? window.localStorage).getItem(SCOPE_KEY);
    if (raw) stored = JSON.parse(raw) as Partial<Connection>;
  } catch {
    /* no storage, or a bad value: start fresh */
  }
  const params = new URLSearchParams(search);
  const pick = (k: keyof Connection, param: string) => {
    const v = params.get(param) ?? stored[k];
    return typeof v === 'string' && v ? v : DEFAULT_SCOPE[k];
  };
  return {
    space: pick('space', 'space'),
    environment: pick('environment', 'env'),
    locale: pick('locale', 'locale'),
  };
}

function writeScope(conn: Connection) {
  try {
    window.localStorage.setItem(SCOPE_KEY, JSON.stringify(conn));
  } catch {
    /* quota or private mode: the scope just won't survive a reload */
  }
}

/** Sends a signed-out (or expired) session back to sign-in, returning here afterwards. */
function toSignIn() {
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

export function ClientProvider(props: {
  children: React.ReactNode;
  /** Tests: a fixed scope and fetch, skipping storage. */
  initial?: Connection;
  fetchImpl?: typeof fetch;
}) {
  const toast = useToast();
  const [conn, setConn] = useState<Connection>(props.initial ?? DEFAULT_SCOPE);
  const [hydrated, setHydrated] = useState(!!props.initial);
  const [pending, setPending] = useState(0);

  // The scope is the browser's (storage, the URL): read it once mounted, never on the server.
  useEffect(() => {
    if (props.initial) return;
    setConn(readScope(window.location.search));
    setHydrated(true);
  }, [props.initial]);

  const updateConn = useCallback((patch: Partial<Connection>) => {
    setConn((prev) => {
      const next = { ...prev, ...patch };
      // A new space starts on its main environment and its own default locale.
      if (patch.space && patch.space !== prev.space) {
        if (!patch.environment) Object.assign(next, { environment: 'main' });
        if (!patch.locale) Object.assign(next, { locale: '' });
      }
      writeScope(next);
      return next;
    });
  }, []);

  const fetchImpl = props.fetchImpl;
  const client = useMemo(
    () =>
      createManagementClient(conn, fetchImpl ?? ((...a) => fetch(...a)), {
        onUnauthorized: toSignIn,
      }),
    [conn, fetchImpl],
  );

  // The spaces this person can reach: a deployment admin sees them all, a member their own.
  const spacesQuery = useQuery({
    queryKey: ['spaces'],
    queryFn: () => client.listSpaces(),
    enabled: hydrated,
    staleTime: 5 * 60_000,
    meta: { silent: true },
  });
  const spaces = spacesQuery.data;

  // Land on a space this person can reach: the stored one if it's on the list, else the first.
  useEffect(() => {
    if (!spaces?.length) return;
    if (!spaces.some((s) => s.id === conn.space)) updateConn({ space: spaces[0]?.id ?? '' });
  }, [spaces, conn.space, updateConn]);

  // The locale defaults to the space's own default.
  const configQuery = useQuery({
    queryKey: [conn.space, conn.environment, 'space-config'],
    queryFn: () => client.getSpaceConfig(),
    enabled: hydrated && !!conn.space && !conn.locale,
    meta: { silent: true },
    retry: false,
  });
  useEffect(() => {
    if (!conn.locale && configQuery.data?.defaultLocale) {
      updateConn({ locale: configQuery.data.defaultLocale });
    }
  }, [conn.locale, configQuery.data, updateConn]);

  const signOut = useCallback(() => {
    const form = document.getElementById('sign-out');
    if (form instanceof HTMLFormElement) form.requestSubmit();
    else window.location.assign('/logout');
  }, []);

  // Counter, not boolean: with overlapping runs a boolean would go idle when the FIRST one
  // finished, re-enabling controls while work is still in flight.
  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setPending((n) => n + 1);
      try {
        await fn();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setPending((n) => n - 1);
      }
    },
    [toast],
  );
  const busy = pending > 0;
  const ready =
    hydrated &&
    !!conn.space &&
    (!!props.initial || (spaces?.some((s) => s.id === conn.space) ?? false)) &&
    !!conn.locale;

  const api = useMemo<ClientApi>(
    () => ({
      conn: { ...conn, locale: conn.locale || 'en-US' },
      updateConn,
      client,
      busy,
      spaces,
      ready,
      signOut,
      run,
    }),
    [conn, updateConn, client, busy, spaces, ready, signOut, run],
  );

  return <Ctx.Provider value={api}>{props.children}</Ctx.Provider>;
}

/** Why the CMS can't show yet, for the scope gate (lib/cms-gate). */
export function useScopeState(): 'loading' | 'no-spaces' | 'error' | 'ready' {
  const api = useClient();
  const q = useQuery({
    queryKey: ['spaces'],
    queryFn: () => api.client.listSpaces(),
    enabled: false,
  });
  if (api.ready) return 'ready';
  if (q.isError) return 'error';
  if (api.spaces && api.spaces.length === 0) return 'no-spaces';
  return 'loading';
}
