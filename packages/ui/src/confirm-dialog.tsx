import * as React from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './alert-dialog';
import { Button } from './button';
import { Input } from './input';
import { Label } from './label';

export interface ConfirmDialogProps {
  title: string;
  description?: string;
  trigger?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  variant?: 'default' | 'destructive';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * The third friction tier from DESIGN.md: an action that touches a live
   * tenant is held until the operator types the object's name. Pass the exact
   * string they must reproduce — a tenant slug, a domain — and confirmation
   * stays disabled until it matches.
   *
   * Reserve it for that tier. On a scoped delete it is ceremony, and ceremony
   * everywhere trains people to type past it.
   */
  requireTypedConfirmation?: string;
  /** Names what they are typing, e.g. "tenant slug". Defaults to "name". */
  typedConfirmationLabel?: string;
}

export function ConfirmDialog({
  title,
  description,
  trigger,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  variant = 'default',
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  requireTypedConfirmation,
  typedConfirmationLabel = 'name',
}: ConfirmDialogProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const typedFieldId = React.useId();
  const pendingRef = React.useRef(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpenState = isControlled ? (controlledOnOpenChange ?? (() => {})) : setInternalOpen;

  // Reopening must not inherit a half-typed value from the last attempt.
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!next) setTyped('');
      setOpenState(next);
    },
    [setOpenState],
  );

  const typedMatches =
    requireTypedConfirmation === undefined || typed.trim() === requireTypedConfirmation;

  async function handleConfirm() {
    if (pendingRef.current || !typedMatches) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  const isDestructive = variant === 'destructive';

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {trigger ? <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger> : null}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {requireTypedConfirmation !== undefined ? (
          <div className="space-y-2">
            {/* One label carries the noun and the value: an aria-label here would
                override the visible text and break "label in name". */}
            <Label htmlFor={typedFieldId}>
              Type the {typedConfirmationLabel}{' '}
              <span className="font-mono font-medium">{requireTypedConfirmation}</span> to confirm
            </Label>
            <Input
              id={typedFieldId}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
            />
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <Button
            variant={isDestructive ? 'destructive' : 'default'}
            disabled={pending || !typedMatches}
            onClick={() => void handleConfirm()}
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
