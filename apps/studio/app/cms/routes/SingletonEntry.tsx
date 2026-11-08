import { Button } from '@commerceworker/ui/button';
import { FileText } from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router';
import { PageSkeleton } from '~/cms/components/loading';
import { Empty } from '~/cms/components/page';
import { useClient } from '../lib/client-context';
import { useScopedQuery } from '../lib/queries';
import { useContentOutlet } from './content-context';

/**
 * A singleton type's one entry, wherever it is (`/content/:typeId/entry`): the sidebar's link for
 * such a type, so it opens the editor rather than a list of one. It finds the entry and moves on
 * to its editor, or to a new entry when the type has none outside the trash. A type that is not
 * (or no longer) a singleton goes to its list.
 *
 * Under the entries prefix, so creating, trashing or restoring an entry refreshes where it leads.
 */
export function SingletonEntry() {
  const { typeId = '' } = useParams();
  const { client } = useClient();
  const { types, typesPending } = useContentOutlet();
  const type = types.find((t) => t.apiId === typeId);
  const found = useScopedQuery(
    ['entries', 'singleton', typeId],
    () => client.getSingletonEntry(typeId),
    { enabled: type?.singleton === true, silent: true },
  );

  if (typesPending || (type?.singleton && found.isPending)) {
    return <PageSkeleton title={type?.name ?? ''} label={type?.name ?? 'the entry'} />;
  }
  if (!type?.singleton) return <Navigate replace to={`/content/${typeId}`} />;
  if (found.isError) {
    return (
      <Empty
        icon={<FileText />}
        title={`${type.name} couldn’t be opened`}
        className="card mt-6"
        action={
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void found.refetch()}>
              Try again
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to={`/content/${typeId}`}>Show its entries</Link>
            </Button>
          </div>
        }
      >
        Its entry couldn’t be read just now.
      </Empty>
    );
  }
  return (
    <Navigate
      replace
      to={found.data ? `/content/${typeId}/${found.data.id}` : `/content/${typeId}/new`}
    />
  );
}
