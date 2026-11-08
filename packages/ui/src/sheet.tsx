import { XIcon } from 'lucide-react';
import { Dialog as SheetPrimitive } from 'radix-ui';
import type * as React from 'react';

import { Button } from './button';
import { useFocusReturn } from './lib/focus-return';
import { keyboardInset } from './lib/keyboard-inset';
import { keyboardScrollable } from './lib/keyboard-scroll';
import { cn } from './lib/utils';

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ ...props }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-transparent supports-backdrop-filter:backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  );
}

function SheetContent({
  className,
  bodyClassName,
  children,
  side = 'right',
  showCloseButton = true,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  /** For the scrolling body (`className` sizes the sheet). */
  bodyClassName?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  showCloseButton?: boolean;
}) {
  const focusReturn = useFocusReturn(onCloseAutoFocus, keyboardInset);
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        {...focusReturn}
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          'fixed z-50 flex flex-col overflow-hidden bg-popover bg-clip-padding text-sm text-popover-foreground shadow-xl data-[state=closed]:animate-out data-[state=closed]:duration-(--motion-instant) data-[state=closed]:ease-leave data-[state=open]:animate-in data-[state=open]:duration-(--motion-travel) data-[state=open]:ease-arrive',
          // A side drawer runs the full height of the screen, so on a phone it meets
          // the status bar, the notch and the home indicator. The insets are 0
          // everywhere else; the `*-safe` utilities are defined in the app's CSS.
          // Every side ends above an on-screen keyboard, which iOS leaves out of `dvh`.
          side === 'right' &&
            'top-0 right-0 bottom-[var(--keyboard-inset,0px)] w-3/4 border-l pt-safe-0 pr-safe-0 pb-safe-0 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm',
          side === 'left' &&
            'top-0 bottom-[var(--keyboard-inset,0px)] left-0 w-3/4 border-r pt-safe-0 pl-safe-0 pb-safe-0 data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm',
          side === 'top' &&
            'inset-x-0 top-0 h-auto max-h-[calc(100dvh-var(--keyboard-inset,0px))] border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
          side === 'bottom' &&
            'inset-x-0 bottom-[var(--keyboard-inset,0px)] h-auto max-h-[min(85dvh,calc(100dvh-var(--keyboard-inset,0px)-var(--safe-top)-1rem))] border-t px-safe-0 pb-safe-0 data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
          className,
        )}
        {...props}
      >
        {/* As in a Dialog, the body scrolls and the sheet is capped: SheetHeader and SheetFooter stick
            to its edges, and the close button sits outside it, so a long sheet keeps every way out
            and its action in reach. The scroll padding keeps a field tabbed to clear of both. */}
        <div
          ref={keyboardScrollable}
          data-slot="sheet-body"
          className={cn(
            'flex min-h-0 flex-1 scroll-pt-20 scroll-pb-36 flex-col gap-4 overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
            bodyClassName,
          )}
        >
          {children}
        </div>
        {showCloseButton && (
          // The same control as a dialog's. Placed by a wrapper: on touch `hit-area` makes the button
          // itself `relative`. A side drawer meets the status bar, so it clears the top inset too.
          <div className="absolute top-4 right-[max(1rem,var(--safe-right))] z-20 in-data-[side=left]:top-[calc(1rem+var(--safe-top))] in-data-[side=right]:top-[calc(1rem+var(--safe-top))]">
            <SheetPrimitive.Close data-slot="sheet-close" asChild>
              <Button variant="ghost" className="bg-secondary" size="icon-sm">
                <XIcon />
                <span className="sr-only">Close</span>
              </Button>
            </SheetPrimitive.Close>
          </div>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn(
        'sticky top-0 z-10 flex flex-col gap-1.5 bg-popover p-4 pr-14 in-data-cramped:static',
        className,
      )}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        'sticky bottom-0 z-10 mt-auto flex flex-col-reverse gap-2 bg-popover p-4 in-data-cramped:static sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('section-title text-balance', className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
};
