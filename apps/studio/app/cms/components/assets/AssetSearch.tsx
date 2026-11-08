import { Badge } from '@commerceworker/ui/badge';
import { ListSearch } from '@commerceworker/ui/catalog';
import { cn } from '@commerceworker/ui/lib/utils';
import { BADGE_BUTTON_FOCUS } from '~/cms/components/assets/AssetIngestBadges';
import type { FacetChip } from '~/cms/lib/assets';

/**
 * The library's search box. It holds no query state: the screen owns the text (and debounces it
 * into the search), so clearing it puts the library back as it was.
 */
export function AssetSearchBox(props: { value: string; onChange: (next: string) => void }) {
  const { value, onChange } = props;
  return (
    <ListSearch
      label="Search assets"
      className="sm:max-w-xs"
      placeholder="Search names, alt text, tags, text…"
      value={value}
      maxLength={256}
      onChange={(e) => onChange(e.target.value)}
      onClear={() => onChange('')}
    />
  );
}

const FACET_NAMES: Record<FacetChip['facet'], string> = {
  kind: 'Kind',
  tag: 'Tag',
  folder: 'Folder',
};

/**
 * A search's facets as toggles: each chip narrows the results to its kind, tag or folder (pressed
 * while it does), and says how many matches it has. A facet with no chips is left out.
 */
export function AssetFacetChips(props: {
  groups: Readonly<Record<FacetChip['facet'], readonly FacetChip[]>>;
  isActive: (chip: FacetChip) => boolean;
  onToggle: (chip: FacetChip) => void;
}) {
  const facets = (['kind', 'tag', 'folder'] as const).filter((f) => props.groups[f].length > 0);
  if (facets.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {facets.map((facet) => (
        // biome-ignore lint/a11y/useSemanticElements: a group of toggles, not a form fieldset
        <div
          key={facet}
          role="group"
          aria-label={FACET_NAMES[facet]}
          className="flex flex-wrap items-center gap-1.5"
        >
          <span aria-hidden="true" className="caption w-14 shrink-0 text-muted-foreground">
            {FACET_NAMES[facet]}
          </span>
          {props.groups[facet].map((chip) => {
            const on = props.isActive(chip);
            return (
              <button
                key={chip.value}
                type="button"
                aria-pressed={on}
                onClick={() => props.onToggle(chip)}
                className={BADGE_BUTTON_FOCUS}
              >
                {/* Named by what it shows (“Images 3 matches”), so speech and sight agree. */}
                <Badge variant={on ? 'default' : 'outline'}>
                  {chip.label}{' '}
                  <span className={cn('tabular-nums', !on && 'text-muted-foreground')}>
                    {chip.count}
                  </span>{' '}
                  <span className="sr-only">{chip.count === 1 ? 'match' : 'matches'}</span>
                </Badge>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
