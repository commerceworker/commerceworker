import { Button } from '@commerceworker/ui/button';
import { cn } from '@commerceworker/ui/lib/utils';
import type { ReactNode } from 'react';

/**
 * A wrapping row of prompt starters. Adapted from the AI Elements Suggestion
 * pattern; it wraps rather than side-scrolls so every starter stays visible in
 * a narrow dialog. Use inside an AI flow only (e.g. the generate dialog), never
 * as free-standing chrome.
 */
export function Suggestions(props: { label: string; className?: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of buttons, not a form fieldset
    <div
      role="group"
      aria-label={props.label}
      className={cn('flex flex-wrap gap-1.5', props.className)}
    >
      {props.children}
    </div>
  );
}

/** One starter. Clicking hands its text back; it never submits on its own. */
export function Suggestion(props: { suggestion: string; onClick: (suggestion: string) => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className="h-auto min-h-6 whitespace-normal py-1 text-left font-normal"
      onClick={() => props.onClick(props.suggestion)}
    >
      {props.suggestion}
    </Button>
  );
}
