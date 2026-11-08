import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from './lib/utils';

type BarState = 'idle' | 'loading' | 'completing';

export interface NavigationProgressProps {
  /** Set `true` while a route transition or async navigation is in progress (e.g. TanStack Router `useRouterState`). */
  loading: boolean;
  className?: string;
}

/** Top indeterminate progress bar; parent controls `loading` from router state. */
export function NavigationProgress({ loading, className }: NavigationProgressProps) {
  const { t } = useTranslation('ui');
  const [state, setState] = React.useState<BarState>('idle');
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const delayRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const completeRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  React.useEffect(() => {
    if (loading) {
      clearTimeout(completeRef.current);
      delayRef.current = setTimeout(() => {
        setState('loading');
      }, 150);
    } else {
      clearTimeout(delayRef.current);
      if (stateRef.current === 'loading') {
        setState('completing');
        completeRef.current = setTimeout(() => {
          setState('idle');
        }, 500);
      }
    }
    return () => {
      clearTimeout(delayRef.current);
    };
  }, [loading]);

  /*
   * Driven by `transform: scaleX()` rather than `width`. The bar spans the viewport and is
   * scaled from its left edge, so the animation stays on the compositor instead of forcing
   * layout on every frame of an 8s run — this element sits above the whole app, so a layout
   * pass here is a layout pass for the page.
   */
  const barStyles: React.CSSProperties =
    state === 'loading'
      ? {
          transform: 'scaleX(0.9)',
          opacity: 1,
          transition: 'transform 8s cubic-bezier(0.1, 0.05, 0, 1), opacity 0s',
        }
      : state === 'completing'
        ? {
            transform: 'scaleX(1)',
            opacity: 0,
            transition: 'transform 200ms ease-out, opacity 300ms ease-in 200ms',
          }
        : { transform: 'scaleX(0)', opacity: 0, transition: 'none' };

  return (
    <div
      role="progressbar"
      aria-label={t('spinnerLoading')}
      aria-hidden={state === 'idle'}
      className={cn(
        'pointer-events-none fixed top-0 left-0 z-[9999] h-0.5 w-full origin-left overflow-hidden bg-primary',
        className,
      )}
      style={barStyles}
    />
  );
}
