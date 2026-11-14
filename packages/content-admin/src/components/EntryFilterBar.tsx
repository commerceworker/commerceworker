import type { ContentType, FieldType, FilterOp } from '@commerceworker/domain';
import { Badge } from '@commerceworker/ui/badge';
import { Button } from '@commerceworker/ui/button';
import { ListSearch } from '@commerceworker/ui/catalog';
import { Input } from '@commerceworker/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@commerceworker/ui/select';
import { ListFilter, Plus, UserRound, X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { statusLabel } from '../lib/format';
import type { EntryFilter, EntryListQuery } from '../lib/management';

/** Operators offered per field category — narrows the menu to what makes sense. */
const OPS_BY_CATEGORY = {
  text: [
    { value: 'eq', label: 'is' },
    { value: 'ne', label: 'is not' },
    { value: 'match', label: 'contains' },
    { value: 'in', label: 'is any of' },
    { value: 'nin', label: 'is none of' },
    { value: 'exists', label: 'exists' },
  ],
  number: [
    { value: 'eq', label: '=' },
    { value: 'ne', label: '≠' },
    { value: 'gt', label: '>' },
    { value: 'gte', label: '≥' },
    { value: 'lt', label: '<' },
    { value: 'lte', label: '≤' },
    { value: 'exists', label: 'exists' },
  ],
  date: [
    { value: 'eq', label: 'on' },
    { value: 'gt', label: 'after' },
    { value: 'gte', label: 'on or after' },
    { value: 'lt', label: 'before' },
    { value: 'lte', label: 'on or before' },
    { value: 'exists', label: 'exists' },
  ],
  boolean: [
    { value: 'eq', label: 'is' },
    { value: 'exists', label: 'exists' },
  ],
  array: [
    { value: 'in', label: 'has any of' },
    { value: 'nin', label: 'has none of' },
    { value: 'eq', label: 'has' },
    { value: 'exists', label: 'is not empty' },
  ],
  status: [
    { value: 'eq', label: 'is' },
    { value: 'ne', label: 'is not' },
    { value: 'in', label: 'is any of' },
  ],
} satisfies Record<string, { value: FilterOp; label: string }[]>;

type Category = keyof typeof OPS_BY_CATEGORY;

const ENTRY_STATUSES = ['draft', 'changed', 'published', 'archived'] as const;

function categoryOf(type: FieldType): Category {
  switch (type) {
    case 'Integer':
    case 'Number':
      return 'number';
    case 'Date':
      return 'date';
    case 'Boolean':
      return 'boolean';
    case 'Array':
      return 'array';
    default:
      return 'text';
  }
}

interface FieldOption {
  readonly field: string;
  readonly label: string;
  readonly category: Category;
}

const STATUS_OPTION: FieldOption = { field: 'sys.status', label: 'Status', category: 'status' };

/** Builds the selectable fields: a synthetic `sys.status` plus the type's own fields. */
function fieldOptions(type: ContentType): FieldOption[] {
  return [
    STATUS_OPTION,
    ...type.fields.map((f) => ({
      field: f.apiId,
      label: f.name,
      category: categoryOf(f.type),
    })),
  ];
}

/** A row's value editor — adapts to the field/op (status menu, boolean, list, …). */
function ValueInput(props: {
  option: FieldOption;
  filter: EntryFilter;
  onChange: (value: EntryFilter['value']) => void;
}) {
  const { option, filter, onChange } = props;
  if (filter.op === 'exists') {
    return (
      <Select value={String(filter.value ?? 'true')} onValueChange={(v) => onChange(v === 'true')}>
        <SelectTrigger aria-label="Filter value" className="h-8 w-[120px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">present</SelectItem>
          <SelectItem value="false">absent</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  if (option.field === 'sys.status') {
    if (filter.op === 'in') {
      return (
        <Input
          className="h-8 w-[200px]"
          placeholder="draft, published"
          value={Array.isArray(filter.value) ? filter.value.join(', ') : String(filter.value ?? '')}
          onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()))}
        />
      );
    }
    return (
      <Select value={String(filter.value ?? 'draft')} onValueChange={onChange}>
        <SelectTrigger aria-label="Filter value" className="h-8 w-[140px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ENTRY_STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {statusLabel(s)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (option.category === 'boolean') {
    return (
      <Select value={String(filter.value ?? 'true')} onValueChange={(v) => onChange(v === 'true')}>
        <SelectTrigger aria-label="Filter value" className="h-8 w-[120px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">true</SelectItem>
          <SelectItem value="false">false</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  const isList = filter.op === 'in' || filter.op === 'nin';
  return (
    <Input
      className="h-8 w-[200px]"
      type={option.category === 'date' && !isList ? 'date' : 'text'}
      placeholder={isList ? 'a, b, c' : 'value'}
      value={Array.isArray(filter.value) ? filter.value.join(', ') : String(filter.value ?? '')}
      onChange={(e) =>
        onChange(isList ? e.target.value.split(',').map((s) => s.trim()) : e.target.value)
      }
    />
  );
}

/** How long the search box waits after a keystroke before the list's URL takes the text. */
const SEARCH_WRITE_MS = 150;

/**
 * The search box. The list's state is its URL, which a navigation updates a moment after the
 * keystroke: bound straight to it, fast typing loses characters. So the box holds its own text and
 * writes it on a pause, and follows the URL when something else changes it (a view, Clear, Back).
 */
function SearchField(props: { value: string; onChange(text: string): void }) {
  const [text, setText] = useState(props.value);
  const written = useRef(props.value);
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;
  useEffect(() => {
    if (props.value === written.current) return;
    written.current = props.value;
    setText(props.value);
  }, [props.value]);
  useEffect(() => {
    if (text === written.current) return;
    const timer = setTimeout(() => {
      written.current = text;
      onChange.current(text);
    }, SEARCH_WRITE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <ListSearch
      label="Search entries"
      className="max-w-none"
      placeholder="Search text fields…"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onClear={() => setText('')}
    />
  );
}

/**
 * Filter and search toolbar for the entries list (the table sorts from its own headers). Holds
 * no query state of its own beyond panel visibility — the parent owns the `EntryListQuery` so it
 * can drive the fetch and reflect the active-filter count.
 */
export function EntryFilterBar(props: {
  type: ContentType;
  value: EntryListQuery;
  onChange: (query: EntryListQuery) => void;
  /** Before the search (the views menu). */
  leading?: ReactNode;
  /** After Filters and Clear (the column picker). */
  trailing?: ReactNode;
}) {
  const { type, value, onChange } = props;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const options = fieldOptions(type);
  const filters = value.filters ?? [];

  const optionFor = (field: string) => options.find((o) => o.field === field) ?? STATUS_OPTION;

  const patchFilter = (i: number, patch: Partial<EntryFilter>) =>
    onChange({ ...value, filters: filters.map((f, j) => (j === i ? { ...f, ...patch } : f)) });

  const addFilter = () => {
    const first = options[0];
    if (!first) return;
    onChange({
      ...value,
      filters: [...filters, { field: first.field, op: 'eq', value: '' }],
    });
    setOpen(true);
  };

  const removeFilter = (i: number) =>
    onChange({ ...value, filters: filters.filter((_, j) => j !== i) });

  // A `where` tree (from a saved view or a link) counts as one: the bar doesn't edit its groups.
  const grouped = value.where !== undefined;
  // So does a `links_to_entry`, from a link or a view: the bar has no row for "any field".
  const linked = (value.linksToEntry?.length ?? 0) > 0;
  const activeCount =
    filters.length + (value.search ? 1 : 0) + (grouped ? 1 : 0) + (linked ? 1 : 0);
  // "Mine" is a toggle of its own, beside the panel's filters; Clear clears it with them.
  const clearable = activeCount > 0 || value.mine === true;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {props.leading}
        {/* On a phone the buttons share a row and the search has its own, wide enough to use. */}
        <div className="flex-1 max-sm:order-first max-sm:basis-full sm:max-w-xs">
          <SearchField
            value={value.search ?? ''}
            onChange={(text) => onChange({ ...value, search: text || undefined })}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((o) => !o)}
        >
          <ListFilter aria-hidden="true" className="size-4" />
          Filters
          {activeCount > 0 && (
            <Badge variant="secondary" className="ml-1">
              {activeCount}
            </Badge>
          )}
        </Button>
        <Button
          type="button"
          // Pressed reads as the ink fill, so on and off differ by more than a tint.
          variant={value.mine ? 'default' : 'outline'}
          size="sm"
          aria-pressed={value.mine === true}
          onClick={() => onChange({ ...value, mine: value.mine ? undefined : true })}
        >
          <UserRound aria-hidden="true" className="size-4" />
          Mine
        </Button>
        {clearable && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            // Filters and search only: the sort and the trash view aren't filters.
            onClick={() =>
              onChange({
                ...value,
                filters: undefined,
                search: undefined,
                where: undefined,
                mine: undefined,
                linksToEntry: undefined,
              })
            }
            className="text-muted-foreground"
          >
            <X aria-hidden="true" className="size-4" />
            Clear
          </Button>
        )}
        {/* Off a phone only: its rows show no field columns, and the buttons keep to one row. */}
        {props.trailing && <div className="ml-auto max-md:hidden">{props.trailing}</div>}
      </div>

      {open && (
        <div id={panelId} className="card space-y-3 p-3">
          {filters.length === 0 && !grouped && !linked && (
            <p className="text-muted-foreground text-sm">No filters. Add one to narrow the list.</p>
          )}
          {grouped && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">
                Also grouped conditions (and, or) from the saved view or link, kept as they are.
              </span>
              <Button
                type="button"
                variant="link"
                size="xs"
                className="px-0"
                onClick={() => onChange({ ...value, where: undefined })}
              >
                Remove them
              </Button>
            </div>
          )}
          {linked && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">
                Also only entries linking to the entry the saved view or link names.
              </span>
              <Button
                type="button"
                variant="link"
                size="xs"
                className="px-0"
                aria-label="Remove the link condition"
                onClick={() => onChange({ ...value, linksToEntry: undefined })}
              >
                Remove it
              </Button>
            </div>
          )}
          {filters.map((filter, i) => {
            const option = optionFor(filter.field);
            const ops = OPS_BY_CATEGORY[option.category];
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: filters are positional rows
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Select
                  value={filter.field}
                  onValueChange={(field) => {
                    const ok = OPS_BY_CATEGORY[optionFor(field).category];
                    patchFilter(i, {
                      field,
                      op: ok.some((o) => o.value === filter.op)
                        ? filter.op
                        : (ok[0]?.value ?? 'eq'),
                      value: '',
                    });
                  }}
                >
                  <SelectTrigger aria-label="Filter field" className="h-8 w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((o) => (
                      <SelectItem key={o.field} value={o.field}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={filter.op}
                  onValueChange={(op) => patchFilter(i, { op: op as FilterOp })}
                >
                  <SelectTrigger aria-label="Filter operator" className="h-8 w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ops.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ValueInput
                  option={option}
                  filter={filter}
                  onChange={(v) => patchFilter(i, { value: v })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label="Remove filter"
                  onClick={() => removeFilter(i)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            );
          })}

          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Button type="button" variant="outline" size="sm" onClick={addFilter}>
              <Plus aria-hidden="true" />
              Add filter
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
