import * as React from 'react';

/**
 * Radix Dialog/Sheet overlay forces inline `pointer-events: auto`. A node can remain mounted with
 * `data-state=closed` during exit (or get stuck), stay at opacity 0, and still block the whole UI.
 */
export function useRadixOverlayRef<E extends HTMLElement>(forwardedRef: React.ForwardedRef<E>) {
  const observerRef = React.useRef<MutationObserver | null>(null);

  return React.useCallback(
    (el: E | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;

      if (typeof forwardedRef === 'function') {
        forwardedRef(el);
      } else if (forwardedRef) {
        (forwardedRef as React.MutableRefObject<E | null>).current = el;
      }

      if (!el) return;

      const sync = () => {
        const closed = el.getAttribute('data-state') === 'closed';
        if (closed) {
          el.style.pointerEvents = 'none';
          requestAnimationFrame(() => {
            if (el.getAttribute('data-state') === 'closed') {
              el.style.pointerEvents = 'none';
            }
          });
        } else {
          el.style.removeProperty('pointer-events');
        }
      };

      sync();
      const mo = new MutationObserver(sync);
      mo.observe(el, { attributes: true, attributeFilter: ['data-state'] });
      observerRef.current = mo;
    },
    [forwardedRef],
  );
}
