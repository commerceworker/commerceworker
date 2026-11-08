import { useEffect, useState, useSyncExternalStore } from 'react';
import { hasOpenInlineConfirm } from '~/cms/components/InlineConfirm';

/**
 * Whether a single-key shortcut (G then a letter, ?, J/K on a list) may act on
 * this key press. Not with ⌘, Ctrl or Alt held (those belong to the browser and
 * the system), not while composing or typing in a field, and not while a
 * dialog, menu, sheet or inline confirmation is open over the page.
 */
export function plainKeyAllowed(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return false;
  const el = e.target instanceof Element ? e.target : null;
  if (el instanceof HTMLElement && el.isContentEditable) return false;
  if (el?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) {
    return false;
  }
  if (hasOpenInlineConfirm()) return false;
  // Radix unmounts closed overlays, so presence means open; a force-mounted
  // one says otherwise with data-state="closed".
  return !document.querySelector(
    '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"], [role="menu"]:not([data-state="closed"]), [role="listbox"]:not([data-state="closed"]), dialog[open]',
  );
}

const APPLE = /Mac|iPhone|iPad|iPod/;

/** True on a Mac, iPhone or iPad, where the command key is ⌘ rather than Ctrl. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return true;
  return APPLE.test(navigator.platform || navigator.userAgent);
}

/**
 * A ⌘/Ctrl chord as this device writes it: "⌘K" on Apple devices, "Ctrl+K"
 * elsewhere. Pass the key alone ("K", "S").
 */
export function useShortcutLabel(key: string): string {
  const [apple, setApple] = useState(true);
  useEffect(() => setApple(isApplePlatform()), []);
  return apple ? `⌘${key}` : `Ctrl+${key}`;
}

/** The modifier key's printed name on this device: "⌘" or "Ctrl". */
export function useModKeyLabel(): string {
  const [apple, setApple] = useState(true);
  useEffect(() => setApple(isApplePlatform()), []);
  return apple ? '⌘' : 'Ctrl';
}

/**
 * True with a fine pointer (mouse, trackpad). Visible key hints only make sense
 * there; touch-first devices rarely have a keyboard attached.
 */
export function useFinePointer(): boolean {
  return useMediaQuery('(pointer: fine)');
}

/** Subscribes to a media query; false where `matchMedia` is unavailable (tests). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', notify);
      return () => mql.removeEventListener('change', notify);
    },
    () => (typeof window !== 'undefined' && window.matchMedia?.(query).matches) || false,
    () => false,
  );
}

// ---------------------------------------------------------------------------
// The shortcuts list ("?"): global groups plus whatever the current page adds.
// ---------------------------------------------------------------------------

/**
 * One row in the shortcuts list. `keys` are pressed one after another ("G then
 * D") unless `chord` is set, in which case they are held together. The token
 * `Mod` prints as ⌘ or Ctrl for the device.
 */
export interface ShortcutItem {
  readonly keys: readonly string[];
  readonly label: string;
  readonly chord?: boolean;
}

export interface ShortcutGroup {
  /** Stable id; registering the same id again replaces the earlier group. */
  readonly id: string;
  /** Heading in the shortcuts list, sentence case ("Entries list"). */
  readonly title: string;
  readonly items: readonly ShortcutItem[];
}

let pageGroups: readonly ShortcutGroup[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/**
 * Adds a page's shortcuts to the "?" list until the returned function is called.
 * Prefer `usePageShortcuts` inside a component.
 */
export function registerShortcuts(group: ShortcutGroup): () => void {
  pageGroups = [...pageGroups.filter((g) => g.id !== group.id), group];
  emit();
  return () => {
    const before = pageGroups.length;
    pageGroups = pageGroups.filter((g) => g !== group);
    if (pageGroups.length !== before) emit();
  };
}

/**
 * Lists a page's own shortcuts in the "?" dialog while the page is mounted.
 * Pass a module-level constant so the effect does not re-run each render:
 *
 *   export const ENTRIES_LIST_SHORTCUTS: ShortcutGroup = { id: 'entries-list', ... };
 *   usePageShortcuts(ENTRIES_LIST_SHORTCUTS);
 *
 * The page still handles its own keys; guard the handler with `plainKeyAllowed`.
 */
export function usePageShortcuts(group: ShortcutGroup): void {
  useEffect(() => registerShortcuts(group), [group]);
}

/** The page-level groups currently registered, in registration order. */
export function usePageShortcutGroups(): readonly ShortcutGroup[] {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => pageGroups,
    () => pageGroups,
  );
}
