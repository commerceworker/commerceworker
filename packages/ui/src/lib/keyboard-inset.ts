/** What the on-screen keyboard rises for. */
const FIELD = 'input, textarea, select, [contenteditable="true"]';

/** The overlay's scrolling body, where it has one. */
const BODY = '[data-slot="dialog-body"], [data-slot="sheet-body"]';

const pinned = (body: Element, slot: string) =>
  body.querySelector(`[data-slot="dialog-${slot}"], [data-slot="sheet-${slot}"]`);

/**
 * Brings the focused field out from behind the overlay's pinned header and footer. A browser only
 * scrolls a field into its scroller's box, which the footer stands in, and iOS does nothing at all
 * when the keyboard shrinks that box around a field that was in view.
 */
function keepFieldClear(overlay: HTMLElement) {
  const field = document.activeElement;
  if (!field?.matches(FIELD) || !overlay.contains(field)) return;
  const body = field.closest<HTMLElement>(BODY);
  if (!body || !overlay.contains(body)) return;
  const box = body.getBoundingClientRect();
  const cramped = overlay.hasAttribute('data-cramped');
  const header = cramped ? undefined : pinned(body, 'header')?.getBoundingClientRect();
  const footer = cramped ? undefined : pinned(body, 'footer')?.getBoundingClientRect();
  const top = (header?.bottom ?? box.top) + GAP;
  const bottom = Math.min(footer?.top ?? box.bottom, box.bottom) - GAP;
  const at = field.getBoundingClientRect();
  if (at.bottom > bottom) body.scrollTop += Math.min(at.bottom - bottom, at.top - top);
  else if (at.top < top) body.scrollTop -= top - at.top;
}

/**
 * Lets the header and footer scroll with the rest when pinning them would leave no room between
 * them: a phone on its side with the keyboard up, a multi-line description, a stacked footer. Then
 * `data-cramped` is on the overlay, and they use `in-data-cramped:static`.
 */
function letGoWhenCramped(overlay: HTMLElement) {
  const body = overlay.querySelector(BODY);
  if (!body) return;
  const held = [pinned(body, 'header'), pinned(body, 'footer')].reduce(
    (sum, el) => sum + (el?.getBoundingClientRect().height ?? 0),
    0,
  );
  overlay.toggleAttribute('data-cramped', held > 0 && body.clientHeight - held < MIN_ROOM);
}

/** Room left between a field and the edge it clears. */
const GAP = 8;
/** The least a body can show between what is pinned: a field and its label. */
const MIN_ROOM = 96;

/**
 * A ref for an overlay that holds a field: keeps `--keyboard-inset` on it, the height the on-screen
 * keyboard covers, and the focused field clear of what is pinned. iOS resizes neither the layout
 * viewport nor `dvh` for its keyboard, so an overlay capped by `dvh` alone would leave its footer
 * under the keyboard. 0 everywhere else, and while pinch-zoomed, when the visual viewport is small
 * for another reason.
 */
export function keyboardInset(el: HTMLElement | null) {
  const viewport = window.visualViewport;
  if (!el || !viewport) return;
  let keyboard = -1;
  const update = () => {
    const shrunk = window.innerHeight - viewport.height;
    const covered = shrunk - viewport.offsetTop;
    el.style.setProperty('--keyboard-inset', `${viewport.scale > 1 ? 0 : Math.max(0, covered)}px`);
    letGoWhenCramped(el);
    // Only as the keyboard moves: panning changes `offsetTop` and pinching the height, and neither
    // may pull the body back to the field.
    if (viewport.scale > 1 || shrunk === keyboard) return;
    keyboard = shrunk;
    keepFieldClear(el);
  };
  const focused = () => {
    letGoWhenCramped(el);
    keepFieldClear(el);
  };
  // The overlay resizes for more than the viewport: what fills it can arrive later.
  const resized = new ResizeObserver(() => letGoWhenCramped(el));
  resized.observe(el);
  update();
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  el.addEventListener('focusin', focused);
  return () => {
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
    el.removeEventListener('focusin', focused);
    resized.disconnect();
  };
}
