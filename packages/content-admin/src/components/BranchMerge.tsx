import { ToneBadge } from '@commerceworker/content-admin/components/status';
import { humanize, type Tone } from '@commerceworker/content-admin/lib/format';
import { Button } from '@commerceworker/ui/button';
import { Card, CardContent, CardHeader } from '@commerceworker/ui/card';
import { Checkbox } from '@commerceworker/ui/checkbox';
import { Label } from '@commerceworker/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@commerceworker/ui/select';
import { ArrowRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useClient } from '../lib/client-context';
import type {
  ChangeKind,
  Environment,
  EnvironmentComparison,
  ManagementClient,
} from '../lib/management';
import { useToast } from '../lib/toast';

const KIND_TONE: Record<ChangeKind, Tone> = {
  added: 'ok',
  changed: 'wait',
  removed: 'bad',
  unchanged: 'idle',
};

/** A toggleable diff row; mergeable rows (added/changed) carry a checkbox. */
function DiffRow(props: {
  label: string;
  kind: ChangeKind;
  checked: boolean;
  onToggle: () => void;
}) {
  const mergeable = props.kind === 'added' || props.kind === 'changed';
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
      <Checkbox
        checked={props.checked}
        onCheckedChange={props.onToggle}
        disabled={!mergeable}
        aria-label={`Select ${props.label}`}
      />
      <span className="flex-1 truncate text-sm">{props.label}</span>
      <ToneBadge tone={KIND_TONE[props.kind]} label={humanize(props.kind)} />
    </li>
  );
}

/**
 * Compare two environments and merge selected changes source→target. Merges are
 * additive/overwriting (never destructive), so only added/changed items are
 * selectable; `removed` (target-only) items are shown for awareness.
 */
export function BranchMerge(props: { client: ManagementClient; environments: Environment[] }) {
  const { client, environments } = props;
  const toast = useToast();
  const { run, busy } = useClient();
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [diff, setDiff] = useState<EnvironmentComparison | null>(null);
  const [pickedTypes, setPickedTypes] = useState<Set<string>>(new Set());
  const [pickedEntries, setPickedEntries] = useState<Set<string>>(new Set());

  // Default the pickers to the first two distinct environments.
  useEffect(() => {
    if (!source && environments[0]) setSource(environments[0].id);
    if (!target && environments[1]) setTarget(environments[1].id);
  }, [environments, source, target]);

  const toggle = useCallback((set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    next.has(id) ? next.delete(id) : next.add(id);
    setter(next);
  }, []);

  const compare = () =>
    run(async () => {
      if (source === target) {
        toast.error('Pick two different environments');
        return;
      }
      const result = await client.compareEnvironments(source, target);
      setDiff(result);
      // Preselect everything mergeable.
      setPickedTypes(
        new Set(
          result.contentTypes
            .filter((c) => c.kind !== 'unchanged' && c.kind !== 'removed')
            .map((c) => c.apiId),
        ),
      );
      setPickedEntries(
        new Set(
          result.entries
            .filter((e) => e.kind !== 'unchanged' && e.kind !== 'removed')
            .map((e) => e.entryId),
        ),
      );
    });

  const merge = () =>
    run(async () => {
      if (!diff) return;
      const result = await client.mergeEnvironments({
        source,
        target,
        contentTypes: [...pickedTypes],
        entries: [...pickedEntries],
      });
      toast.success(
        `Merged ${result.mergedContentTypes.length} type(s) and ${result.mergedEntries.length} entr${result.mergedEntries.length === 1 ? 'y' : 'ies'}`,
      );
      // Re-compare to reflect the new state.
      setDiff(await client.compareEnvironments(source, target));
      setPickedTypes(new Set());
      setPickedEntries(new Set());
    });

  const selectedCount = pickedTypes.size + pickedEntries.size;
  const mergeableTypes = diff?.contentTypes.filter((c) => c.kind !== 'unchanged') ?? [];
  const mergeableEntries = diff?.entries.filter((e) => e.kind !== 'unchanged') ?? [];

  return (
    <Card>
      <CardHeader>
        <h2 className="font-heading font-medium text-base">Compare &amp; merge</h2>
        <p className="text-muted-foreground text-sm">
          Diff two environments and copy selected content types and entries from source to target.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label>Source</Label>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger aria-label="Source environment" className="w-[160px]">
                <SelectValue placeholder="From" />
              </SelectTrigger>
              <SelectContent>
                {environments.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <ArrowRight className="mb-2 size-4 text-muted-foreground" />
          <div className="space-y-1.5">
            <Label>Target</Label>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger aria-label="Target environment" className="w-[160px]">
                <SelectValue placeholder="Into" />
              </SelectTrigger>
              <SelectContent>
                {environments.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={compare}
            disabled={busy || !source || !target}
          >
            Compare
          </Button>
        </div>

        {diff && (
          <div className="space-y-4">
            {mergeableTypes.length === 0 && mergeableEntries.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                These environments are in sync — nothing to merge.
              </p>
            ) : (
              <>
                {mergeableTypes.length > 0 && (
                  <div className="space-y-1">
                    <p className="font-medium text-sm">Content types</p>
                    <ul>
                      {mergeableTypes.map((c) => (
                        <DiffRow
                          key={c.apiId}
                          label={c.apiId}
                          kind={c.kind}
                          checked={pickedTypes.has(c.apiId)}
                          onToggle={() => toggle(pickedTypes, setPickedTypes, c.apiId)}
                        />
                      ))}
                    </ul>
                  </div>
                )}
                {mergeableEntries.length > 0 && (
                  <div className="space-y-1">
                    <p className="font-medium text-sm">Entries</p>
                    <ul>
                      {mergeableEntries.map((e) => (
                        <DiffRow
                          key={e.entryId}
                          label={`${e.contentTypeApiId} · ${e.entryId.slice(0, 8)}`}
                          kind={e.kind}
                          checked={pickedEntries.has(e.entryId)}
                          onToggle={() => toggle(pickedEntries, setPickedEntries, e.entryId)}
                        />
                      ))}
                    </ul>
                  </div>
                )}
                <Button type="button" onClick={merge} disabled={busy || selectedCount === 0}>
                  Merge {selectedCount} selected → {target}
                </Button>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
