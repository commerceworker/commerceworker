import { Source, Sources } from '@commerceworker/content-admin/components/ai/Sources';
import { CollapsibleCard } from '@commerceworker/content-admin/components/CollapsibleCard';
import { LoadingStatus } from '@commerceworker/content-admin/components/loading';
import { ToneBadge } from '@commerceworker/content-admin/components/status';
import { SkeletonText } from '@commerceworker/ui/skeleton';
import { GitCompare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useClient } from '../lib/client-context';
import type { SearchHit } from '../lib/management';
import type { PickOption } from './EntryForm';

/**
 * Content Semantics for an entry: surfaces near-duplicates (informational, collapsed) and
 * semantically related entries, both backed by the Vectorize index. Only
 * published entries are indexed, so results reflect shipped content.
 */
export function SemanticPanel(props: {
  entryId: string;
  /** Known entries (from the editor's pickers) to render titles and links
   * instead of raw ids. Best-effort; unknown ids fall back to the snippet. */
  entries?: readonly PickOption[];
}) {
  const { client } = useClient();
  const [related, setRelated] = useState<SearchHit[] | null>(null);
  const [dupes, setDupes] = useState<SearchHit[]>([]);

  useEffect(() => {
    let live = true;
    setRelated(null);
    setDupes([]);
    Promise.all([
      client.relatedEntries(props.entryId, 5),
      client.findDuplicates(props.entryId, 0.9),
    ])
      .then(([r, d]) => {
        if (!live) return;
        setRelated(r);
        setDupes(d);
      })
      .catch(() => {
        if (live) setRelated([]);
      });
    return () => {
      live = false;
    };
  }, [client, props.entryId]);

  const pct = (score: number) => `${Math.round(score * 100)}%`;
  const known = new Map((props.entries ?? []).map((e) => [e.id, e]));

  // Unknown entries are named by the opening words of their snippet (clipped,
  // quoted, one line), which an editor recognises; the rest of the snippet
  // sits behind the excerpt toggle, never inline.
  const hitTitle = (hit: SearchHit) => {
    const label = known.get(hit.entryId)?.label;
    if (label) return label;
    const opening = hit.snippet.trim().split(/\s+/).slice(0, 8).join(' ');
    return opening ? `“${opening}…”` : `Entry ${hit.entryId.slice(0, 8)}…`;
  };

  const hitLink = (hit: SearchHit) => {
    const entry = known.get(hit.entryId);
    return entry?.contentType ? `/content/${entry.contentType}/${hit.entryId}` : null;
  };

  return (
    <CollapsibleCard
      defaultOpen
      title={
        <>
          <GitCompare className="size-4 text-muted-foreground" /> Content semantics
        </>
      }
      description="Related entries and near-duplicates, from the vector index."
      contentClassName="space-y-3"
    >
      {dupes.length > 0 && (
        // Informational, not an error: near-duplicates are worth a look, and
        // the editor decides. Collapsed to one line until asked for.
        <Sources
          className="rounded-2xl bg-muted px-3 py-2"
          summary={
            <>
              <ToneBadge tone="wait" label="Review" />
              <span className="truncate">
                {dupes.length} possible duplicate{dupes.length > 1 ? 's' : ''}
              </span>
            </>
          }
        >
          {dupes.map((d) => (
            <Source
              key={d.entryId}
              title={hitTitle(d)}
              to={hitLink(d)}
              measure={`${pct(d.score)} similar`}
              excerpt={d.snippet}
            />
          ))}
        </Sources>
      )}

      {related === null ? (
        <>
          <LoadingStatus>Loading related entries…</LoadingStatus>
          <ul className="space-y-1">
            {['74%', '58%', '66%'].map((w) => (
              <li key={w} aria-hidden="true" className="flex items-center gap-2 text-sm">
                <SkeletonText width={w} className="flex-1" />
                <span className="shrink-0 text-xs">
                  <SkeletonText width="1.75rem" />
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : related.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No related entries yet (publish entries to index them).
        </p>
      ) : (
        <ul className="space-y-1">
          {related.map((r) => (
            <Source
              key={r.entryId}
              title={hitTitle(r)}
              to={hitLink(r)}
              measure={pct(r.score)}
              excerpt={r.snippet}
            />
          ))}
        </ul>
      )}
    </CollapsibleCard>
  );
}
