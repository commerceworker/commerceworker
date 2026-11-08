import { cn } from './lib/utils';
import { Spinner } from './spinner';

export interface ProcessingRequestBannerProps {
  /** When false, nothing is rendered. */
  open: boolean;
  /** Accessible status text (default matches common checkout copy). */
  label?: string;
  className?: string;
}

/**
 * Inline “processing your request” strip — pair with mutations or slow routes (payment flows, saves).
 */
export function ProcessingRequestBanner({
  open,
  label = 'Processing your request…',
  className,
}: ProcessingRequestBannerProps) {
  if (!open) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn(
        'flex items-center gap-3 rounded-lg border border-border bg-muted/60 px-4 py-3 text-sm text-foreground',
        className,
      )}
    >
      <Spinner className="size-4 shrink-0" />
      <span>{label}</span>
    </div>
  );
}
