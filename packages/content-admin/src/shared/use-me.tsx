import { atLeast, type Role } from '@commerceworker/security/roles';
import { createContext, useContext } from 'react';
import { useRouteLoaderData } from 'react-router';

export type ContentPerson = { id: string; name: string; email?: string; role: Role };
export const ContentPersonContext = createContext<ContentPerson | null>(null);

export function useMe(): ContentPerson | null {
  const person = useContext(ContentPersonContext);
  const shell = useRouteLoaderData('routes/shell') as { me?: ContentPerson } | undefined;
  return person ?? shell?.me ?? null;
}

export const useCan = (min: Role) => atLeast(useMe()?.role, min);
