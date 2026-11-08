import type { ContentType } from '@commerceworker/domain';
import { Button } from '@commerceworker/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@commerceworker/ui/dropdown-menu';
import { Columns3 } from 'lucide-react';
import { DEFAULT_COLUMNS, SORT_STATUS, SORT_UPDATED } from './EntriesTable';

/**
 * Which columns the entries table shows after the title: the status, when it changed, and any of
 * the type's own fields. The title (the display field) always shows; it is how a row is named.
 * The choice lives in the URL, so a saved view keeps it and a link carries it.
 */
export function ColumnPicker(props: {
  type: ContentType;
  /** The columns shown now; absent is the default. */
  columns: readonly string[] | undefined;
  onChange(columns: readonly string[] | undefined): void;
}) {
  const { type } = props;
  const shown = props.columns ?? DEFAULT_COLUMNS;
  const options = [
    { id: SORT_STATUS, label: 'Status' },
    { id: SORT_UPDATED, label: 'Updated' },
    ...type.fields
      .filter((f) => f.apiId !== type.displayField)
      .map((f) => ({ id: f.apiId, label: f.name })),
  ];
  const toggle = (id: string, on: boolean) => {
    const picked = new Set(shown);
    if (on) picked.add(id);
    else picked.delete(id);
    // In the options' order, whatever order they were clicked in. It also lets go of a column this
    // type doesn't have (a view from another environment), which nothing here can untick.
    const next = options.map((o) => o.id).filter((c) => picked.has(c));
    // Back to the default reads as no choice at all, so the URL stays clean.
    const isDefault =
      next.length === DEFAULT_COLUMNS.length && next.every((c, i) => c === DEFAULT_COLUMNS[i]);
    props.onChange(isDefault ? undefined : next);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Columns3 aria-hidden="true" className="size-4" />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
        <DropdownMenuLabel>Show columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.id}
            checked={shown.includes(o.id)}
            // Stays open: picking several columns is one visit.
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(on) => toggle(o.id, on === true)}
          >
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
