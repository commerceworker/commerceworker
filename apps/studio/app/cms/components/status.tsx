import { Badge } from '@commerceworker/ui/badge';
import { cn } from '@commerceworker/ui/lib/utils';
import { Ban, Undo2, X } from 'lucide-react';
import { statusColor, statusLabel, statusTone, type Tone } from '~/cms/lib/format';

export type { Tone } from '~/cms/lib/format';

// Status badges and dots. Only running work pulses in badges and dots; a
// wait pulsing everywhere for days is noise.
export function StatusDot({ status, className }: { status?: string; className?: string }) {
  const live = statusTone(status) === 'run' && status !== 'scheduled';
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-2 shrink-0 rounded-full transition-[background-color] duration-(--motion-move)',
        live && 'motion-safe:animate-pulse',
        className,
      )}
      style={{ background: statusColor(status) }}
    />
  );
}

function Stamp({
  color,
  label,
  live,
  ended,
}: {
  color: string;
  label: string;
  live?: boolean;
  /**
   * Ended other than completed: ruled in the colour with a mark, so it reads apart from a tinted
   * wait. Failed is an X, rolled back an undo arrow, declined a "no" sign: a decision, not a fault.
   */
  ended?: 'failed' | 'undone' | 'declined';
}) {
  const Mark = ended === 'undone' ? Undo2 : ended === 'declined' ? Ban : X;
  return (
    <Badge
      variant="outline"
      className={cn(
        // A status that changes cross-fades to its new colour rather than snapping.
        'gap-1.5 transition-[color,background-color,border-color] duration-(--motion-move)',
        !ended && 'border-transparent',
      )}
      style={
        ended
          ? { color, borderColor: color, background: 'transparent' }
          : { color, background: `color-mix(in oklch, ${color} 11%, transparent)` }
      }
    >
      {ended ? (
        <Mark aria-hidden="true" className="size-3" strokeWidth={2.5} />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 rounded-full transition-[background-color] duration-(--motion-move)',
            live && 'motion-safe:animate-pulse',
          )}
          style={{ background: color }}
        />
      )}
      {label}
    </Badge>
  );
}

const ENDED: Partial<Record<Tone, 'failed' | 'undone'>> = { bad: 'failed', undo: 'undone' };

/**
 * An entry's, asset's, release's, key's or run's status: a small tinted stamp in its status
 * colour (`lib/format.ts` maps CommerceWorker's statuses onto the tokens); a bad ending is ruled.
 * `label` overrides the words, never the colour.
 */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const tone = statusTone(status);
  return (
    <Stamp
      color={statusColor(status)}
      label={label ?? statusLabel(status)}
      live={tone === 'run' && status !== 'scheduled'}
      ended={ENDED[tone]}
    />
  );
}

/**
 * A status from another vocabulary (a diff's change, a finding's severity, a plugin's state) in
 * the status stamp, by the token it means: a failure and a reversal are ruled.
 */
export function ToneBadge({ tone, label }: { tone: Tone; label: string }) {
  return <Stamp color={`var(--${tone})`} label={label} ended={ENDED[tone]} />;
}
