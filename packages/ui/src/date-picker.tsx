import { format } from 'date-fns';
import { CalendarIcon } from 'lucide-react';
import { Button } from './button';
import { Calendar } from './calendar';
import { cn } from './lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

function DatePicker({
  value,
  onChange,
  name,
  placeholder = 'Pick a date',
  className,
}: {
  value?: Date;
  onChange: (date: Date | undefined) => void;
  name?: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn('relative', className)}>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              'h-9 w-full justify-start text-left font-normal',
              !value && 'text-muted-foreground',
            )}
          >
            <CalendarIcon className="mr-2 size-4 shrink-0" />
            {value ? format(value, 'PPP') : <span>{placeholder}</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar mode="single" selected={value} onSelect={onChange} autoFocus />
        </PopoverContent>
      </Popover>
      {name && value ? (
        <input type="hidden" name={name} value={format(value, 'yyyy-MM-dd')} />
      ) : null}
    </div>
  );
}

export { DatePicker };
