import {
  ASSET_SORTS,
  type AssetFilterState,
  type AssetSortChoice,
  activeFilterCount,
  KIND_LABELS,
} from '@commerceworker/content-admin/lib/assets';
import { ASSET_KINDS, type Tag } from '@commerceworker/domain';
import { Button } from '@commerceworker/ui/button';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Segmented, SegmentedItem } from '@commerceworker/ui/segmented';
import { LayoutGrid, List, X } from 'lucide-react';

export type AssetView = 'grid' | 'list';

const STATUSES = [
  { value: '', label: 'Any status' },
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' },
  { value: 'archived', label: 'Archived' },
  { value: 'all', label: 'Including archived' },
] as const;

/**
 * Filter, sort and view controls for the asset library. As the entries' filter bar, it holds no
 * query state: the screen owns the filters, so it can drive the fetch and show what is active.
 */
export function AssetFilterBar(props: {
  value: AssetFilterState;
  onChange: (next: AssetFilterState) => void;
  tags: readonly Tag[];
  view: AssetView;
  onViewChange: (view: AssetView) => void;
}) {
  const { value, onChange, tags, view } = props;
  const set = (patch: Partial<AssetFilterState>) => onChange({ ...value, ...patch });
  const active = activeFilterCount(value);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect
        size="sm"
        aria-label="Kind"
        value={value.kind ?? ''}
        onChange={(e) => set({ kind: (e.target.value || undefined) as AssetFilterState['kind'] })}
      >
        <NativeSelectOption value="">All kinds</NativeSelectOption>
        {ASSET_KINDS.map((k) => (
          <NativeSelectOption key={k} value={k}>
            {KIND_LABELS[k]}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <NativeSelect
        size="sm"
        aria-label="Status"
        value={value.status ?? ''}
        onChange={(e) =>
          set({ status: (e.target.value || undefined) as AssetFilterState['status'] })
        }
      >
        {STATUSES.map((s) => (
          <NativeSelectOption key={s.value} value={s.value}>
            {s.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {tags.length > 0 && (
        <NativeSelect
          size="sm"
          aria-label="Tag"
          value={value.tag ?? ''}
          onChange={(e) => set({ tag: e.target.value || undefined })}
        >
          <NativeSelectOption value="">Any tag</NativeSelectOption>
          {tags.map((t) => (
            <NativeSelectOption key={t.id} value={t.id}>
              {t.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
      <NativeSelect
        size="sm"
        aria-label="Sort by"
        value={value.sort ?? 'updated-desc'}
        onChange={(e) => {
          const sort = e.target.value as AssetSortChoice;
          set({ sort: sort === 'updated-desc' ? undefined : sort });
        }}
      >
        {ASSET_SORTS.map((s) => (
          <NativeSelectOption key={s.value} value={s.value}>
            {s.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {active > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => onChange({ sort: value.sort })}
        >
          <X aria-hidden="true" />
          Clear filters
        </Button>
      )}
      <Segmented
        aria-label="View"
        className="ml-auto"
        value={view}
        onValueChange={(v) => props.onViewChange(v as AssetView)}
      >
        <SegmentedItem value="grid" aria-label="Grid">
          <LayoutGrid aria-hidden="true" />
        </SegmentedItem>
        <SegmentedItem value="list" aria-label="List">
          <List aria-hidden="true" />
        </SegmentedItem>
      </Segmented>
    </div>
  );
}
