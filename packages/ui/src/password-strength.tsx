import { cn } from './lib/utils';

export interface PasswordStrengthLabels {
  weak: string;
  fair: string;
  good: string;
  strong: string;
}

export interface PasswordStrengthProps {
  password: string;
  /** Translated labels. Defaults are English; pass `t()` output in a localized app. */
  labels?: PasswordStrengthLabels;
  className?: string;
}

const DEFAULT_LABELS: PasswordStrengthLabels = {
  weak: 'Weak',
  fair: 'Fair',
  good: 'Good',
  strong: 'Strong',
};

/** Mirrors the signup/reset policy: 12+ characters with lower, upper, and a digit. */
function getScore(password: string): number {
  let score = 0;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password)) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  return score;
}

/**
 * Password strength meter.
 *
 * The filled segments carry semantic state colours, not the primary fill: `primary`
 * is Panel Ink, so the previous mapping painted "strong" near-black — the same value
 * as a resting button, which reads as neutral rather than as a positive state. The
 * numeric score is always accompanied by its label, so strength is never encoded by
 * colour alone.
 */
export function PasswordStrength({ password, labels, className }: PasswordStrengthProps) {
  const l = labels ?? DEFAULT_LABELS;
  const score = password ? getScore(password) : 0;

  // The live region is mounted from the start, empty, rather than appearing with
  // its first content. A `role="status"` node that enters the DOM in the same tick
  // as its text is commonly not announced at all — the region has to exist for the
  // update to be an update. It also reserves its own line box, so the field below
  // does not move on the first keystroke.
  const label = password
    ? score <= 1
      ? l.weak
      : score === 2
        ? l.fair
        : score === 3
          ? l.good
          : l.strong
    : '';
  const fill =
    score <= 1 ? 'bg-destructive' : score === 2 ? 'bg-warning-foreground' : 'bg-success-foreground';

  return (
    <div className={cn('grid gap-1.5', className)}>
      {/* Conditionally rendered rather than `hidden`: Tailwind's `.flex` is an author
          rule and outranks the user-agent `[hidden] { display: none }`, so the
          attribute alone would not hide it. */}
      {password ? (
        <div className="flex gap-1" aria-hidden>
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className={cn(
                'h-1 flex-1 rounded-full transition-colors duration-150',
                i <= score ? fill : 'bg-muted',
              )}
            />
          ))}
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground" role="status">
        {label}
      </p>
    </div>
  );
}
