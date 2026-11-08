/**
 * The browser half of inline editing: turns a previewed page into click-to-edit.
 *
 * Framework-free on purpose — it reads `data-cw-ref` out of the DOM, so it works
 * against markup rendered by anything, and the React wrapper in
 * `@commerceworker/sdk-web` is a thin mount/unmount around it.
 */
import { adminEditUrl, type ContentRef, parseContentRef } from './content-ref.js';

export interface InlineEditorOptions {
  /** Admin base URL, e.g. `https://admin.example.com`. Required unless `onEdit` handles the click. */
  readonly adminUrl?: string;
  /**
   * Called instead of navigating. Use it to open the editor in a side panel, or
   * to route within an app that embeds the admin.
   */
  readonly onEdit?: (ref: ContentRef) => void;
  /** Start with editing switched on. Default false. */
  readonly defaultEnabled?: boolean;
  /** Render the built-in toggle. Default true; pass false to drive `setEnabled` from your own UI. */
  readonly toggle?: boolean;
  /** Document to attach to. Defaults to the global one. */
  readonly document?: Document;
}

export interface InlineEditor {
  /** Turns editing on or off. */
  setEnabled(on: boolean): void;
  readonly enabled: boolean;
  /** Removes every listener and node this added. */
  destroy(): void;
}

const STYLE_ID = 'cw-inline-edit-style';

const CSS = `
.cw-ie-outline {
  position: absolute;
  pointer-events: none;
  border: 2px solid #6366f1;
  border-radius: 3px;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0);
  transition: all 80ms ease-out;
  z-index: 2147483646;
}
.cw-ie-label {
  position: absolute;
  top: -1.5em;
  left: -2px;
  padding: 0 6px;
  border-radius: 3px 3px 0 0;
  background: #6366f1;
  color: #fff;
  font: 500 11px/1.5em ui-sans-serif, system-ui, sans-serif;
  white-space: nowrap;
}
.cw-ie-toggle {
  position: fixed;
  right: 16px;
  bottom: 16px;
  padding: 8px 14px;
  border: 0;
  border-radius: 999px;
  background: #1e1b4b;
  color: #fff;
  font: 500 13px ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
  z-index: 2147483647;
}
.cw-ie-toggle[aria-pressed='true'] { background: #6366f1; }
@media (prefers-reduced-motion: reduce) {
  .cw-ie-outline { transition: none; }
}
`;

/**
 * Mounts the overlay. Returns a handle; call `destroy()` to remove it.
 *
 * Editing is off until switched on, because a previewed page is still a page:
 * with every click intercepted, following a link to the next page — the whole
 * point of previewing a site rather than one entry — would be impossible.
 */
export function mountInlineEditor(options: InlineEditorOptions = {}): InlineEditor {
  const doc = options.document ?? globalThis.document;
  if (!doc) {
    throw new Error('mountInlineEditor requires a DOM; call it from the browser.');
  }
  if (!options.adminUrl && !options.onEdit) {
    // Silently doing nothing on click would look like a broken overlay rather
    // than an unconfigured one.
    throw new Error('mountInlineEditor needs an adminUrl or an onEdit handler.');
  }

  let enabled = options.defaultEnabled ?? false;
  let hovered: HTMLElement | undefined;

  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  const outline = doc.createElement('div');
  outline.className = 'cw-ie-outline';
  outline.hidden = true;
  const label = doc.createElement('span');
  label.className = 'cw-ie-label';
  outline.appendChild(label);
  doc.body.appendChild(outline);

  const toggle = doc.createElement('button');
  if (options.toggle !== false) {
    toggle.type = 'button';
    toggle.className = 'cw-ie-toggle';
    toggle.textContent = 'Edit content';
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.addEventListener('click', () => setEnabled(!enabled));
    doc.body.appendChild(toggle);
  }

  const refOf = (target: EventTarget | null): { el: HTMLElement; ref: ContentRef } | undefined => {
    if (!(target instanceof Element)) return undefined;
    const el = target.closest<HTMLElement>('[data-cw-ref]');
    const ref = parseContentRef(el?.dataset.cwRef);
    return el && ref ? { el, ref } : undefined;
  };

  const draw = (el: HTMLElement, ref: ContentRef) => {
    const box = el.getBoundingClientRect();
    // Page coordinates, not viewport: the outline is in the document flow, so it
    // stays put while scrolling instead of sliding off what it marks.
    outline.style.top = `${box.top + doc.defaultView!.scrollY}px`;
    outline.style.left = `${box.left + doc.defaultView!.scrollX}px`;
    outline.style.width = `${box.width}px`;
    outline.style.height = `${box.height}px`;
    label.textContent = ref.field;
    outline.hidden = false;
  };

  const onPointerOver = (e: Event) => {
    if (!enabled) return;
    const found = refOf(e.target);
    hovered = found?.el;
    if (found) draw(found.el, found.ref);
    else outline.hidden = true;
  };

  const onClick = (e: MouseEvent) => {
    if (!enabled) return;
    const found = refOf(e.target);
    if (!found) return;
    // The page's own handlers must not also run: on a previewed site the marked
    // element is very often inside a link.
    e.preventDefault();
    e.stopPropagation();
    if (options.onEdit) options.onEdit(found.ref);
    else doc.defaultView?.open(adminEditUrl(options.adminUrl!, found.ref), '_blank', 'noopener');
  };

  const reposition = () => {
    const found = hovered ? refOf(hovered) : undefined;
    if (enabled && found) draw(found.el, found.ref);
    else outline.hidden = true;
  };

  function setEnabled(on: boolean): void {
    enabled = on;
    toggle.setAttribute('aria-pressed', String(on));
    if (!on) outline.hidden = true;
  }

  // Capture phase, so a page that stops propagation on its own handlers does not
  // also stop editing from working.
  doc.addEventListener('pointerover', onPointerOver, true);
  doc.addEventListener('click', onClick, true);
  doc.defaultView?.addEventListener('scroll', reposition, true);
  doc.defaultView?.addEventListener('resize', reposition);

  return {
    setEnabled,
    get enabled() {
      return enabled;
    },
    destroy() {
      doc.removeEventListener('pointerover', onPointerOver, true);
      doc.removeEventListener('click', onClick, true);
      doc.defaultView?.removeEventListener('scroll', reposition, true);
      doc.defaultView?.removeEventListener('resize', reposition);
      outline.remove();
      toggle.remove();
    },
  };
}
