# @commerceworker/i18n

Shared [i18next](https://www.i18next.com/) setup for CommerceWorker:

- **`@commerceworker/i18n`** — `createRequestI18n()` for non-React servers (e.g. web-worker Hono JSX), plus `resolveLocale()`, `tryLocaleFromCookie()`, `LOCALE_COOKIE` (`cw_locale`), and `SUPPORTED_LOCALES`.
- **`@commerceworker/i18n/client`** — `initClientI18n()` for React SPAs (uses [react-i18next](https://react.i18next.com/)); browser detection prefers `cw_locale` cookie, then `localStorage`, then navigator.

Bundled namespaces: `common`, `storefront`, `ui` (English + Spanish in `src/locales/`). Apps merge additional JSON via `resources` / `mergeResources`.

`@commerceworker/ui` primitives that expose user-visible strings use `useTranslation('ui')`.

## Key extraction (optional)

From the repo root:

```bash
pnpm i18n:extract
```

Writes proposed catalogs under `packages/i18n/crowdin/` (review before merging; not wired into CI by default).
