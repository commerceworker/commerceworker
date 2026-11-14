import { CollapsibleCard } from '@commerceworker/content-admin/components/CollapsibleCard';
import { LoadingStatus } from '@commerceworker/content-admin/components/loading';
import { Link } from '@commerceworker/content-admin/router';
import { Badge } from '@commerceworker/ui/badge';
import { Button } from '@commerceworker/ui/button';
import { cn } from '@commerceworker/ui/lib/utils';
import { SkeletonPill, SkeletonText } from '@commerceworker/ui/skeleton';
import { Link as LinkIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useClient, useLocalRun } from '../lib/client-context';
import { useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

/** A toggleable chip; selected chips render filled. */
function Chip(props: {
  label: string;
  selected: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" onClick={props.onToggle} disabled={props.disabled}>
      <Badge
        variant={props.selected ? 'default' : 'outline'}
        className={cn('cursor-pointer', !props.selected && 'hover:bg-muted')}
      >
        {props.label}
      </Badge>
    </button>
  );
}

/**
 * Associates an entry with taxonomy tags and concepts. The selection takes
 * effect on the next publish (the published snapshot copies the metadata), so a
 * note nudges the editor to publish. P14 entry tagging.
 */
export function EntryMetadataPanel(props: { entryId: string }) {
  const { client } = useClient();
  const { busy, run } = useLocalRun();
  const toast = useToast();
  const tagsQuery = useScopedQuery(['tags'], () => client.listTags());
  const conceptsQuery = useScopedQuery(['concepts'], () => client.listConcepts());
  const metaQuery = useScopedQuery(['entry-metadata', props.entryId], () =>
    client.getEntryMetadata(props.entryId),
  );
  const tags = tagsQuery.data ?? [];
  const concepts = conceptsQuery.data ?? [];
  const [selTags, setSelTags] = useState<Set<string>>(new Set());
  const [selConcepts, setSelConcepts] = useState<Set<string>>(new Set());

  // Seed the selection once the entry's stored metadata lands.
  useEffect(() => {
    if (!metaQuery.data) return;
    setSelTags(new Set(metaQuery.data.tags));
    setSelConcepts(new Set(metaQuery.data.concepts));
  }, [metaQuery.data]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };

  const save = () =>
    run(async () => {
      await client.setEntryMetadata(props.entryId, {
        tags: [...selTags],
        concepts: [...selConcepts],
      });
      toast.success('Tags & concepts saved');
    });

  const loading = tagsQuery.isLoading || conceptsQuery.isLoading || metaQuery.isLoading;
  const empty = tags.length === 0 && concepts.length === 0;

  return (
    <CollapsibleCard title="Tags & concepts" contentClassName="space-y-4">
      {loading ? (
        <div className="space-y-2">
          <LoadingStatus>Loading tags and concepts…</LoadingStatus>
          <p className="font-medium text-sm">
            <SkeletonText width="2.5rem" />
          </p>
          <div className="flex flex-wrap gap-2" aria-hidden="true">
            {['w-14', 'w-20', 'w-16', 'w-24', 'w-12'].map((w) => (
              <SkeletonPill key={w} className={w} />
            ))}
          </div>
        </div>
      ) : empty ? (
        <p className="text-muted-foreground text-sm">
          No vocabulary defined yet. Add tags and concepts under{' '}
          <Link to="/taxonomy" className="inline-flex items-center gap-1 underline">
            <LinkIcon className="size-3" />
            Taxonomy
          </Link>
          .
        </p>
      ) : (
        <>
          {tags.length > 0 && (
            <div className="space-y-2">
              <p className="font-medium text-sm">Tags</p>
              <div className="flex flex-wrap gap-2">
                {tags.map((t) => (
                  <Chip
                    key={t.id}
                    label={t.name}
                    selected={selTags.has(t.id)}
                    onToggle={() => toggle(selTags, setSelTags, t.id)}
                    disabled={busy}
                  />
                ))}
              </div>
            </div>
          )}
          {concepts.length > 0 && (
            <div className="space-y-2">
              <p className="font-medium text-sm">Concepts</p>
              <div className="flex flex-wrap gap-2">
                {concepts.map((c) => (
                  <Chip
                    key={c.id}
                    label={c.prefLabel}
                    selected={selConcepts.has(c.id)}
                    onToggle={() => toggle(selConcepts, setSelConcepts, c.id)}
                    disabled={busy}
                  />
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 border-t pt-3">
            <p className="text-muted-foreground text-xs">Applies on the next publish.</p>
            <Button type="button" size="sm" onClick={save} disabled={busy}>
              Save
            </Button>
          </div>
        </>
      )}
    </CollapsibleCard>
  );
}
