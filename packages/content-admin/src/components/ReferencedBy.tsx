import { CollapsibleCard } from '@commerceworker/content-admin/components/CollapsibleCard';
import { Link } from '@commerceworker/content-admin/router';
import type { ContentType } from '@commerceworker/domain';
import { Link2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useClient } from '../lib/client-context';

interface ResolvedRef {
  readonly fromEntryId: string;
  readonly fromField: string;
  readonly contentType?: string;
  readonly title: string;
}

/**
 * "What links here": entries that reference the given entry, resolved to their
 * display titles. Surfaces the reverse-reference graph the backend already
 * tracks. Shown on the entry editor in edit mode.
 */
export function ReferencedBy(props: { id: string; types: ContentType[] }) {
  const { client, conn } = useClient();
  const [refs, setRefs] = useState<ResolvedRef[] | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const edges = await client.reverseReferences(props.id);
        const displayOf = new Map(props.types.map((t) => [t.apiId, t.displayField]));
        const resolved = await Promise.all(
          edges.map(async (e): Promise<ResolvedRef> => {
            try {
              const entry = await client.getEntry(e.fromEntryId);
              const df = displayOf.get(entry.contentType);
              const title = df
                ? (entry.fields[df] as Record<string, unknown> | undefined)?.[conn.locale]
                : undefined;
              return {
                fromEntryId: e.fromEntryId,
                fromField: e.fromField,
                contentType: entry.contentType,
                title: String(title ?? e.fromEntryId),
              };
            } catch {
              return { fromEntryId: e.fromEntryId, fromField: e.fromField, title: e.fromEntryId };
            }
          }),
        );
        if (live) setRefs(resolved);
      } catch {
        if (live) setRefs([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [client, props.id, props.types, conn.locale]);

  if (refs === null) return null;

  return (
    <CollapsibleCard
      title={
        <>
          <Link2 className="size-4 text-muted-foreground" />
          Referenced by
          {refs.length > 0 && (
            <span className="text-muted-foreground text-sm">· {refs.length}</span>
          )}
        </>
      }
    >
      {refs.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing references this entry yet.</p>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {refs.map((r) => (
            <li key={`${r.fromEntryId}:${r.fromField}`} className="flex items-center gap-2">
              {r.contentType ? (
                <Link
                  to={`/content/${r.contentType}/${r.fromEntryId}`}
                  className="font-medium text-primary hover:underline"
                >
                  {r.title}
                </Link>
              ) : (
                <span className="font-mono text-xs">{r.fromEntryId}</span>
              )}
              <span className="text-muted-foreground">via</span>
              <span className="font-mono text-xs">{r.fromField}</span>
            </li>
          ))}
        </ul>
      )}
    </CollapsibleCard>
  );
}
