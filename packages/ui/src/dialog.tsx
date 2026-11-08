'use client';

import { XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import * as React from 'react';
import { Button } from './button';
import { useFocusReturn } from './lib/focus-return';
import { keyboardInset } from './lib/keyboard-inset';
import { cn } from './lib/utils';

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 isolate z-50 bg-transparent supports-backdrop-filter:backdrop-blur-sm duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Where the dialog sits. `sheet`: from the bottom on a phone, in thumb reach, and centred from `sm`;
 * for anything with a form in it. `top`: anchored under the header at every width, so what is
 * typed stays put while the results under it change.
 */
const PLACEMENTS = {
  sheet:
    'inset-x-0 bottom-[var(--keyboard-inset,0px)] max-h-[calc(100dvh-var(--keyboard-inset,0px)-var(--safe-top)-1rem)] rounded-t-4xl max-sm:data-open:slide-in-from-bottom max-sm:data-closed:slide-out-to-bottom max-sm:data-open:duration-(--motion-travel) max-sm:data-open:ease-arrive sm:inset-x-auto sm:top-[calc(50%-var(--keyboard-inset,0px)/2)] sm:bottom-auto sm:left-1/2 sm:max-h-[calc(100dvh-var(--keyboard-inset,0px)-2rem)] sm:w-[calc(100%-2rem)] sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-4xl sm:data-open:zoom-in-95 sm:data-closed:zoom-out-95',
  top: 'top-[calc(var(--safe-top)+4rem)] left-1/2 max-h-[calc(100dvh-var(--keyboard-inset,0px)-var(--safe-top)-5rem)] w-[calc(100%-2rem)] -translate-x-1/2 rounded-4xl data-open:zoom-in-95 data-closed:zoom-out-95 sm:max-w-md',
};

/** For an alert dialog that reviews rather than asks: `sheet`, with the same phone behaviour. */
const DIALOG_SHEET_PLACEMENT = PLACEMENTS.sheet;

function DialogContent({
  className,
  bodyClassName,
  children,
  placement = 'sheet',
  showCloseButton = true,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  /** For the scrolling body, which holds the padding (`className` sizes the dialog). */
  bodyClassName?: string;
  placement?: keyof typeof PLACEMENTS;
  showCloseButton?: boolean;
}) {
  const focusReturn = useFocusReturn(onCloseAutoFocus, keyboardInset);
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        {...focusReturn}
        data-slot="dialog-content"
        className={cn(
          'fixed z-50 flex flex-col overflow-hidden bg-popover text-sm text-popover-foreground shadow-xl ring-1 ring-foreground/5 outline-none data-open:animate-in data-open:fade-in-0 data-open:duration-(--motion-move) data-closed:animate-out data-closed:fade-out-0 data-closed:duration-(--motion-instant) dark:ring-foreground/10',
          PLACEMENTS[placement],
          className,
        )}
        {...props}
      >
        {/* The body scrolls and the dialog is capped, so at keyboard height it is the content that
            gives way: DialogHeader and DialogFooter stick to its edges, wherever the footer sits
            (usually at the end of a form), and each brings the padding of its own edge. The
            scroll padding keeps a field tabbed to, or an error, clear of both. */}
        <div
          data-slot="dialog-body"
          className={cn(
            'grid min-h-0 flex-1 scroll-pt-28 scroll-pb-36 gap-6 overflow-y-auto overscroll-contain px-6 pt-6 pb-safe-6 has-[[data-slot=dialog-footer]]:pb-0 has-[>[data-slot=dialog-header]]:pt-0',
            bodyClassName,
          )}
        >
          {children}
        </div>
        {showCloseButton && (
          // Placed by a wrapper: on touch `hit-area` makes the button itself `relative`.
          <div className="absolute top-4 right-4 z-20">
            <DialogPrimitive.Close data-slot="dialog-close" asChild>
              <Button variant="ghost" className="bg-secondary" size="icon-sm">
                <XIcon />
                <span className="sr-only">Close</span>
              </Button>
            </DialogPrimitive.Close>
          </div>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        'sticky top-0 z-10 -mx-6 -mb-3 flex flex-col gap-1.5 bg-popover px-6 pt-6 pb-3 in-data-cramped:static',
        className,
      )}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'sticky bottom-0 z-10 -mx-6 -mt-3 flex flex-col-reverse gap-2 bg-popover px-6 pt-3 pb-safe-6 in-data-cramped:static sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('pr-8 section-title text-balance', className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        'text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

/**
 * What stopped a form, the one way a dialog or sheet says so: heard at once, in the action's red
 * (`bad` is a status), above the form's buttons. The footer is pinned, so a form can be submitted
 * from anywhere in its scroll: this brings itself into view.
 */
function DialogError({
  title,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  /** A heading, when `children` is a list of what went wrong. */
  title?: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  return (
    <div
      ref={ref}
      role="alert"
      data-slot="dialog-error"
      className={cn('text-destructive text-sm', className)}
      {...props}
    >
      {title ? <p className="font-medium">{title}</p> : null}
      {children}
    </div>
  );
}

export {
  DIALOG_SHEET_PLACEMENT,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogError,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
