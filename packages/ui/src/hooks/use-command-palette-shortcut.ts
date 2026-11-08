import * as React from 'react';

/**
 * Meta+K (macOS) or Ctrl+K. Ignores when focus is in inputs, textareas, or contenteditable.
 */
export function useCommandPaletteShortcut(onOpen: () => void, enabled = true): void {
  const onOpenRef = React.useRef(onOpen);
  onOpenRef.current = onOpen;

  React.useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'k' && e.key !== 'K') return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      onOpenRef.current();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
