import { cn } from '@commerceworker/ui/lib/utils';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

type ToastKind = 'success' | 'error';

/**
 * One follow-up the toast offers, e.g. `{ label: 'Undo', onAction: restore }`.
 * Clicking it dismisses the toast first, so the action runs exactly once.
 * Only offer an action that calls a real inverse; never fake an undo.
 */
export interface ToastAction {
  readonly label: string;
  readonly onAction: () => void;
}

export interface ToastOptions {
  readonly action?: ToastAction;
}

interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
  readonly action?: ToastAction;
}

export interface ToastApi {
  success(message: string, options?: ToastOptions): void;
  error(message: string, options?: ToastOptions): void;
}

const ToastCtx = createContext<ToastApi | null>(null);

// A toast with an action stays long enough to reach it (and, like every
// toast, pauses while hovered or focused).
const durationOf = (t: Pick<Toast, 'kind' | 'action'>) =>
  t.action ? 10000 : t.kind === 'error' ? 6000 : 3500;

/** Transient notifications. Errors stay longer than successes; both auto-dismiss. */
export function useToast(): ToastApi {
  const api = useContext(ToastCtx);
  if (!api) throw new Error('useToast must be used within <ToastProvider>');
  return api;
}

export function ToastProvider(props: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  // Per-toast dismiss timers, so hovering (or focusing the dismiss button)
  // pauses auto-dismiss and a missed error can actually be read.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pause = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const resume = useCallback(
    (t: Toast) => {
      if (timers.current.has(t.id)) return;
      timers.current.set(
        t.id,
        setTimeout(() => dismiss(t.id), durationOf(t)),
      );
    },
    [dismiss],
  );

  const push = useCallback(
    (kind: ToastKind, message: string, options?: ToastOptions) => {
      seq.current += 1;
      const toast: Toast = { id: seq.current, kind, message, action: options?.action };
      setToasts((prev) => [...prev, toast]);
      timers.current.set(
        toast.id,
        setTimeout(() => dismiss(toast.id), durationOf(toast)),
      );
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (m, o) => push('success', m, o),
      error: (m, o) => push('error', m, o),
    }),
    [push],
  );

  return (
    <ToastCtx.Provider value={api}>
      {props.children}
      {/* With the assistant's column open (`--assistant-w`, set by its panel), toasts stay inside
          the column, above its composer, rather than over the page's row actions beside it. */}
      <div
        className="fixed right-[max(1rem,var(--safe-right))] bottom-[calc(var(--tabbar-h)+1rem+var(--assistant-lift,0px)+var(--page-bar-h,0px))] left-[max(1rem,var(--safe-left))] z-50 flex flex-col items-end gap-2 sm:left-auto sm:max-w-[calc(var(--assistant-w,100vw)-2rem)]"
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map((t) => (
          <output
            key={t.id}
            onMouseEnter={() => pause(t.id)}
            onMouseLeave={() => resume(t)}
            onFocus={() => pause(t.id)}
            onBlur={() => resume(t)}
            className={cn(
              // A card over the page, arriving with the shared rise; its kind is a status dot
              // beside the words (never colour alone, never a side stripe).
              'card flex w-full min-w-60 max-w-md animate-arrive items-center gap-3 px-3 py-2.5 text-sm shadow-float sm:w-auto',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'size-2 shrink-0 rounded-full',
                t.kind === 'success' ? 'bg-ok' : 'bg-bad',
              )}
            />
            <span className="min-w-0 flex-1 break-words">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="hit-area h-7 shrink-0 rounded-4xl px-2.5 font-medium text-foreground outline-none transition-[background-color] hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  const action = t.action;
                  dismiss(t.id);
                  action?.onAction();
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              className="hit-area flex size-6 items-center justify-center rounded-full text-lg leading-none text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </output>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
