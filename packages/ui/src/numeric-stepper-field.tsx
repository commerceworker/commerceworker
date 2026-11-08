import { Minus, Plus } from 'lucide-react';
import * as React from 'react';
import { Button } from './button';
import { ButtonGroup } from './button-group';
import { Field, FieldContent, FieldDescription, FieldLabel } from './field';
import { Input } from './input';
import { cn } from './lib/utils';

function parseIntValue(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number.parseInt(t, 10);
  return Number.isNaN(n) ? null : n;
}

export type NumericStepperFieldProps = {
  id: string;
  /** When `controlOnly`, label is optional (e.g. parent supplies headings). */
  label?: string;
  description?: string;
  /** Integer string; empty means unset (e.g. use plan default). */
  stringValue: string;
  onStringChange: (next: string) => void;
  min?: number;
  max?: number;
  step?: number;
  /** When minus would go below `min`, clear to empty instead of clamping. */
  clearWhenBelowMin?: boolean;
  /** Render only the stepper control (no Field / label shell). */
  controlOnly?: boolean;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  maxInputLength?: number;
  inputPlaceholder?: string;
};

export function NumericStepperField({
  id,
  label,
  description,
  stringValue,
  onStringChange,
  min = 0,
  max = 99_999_999,
  step = 1,
  clearWhenBelowMin = false,
  controlOnly = false,
  disabled = false,
  className,
  inputClassName,
  maxInputLength = 12,
  inputPlaceholder,
}: NumericStepperFieldProps) {
  const parsed = parseIntValue(stringValue);
  const minusDisabled = disabled || parsed === null || (parsed <= min && !clearWhenBelowMin);

  const handlePlus = React.useCallback(() => {
    if (parsed === null) {
      onStringChange(String(min));
      return;
    }
    onStringChange(String(Math.min(max, parsed + step)));
  }, [max, min, onStringChange, parsed, step]);

  const handleMinus = React.useCallback(() => {
    if (parsed === null) return;
    const next = parsed - step;
    if (next < min) {
      if (clearWhenBelowMin) onStringChange('');
      else onStringChange(String(min));
      return;
    }
    onStringChange(String(next));
  }, [clearWhenBelowMin, min, onStringChange, parsed, step]);

  const labelText = label ?? 'Numeric value';
  const control = (
    <ButtonGroup className="shrink-0">
      <Input
        id={id}
        inputMode="numeric"
        disabled={disabled}
        value={stringValue}
        maxLength={maxInputLength}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '').slice(0, maxInputLength);
          onStringChange(digits);
        }}
        className={cn('h-7 w-14 font-mono tabular-nums', inputClassName)}
        {...(inputPlaceholder !== undefined ? { placeholder: inputPlaceholder } : {})}
        aria-label={labelText}
      />
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        disabled={minusDisabled}
        aria-label={`Decrease ${labelText}`}
        onClick={handleMinus}
      >
        <Minus className="size-4" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        disabled={disabled || (parsed !== null && parsed >= max)}
        aria-label={`Increase ${labelText}`}
        onClick={handlePlus}
      >
        <Plus className="size-4" />
      </Button>
    </ButtonGroup>
  );

  if (controlOnly || !label) {
    return <div className={className}>{control}</div>;
  }

  return (
    <Field orientation="horizontal" className={cn('items-start sm:items-center', className)}>
      <FieldContent className="min-w-0 flex-1">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
      </FieldContent>
      {control}
    </Field>
  );
}
