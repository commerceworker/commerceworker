import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';
import type * as React from 'react';

import { buttonVariants } from './button';
import { DIALOG_SHEET_PLACEMENT } from './dialog';
import { useFocusReturn } from './lib/focus-return';
import { cn } from './lib/utils';

function AlertDialog(props: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger(props: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

/**
 * Where it sits. `center`, at every width: a question, the same wherever it is asked. `sheet`: a
 * review a person reads and then answers, from the bottom on a phone, in thumb reach.
 */
const PLACEMENTS = {
  center:
    'top-1/2 left-1/2 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-4xl data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
  sheet: DIALOG_SHEET_PLACEMENT,
};

function AlertDialogContent({
  className,
  children,
  onCloseAutoFocus,
  placement = 'center',
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & {
  placement?: keyof typeof PLACEMENTS;
}) {
  const focusReturn = useFocusReturn(onCloseAutoFocus);
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay
        data-slot="alert-dialog-overlay"
        className="fixed inset-0 isolate z-50 bg-transparent supports-backdrop-filter:backdrop-blur-sm duration-100 supports-backdrop-filter:backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
      />
      <AlertDialogPrimitive.Content
        {...focusReturn}
        data-slot="alert-dialog-content"
        className={cn(
          'fixed z-50 flex flex-col overflow-hidden bg-popover text-popover-foreground shadow-xl ring-1 ring-foreground/5 outline-none dark:ring-foreground/10 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-(--motion-instant) data-[state=open]:animate-in data-[state=open]:fade-in-0 data-open:duration-(--motion-move)',
          PLACEMENTS[placement],
          className,
        )}
        {...props}
      >
        {/* As in a Dialog: the body scrolls, the header and footer stick to its edges. */}
        <div
          data-slot="alert-dialog-body"
          className="grid min-h-0 flex-1 gap-6 overflow-y-auto overscroll-contain px-6"
        >
          {children}
        </div>
      </AlertDialogPrimitive.Content>
    </AlertDialogPrimitive.Portal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(
        'sticky top-0 z-10 -mx-6 -mb-3 grid gap-1.5 bg-popover px-6 pt-6 pb-3 text-left',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        'sticky bottom-0 z-10 -mx-6 -mt-3 flex flex-col-reverse gap-2 bg-popover px-6 pt-3 pb-safe-6 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn('section-title text-balance', className)}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn('text-balance text-muted-foreground text-sm md:text-pretty', className)}
      {...props}
    />
  );
}

/**
 * The confirming button. `variant` is required, so every confirm chooses: `destructive` for what
 * removes something for good, `default` for the rest.
 */
function AlertDialogAction({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action> & {
  variant: 'default' | 'destructive';
}) {
  return (
    <AlertDialogPrimitive.Action
      data-slot="alert-dialog-action"
      className={cn(buttonVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertDialogCancel({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return (
    <AlertDialogPrimitive.Cancel
      data-slot="alert-dialog-cancel"
      className={cn(buttonVariants({ variant: 'outline' }), className)}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
};
