import { useCallback, useRef } from 'react';

/** What a person acts on, and so what can have opened an overlay. Not a container. */
const CONTROL =
  'a[href], button, input, select, textarea, summary, [contenteditable="true"], [role^="menuitem"], [tabindex]:not([tabindex="-1"])';
/** What can take focus by Tab. */
export const FOCUSABLE =
  'a[href], button:enabled, input:enabled:not([type="hidden"]), select:enabled, summary, textarea:enabled, [tabindex]:not([tabindex="-1"])';
const OVERLAY =
  '[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="sheet-content"]';

const controlOf = (node: EventTarget | null) =>
  node instanceof Element ? node.closest<HTMLElement>(CONTROL) : null;

// Safari doesn't focus a pressed button (focus goes to the nearest focusable ancestor, or nowhere),
// and a button disabled by its own press loses focus before anything opens, so `activeElement` alone
// can't say what asked. Listening from the start: the overlay mounts after the press it answers.
let lastControl: HTMLElement | null = null;
if (typeof document !== 'undefined') {
  // A press on nothing moves the person on from the last control. Focus says nothing about a press
  // when it lands on something that isn't a control (a dialog's own container), or on the focusable
  // scroller around what was pressed, which is where Safari puts it.
  document.addEventListener(
    'pointerdown',
    (event) => {
      lastControl = controlOf(event.target);
    },
    true,
  );
  document.addEventListener(
    'focusin',
    (event) => {
      const control = controlOf(event.target);
      if (control && !control.contains(lastControl)) lastControl = control;
    },
    true,
  );
}

/** A menu's item is gone once the menu closes: the keyboard carries on from what opened the menu. */
function outOfMenus(control: HTMLElement) {
  let at = control;
  for (let menu = at.closest('[role="menu"]'); menu; menu = at.closest('[role="menu"]')) {
    const trigger = document.getElementById(menu.getAttribute('aria-labelledby') ?? '');
    if (!trigger) return at;
    at = trigger;
  }
  return at;
}

/**
 * Focus that isn't on anything: `<body>`, a node that has gone, or an overlay's own container, where
 * Safari puts it when a button inside is pressed and Radix when focus would fall out of one.
 */
export function focusIsAdrift(active: Element | null = document.activeElement) {
  return (
    !active ||
    active === document.body ||
    !active.isConnected ||
    active.matches('[role="dialog"], [role="alertdialog"]')
  );
}

interface Opener {
  readonly control: HTMLElement | null;
  /** Its ancestors, nearest first, up to the overlay or page holding it: where to look if it goes. */
  readonly around: readonly HTMLElement[];
  /** Who opened the overlay it sits in: that overlay may close with this one. */
  readonly outer: Opener | undefined;
}

const openers = new WeakMap<Element, Opener>();

function openerNow(): Opener {
  const active = controlOf(document.activeElement);
  const pressed = lastControl?.isConnected ? lastControl : null;
  // A press in a focusable scroller, in Safari, focuses the scroller: what was pressed is inside it.
  const found = active?.contains(pressed) ? pressed : (active ?? pressed);
  const control = found && outOfMenus(found);
  const around: HTMLElement[] = [];
  for (let at = control?.parentElement; at && at.tagName !== 'MAIN'; at = at.parentElement) {
    if (at === document.body) break;
    around.push(at);
    if (at.matches(OVERLAY)) break;
  }
  const holder = control?.closest(OVERLAY);
  return { control, around, outer: holder ? openers.get(holder) : undefined };
}

function land(el: HTMLElement | null | undefined) {
  el?.focus({ preventScroll: true });
  return el != null && document.activeElement === el;
}

/** What opened it; failing that (disabled, or gone), the closest thing left beside it. */
function returnTo(opener: Opener | undefined) {
  for (let at = opener; at; at = at.outer) {
    if (land(at.control)) return;
    for (const near of at.around) {
      if (!near.isConnected) continue;
      for (const el of near.querySelectorAll<HTMLElement>(FOCUSABLE)) if (land(el)) return;
    }
  }
  land(document.querySelector<HTMLElement>('main'));
}

/**
 * Hands focus back when an overlay closes. Radix only returns it to a `*Trigger`, and most of the
 * app's overlays open from state: with no trigger, closing dropped focus to `<body>`. This notes
 * what opened the overlay as it mounts and goes back there as it closes.
 *
 * `onCloseAutoFocus` stays the override: `preventDefault` and move focus yourself. Whatever the
 * closing action already focused on purpose is left alone.
 *
 * @param also a ref the content needs as well; keep it stable.
 */
export function useFocusReturn(
  onCloseAutoFocus: ((event: Event) => void) | undefined,
  also?: (el: HTMLElement | null) => (() => void) | undefined,
) {
  const opener = useRef<Opener>(undefined);
  const ref = useCallback(
    (el: HTMLElement | null) => {
      if (el) {
        opener.current = openerNow();
        openers.set(el, opener.current);
      }
      return also?.(el);
    },
    [also],
  );
  return {
    ref,
    onCloseAutoFocus: (event: Event) => {
      onCloseAutoFocus?.(event);
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (focusIsAdrift()) returnTo(opener.current);
    },
  };
}
