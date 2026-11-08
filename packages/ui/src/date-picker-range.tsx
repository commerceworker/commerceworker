import { format } from 'date-fns';
import { CalendarIcon } from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import { Button } from './button';
import { Calendar } from './calendar';
import { cn } from './lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

export type DatePickerRangeProps = {
  value: DateRange | undefined;
  onChange: (range: DateRange | undefined) => void;
  placeholder?: string;
  className?: string;
  /** @default 2 */
  numberOfMonths?: number;
  triggerClassName?: string;
};

/**
 * Range date field in a popover with dual-month calendar (shadcn
 * `date-picker-with-range` pattern).
 */
function DatePickerRange({
  value,
  onChange,
  placeholder = 'Pick a date range',
  className,
  numberOfMonths = 2,
  triggerClassName,
}: DatePickerRangeProps) {
  return (
    <div className={cn('grid gap-2', className)}>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              'h-9 w-full justify-start text-left font-normal',
              !value?.from && 'text-muted-foreground',
              triggerClassName,
            )}
          >
            <CalendarIcon className="mr-2 size-4 shrink-0" />
            {value?.from ? (
              value.to ? (
                <>
                  {format(value.from, 'LLL dd, y')} — {format(value.to, 'LLL dd, y')}
                </>
              ) : (
                format(value.from, 'LLL dd, y')
              )
            ) : (
              <span>{placeholder}</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            {...(value?.from !== undefined ? { defaultMonth: value.from } : {})}
            selected={value}
            onSelect={onChange}
            numberOfMonths={numberOfMonths}
            autoFocus
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

export { DatePickerRange };
