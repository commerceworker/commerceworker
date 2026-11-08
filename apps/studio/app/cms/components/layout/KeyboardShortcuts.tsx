/**
 * The keyboard shortcuts list is the shell's sheet (routes/shell.tsx): G then a letter, ?, ⌘K and
 * the page's own keys as each screen registers them (lib/shortcuts `usePageShortcuts`). This
 * module is how the rest of the CMS opens it.
 */

export const OPEN_SHORTCUTS_EVENT = 'commerceworker:shortcuts-open';

/** Open the keyboard shortcuts list from anywhere (the palette, a page's help link). */
export const openKeyboardShortcuts = () => window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT));
