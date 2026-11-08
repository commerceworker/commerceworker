import { addDays, format } from 'date-fns';
import { CalendarIcon } from 'lucide-react';
import { Button } from './button';
import { Calendar } from './calendar';
import { cn } from './lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

export type DatePickerPreset = {
  /** Stable id for the option (e.g. days offset as string). */
  value: string;
  label: string;
  /** Days from start of today (local) to set when chosen. */
  daysFromToday: number;
};

const DEFAULT_PRESETS: DatePickerPreset[] = [
  { value: '0', label: 'Today', daysFromToday: 0 },
  { value: '1', label: 'Tomorrow', daysFromToday: 1 },
  { value: '3', label: 'In 3 days', daysFromToday: 3 },
  { value: '7', label: 'In a week', daysFromToday: 7 },
];

export type DatePickerPresetsProps = {
  value: Date | undefined;
  onChange: (date: Date | undefined) => void;
  placeholder?: string;
  className?: string;
  triggerClassName?: string;
  presets?: DatePickerPreset[];
  selectPlaceholder?: string;
};

/**
 * Single date with quick presets + calendar (shadcn `date-picker-with-presets` pattern).
 */
function DatePickerPresets({
  value,
  onChange,
  placeholder = 'Pick a date',
  className,
  triggerClassName,
  presets = DEFAULT_PRESETS,
  selectPlaceholder = 'Quick select',
}: DatePickerPresetsProps) {
  return (
    <div className={cn(className)}>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              'h-9 w-full justify-start text-left font-normal',
              !value && 'text-muted-foreground',
              triggerClassName,
            )}
          >
            <CalendarIcon className="mr-2 size-4 shrink-0" />
            {value ? format(value, 'PPP') : <span>{placeholder}</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="flex w-auto flex-col space-y-2 p-2">
          <Select
            onValueChange={(v: string) => {
              const preset = presets.find((p) => p.value === v);
              if (preset) {
                const base = new Date();
                base.setHours(0, 0, 0, 0);
                onChange(addDays(base, preset.daysFromToday));
              }
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={selectPlaceholder} />
            </SelectTrigger>
            <SelectContent position="popper">
              {presets.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="rounded-md border border-border">
            <Calendar mode="single" selected={value} onSelect={onChange} autoFocus />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export { DatePickerPresets, DEFAULT_PRESETS };
