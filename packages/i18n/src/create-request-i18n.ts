import { createInstance, type InitOptions, type i18n, type Resource } from 'i18next';
import { baseResources } from './base-resources';
import { mergeResources } from './merge-resources';

export type CreateRequestI18nOptions = {
  lng: string;
  /** Merged on top of {@link baseResources}. */
  resources?: Resource;
  fallbackLng?: string | string[];
  defaultNS?: string | string[];
};

/**
 * Server / non-React: fresh i18next instance per request (Workers-safe).
 * Uses `escapeValue: true` for HTML string safety in Hono JSX.
 */
export async function createRequestI18n(options: CreateRequestI18nOptions): Promise<i18n> {
  const {
    lng,
    resources: extra,
    fallbackLng = 'en',
    defaultNS = ['storefront', 'common'],
  } = options;

  const merged = mergeResources(baseResources, extra ?? {});
  const instance = createInstance();
  const init: InitOptions = {
    lng,
    fallbackLng,
    defaultNS,
    resources: merged,
    interpolation: { escapeValue: true },
  };
  await instance.init(init);
  return instance;
}
