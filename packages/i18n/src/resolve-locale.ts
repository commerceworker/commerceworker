export const LOCALE_COOKIE = 'cw_locale';

/** Locales with bundled JSON in @commerceworker/i18n (extend when adding resources). */
export const SUPPORTED_LOCALES = ['en', 'es'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

function parseCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k || rest.length === 0) continue;
    out[k] = decodeURIComponent(rest.join('=').trim());
  }
  return out;
}

export function normalizeLocale(raw: string | undefined): SupportedLocale | null {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  const base = lower.split('-')[0] ?? lower;
  return (SUPPORTED_LOCALES as readonly string[]).includes(base) ? (base as SupportedLocale) : null;
}

/** Prefer `cw_locale` cookie, then `Accept-Language`, then English. */
export function resolveLocale(req: Request): SupportedLocale {
  const fromCookie = normalizeLocale(parseCookie(req.headers.get('cookie') ?? '')[LOCALE_COOKIE]);
  if (fromCookie) return fromCookie;

  const al = req.headers.get('accept-language');
  if (al) {
    const first = al.split(',')[0]?.trim();
    const candidate = normalizeLocale(first);
    if (candidate) return candidate;
  }

  return 'en';
}

/** Cookie header only (e.g. `document.cookie` in the browser). */
export function tryLocaleFromCookie(cookieHeader: string): SupportedLocale | null {
  return normalizeLocale(parseCookie(cookieHeader)[LOCALE_COOKIE]);
}
