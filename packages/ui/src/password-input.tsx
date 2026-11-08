import { Eye, EyeOff } from 'lucide-react';
import * as React from 'react';
import { Input } from './input';
import { cn } from './lib/utils';

export interface PasswordInputProps extends Omit<React.ComponentProps<typeof Input>, 'type'> {
  /** Accessible name for the reveal control when hidden. Pass a translated string. */
  showLabel?: string;
  /** Accessible name for the reveal control when revealed. Pass a translated string. */
  hideLabel?: string;
  /**
   * Warning shown while Caps Lock is on. Pass a translated string; omit to
   * disable the warning.
   */
  capsLockWarning?: string;
}

/**
 * Password field with a reveal toggle.
 *
 * The toggle is a real control: it is in the tab order, it is 32px square, and it
 * reports its pressed state. It was previously `tabIndex={-1}` at 16px, which put
 * it out of reach of keyboard users entirely (SC 2.1.1) and under the 24px target
 * minimum (SC 2.5.8) — on the one control a keyboard user most needs when typing a
 * 12-character password they cannot see.
 *
 * Caps Lock is reported rather than left to be discovered by a failed sign-in.
 * `getModifierState` is read from real key events, so nothing is inferred.
 */
export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput(
    {
      className,
      showLabel = 'Show password',
      hideLabel = 'Hide password',
      capsLockWarning,
      onKeyDown,
      onKeyUp,
      onBlur,
      ...props
    },
    ref,
  ) {
    const [visible, setVisible] = React.useState(false);
    const [capsLock, setCapsLock] = React.useState(false);

    const readCapsLock = React.useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (!capsLockWarning) return;
        setCapsLock(e.getModifierState('CapsLock'));
      },
      [capsLockWarning],
    );

    return (
      <div className="relative">
        <Input
          ref={ref}
          {...props}
          type={visible ? 'text' : 'password'}
          className={cn('pr-11', className)}
          onKeyDown={(e) => {
            readCapsLock(e);
            onKeyDown?.(e);
          }}
          onKeyUp={(e) => {
            readCapsLock(e);
            onKeyUp?.(e);
          }}
          onBlur={(e) => {
            setCapsLock(false);
            onBlur?.(e);
          }}
        />
        <button
          type="button"
          className="absolute top-1/2 right-1 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-label={visible ? hideLabel : showLabel}
        >
          {visible ? (
            <EyeOff className="size-4" aria-hidden />
          ) : (
            <Eye className="size-4" aria-hidden />
          )}
        </button>
        {capsLockWarning && capsLock ? (
          <p className="mt-1.5 text-xs text-warning-foreground" role="status">
            {capsLockWarning}
          </p>
        ) : null}
      </div>
    );
  },
);
