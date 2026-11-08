import i18n, { type InitOptions, type Resource } from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import { baseResources } from './base-resources';
import { mergeResources } from './merge-resources';

export type InitClientI18nOptions = {
  /** Merged on top of {@link baseResources}. */
  resources?: Resource;
  fallbackLng?: string | string[];
  lng?: string;
  defaultNS?: string | string[];
  /**
   * When false, skips `i18next-browser-languagedetector` (tests / SSR without `window`).
   * @default true in browser
   */
  enableDetector?: boolean;
};

/**
 * Browser singleton for React apps. Call once before `ReactDOM.createRoot` (or await in route `beforeLoad`).
 */
export async function initClientI18n(options: InitClientI18nOptions = {}): Promise<typeof i18n> {
  const merged = mergeResources(baseResources, options.resources ?? {});
  const useDetector =
    options.enableDetector !== false && typeof globalThis !== 'undefined' && 'window' in globalThis;

  if (i18n.isInitialized) {
    return i18n;
  }

  const initOpts: InitOptions = {
    resources: merged,
    fallbackLng: options.fallbackLng ?? 'en',
    defaultNS: options.defaultNS ?? 'common',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    ...(options.lng !== undefined ? { lng: options.lng } : {}),
    ...(useDetector
      ? {
          detection: {
            order: ['cookie', 'localStorage', 'navigator', 'htmlTag'],
            caches: ['localStorage', 'cookie'],
            lookupCookie: 'cw_locale',
            lookupLocalStorage: 'i18nextLng',
            cookieMinutes: 525600,
          },
        }
      : {}),
  };

  if (useDetector) {
    await i18n.use(LanguageDetector).use(initReactI18next).init(initOpts);
  } else {
    await i18n.use(initReactI18next).init(initOpts);
  }

  syncDocumentLanguage(i18n);

  return i18n;
}

/**
 * Keeps `<html lang>` in step with the active locale.
 *
 * The shell's `lang` is baked into `index.html` at build time, so switching language left it
 * asserting English over Spanish content — screen readers keep the English voice and
 * pronunciation rules (WCAG 2.2 A, 3.1.1 Language of Page). Every app initialises through this
 * function, so the correction belongs here rather than in each shell.
 */
function syncDocumentLanguage(instance: typeof i18n): void {
  if (typeof document === 'undefined') return;

  const apply = (lng?: string): void => {
    const base = (lng ?? instance.resolvedLanguage ?? instance.language ?? 'en').split('-')[0];
    if (base) document.documentElement.lang = base;
  };

  apply();
  instance.on('languageChanged', apply);
}

export { baseResources } from './base-resources';
export { mergeResources } from './merge-resources';
