import { LOCALE_COOKIE, SUPPORTED_LOCALES, type SupportedLocale } from '@commerceworker/i18n';
import { useTranslation } from 'react-i18next';
import { cn } from './lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

export type LanguageSwitcherProps = {
  className?: string;
  /** When set, navigate here after changing language (e.g. web-worker `/locale?lng=&next=`). */
  redirectBasePath?: string;
};

function persistLocaleCookie(code: SupportedLocale): void {
  if (typeof document === 'undefined') return;
  // biome-ignore lint/suspicious/noDocumentCookie: explicit cw_locale for Workers BFF + i18next cookie detector
  document.cookie = `${LOCALE_COOKIE}=${code}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`;
}

export function LanguageSwitcher({ className, redirectBasePath }: LanguageSwitcherProps) {
  const { t, i18n } = useTranslation('ui');
  const raw = (i18n.resolvedLanguage ?? i18n.language ?? 'en').split('-')[0] ?? 'en';
  const safe = (SUPPORTED_LOCALES as readonly string[]).includes(raw)
    ? (raw as SupportedLocale)
    : 'en';

  return (
    <Select
      value={safe}
      onValueChange={(value: string) => {
        const code = value as SupportedLocale;
        persistLocaleCookie(code);
        if (redirectBasePath !== undefined && typeof window !== 'undefined') {
          const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
          const url = `${redirectBasePath}?lng=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`;
          window.location.assign(url);
          return;
        }
        void i18n.changeLanguage(code);
      }}
    >
      {/* Phones show the locale code (EN / ES) so the trigger costs ~44px instead of a
          fixed 152px; the full name returns at `sm`. Same control, same place, same menu —
          only the trigger's label is abbreviated. The trigger keeps its aria-label, and the
          code is the accessible text below `sm`. */}
      <SelectTrigger
        className={cn('h-8 w-auto sm:w-[9.5rem]', className)}
        aria-label={t('language')}
      >
        <span className="sm:hidden">{safe.toUpperCase()}</span>
        <span className="hidden truncate sm:block">
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent>
        {SUPPORTED_LOCALES.map((code) => (
          <SelectItem key={code} value={code}>
            {t(`languageName_${code}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
