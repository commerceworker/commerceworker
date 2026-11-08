import { FOCUSABLE } from './focus-return';

/**
 * A ref for an overlay's scrolling body. The keyboard scrolls what holds focus, and the close button
 * sits outside the body, so a body that overflows with nothing to tab to in it (a sheet of plain
 * text) couldn't be read past its first screen. While that is so the body takes focus itself, a
 * region named as the overlay is; anything to tab to inside it does that job instead.
 */
export function keyboardScrollable(body: HTMLElement | null) {
  if (!body) return;
  const resize = new ResizeObserver(() => sync());
  const sync = () => {
    const needed = body.scrollHeight > body.clientHeight && !body.querySelector(FOCUSABLE);
    if (needed && !body.hasAttribute('tabindex')) {
      body.tabIndex = 0;
      body.setAttribute('role', 'region');
      const title = body.querySelector('[data-slot="sheet-title"]');
      if (title?.id) body.setAttribute('aria-labelledby', title.id);
    } else if (!needed && document.activeElement !== body) {
      body.removeAttribute('tabindex');
      body.removeAttribute('role');
      body.removeAttribute('aria-labelledby');
    }
    // What is inside can grow without the body changing size: its height is capped.
    for (const child of body.children) resize.observe(child);
  };
  const mutate = new MutationObserver(sync);
  mutate.observe(body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'hidden', 'href'],
  });
  resize.observe(body);
  sync();
  return () => {
    resize.disconnect();
    mutate.disconnect();
  };
}
