import type { Resource } from 'i18next';
import enCommon from './locales/en/common.json';
import enStorefront from './locales/en/storefront.json';
import enUi from './locales/en/ui.json';
import esCommon from './locales/es/common.json';
import esStorefront from './locales/es/storefront.json';
import esUi from './locales/es/ui.json';

/** Bundled namespaces shipped with @commerceworker/i18n (common + storefront + ui chrome). */
export const baseResources: Resource = {
  en: {
    common: enCommon,
    storefront: enStorefront,
    ui: enUi,
  },
  es: {
    common: esCommon,
    storefront: esStorefront,
    ui: esUi,
  },
};
