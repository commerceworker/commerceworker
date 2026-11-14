import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';

/** Reads the resolved theme root.tsx put on <html>, and lets the shell change the choice. */
export function useTheme() {
  // Until the reader picks, the theme follows the system (root.tsx's script resolves it).
  const [state, setState] = useState<{ choice: ThemeChoice; resolved: 'light' | 'dark' }>({
    choice: 'system',
    resolved: 'light',
  });
  useEffect(() => {
    const d = document.documentElement;
    const read = () =>
      setState({
        choice: (d.dataset.themeChoice as ThemeChoice) || 'system',
        resolved: d.dataset.theme === 'dark' ? 'dark' : 'light',
      });
    read();
    const mo = new MutationObserver(read);
    mo.observe(d, { attributes: true, attributeFilter: ['data-theme', 'data-theme-choice'] });
    return () => mo.disconnect();
  }, []);
  const setChoice = useCallback((choice: ThemeChoice) => {
    try {
      localStorage.setItem('cw-theme', choice);
    } catch {
      // Storage blocked (private window): the choice lasts for this page only.
      document.documentElement.dataset.themeChoice = choice;
    }
    window.dispatchEvent(new Event('cw-theme'));
  }, []);
  return { ...state, setChoice };
}
