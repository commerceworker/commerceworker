// commerceworker.com: static Astro pages, English at the root and Spanish under /es/. No runtime
// code: dist/ is served as Workers static assets (wrangler.jsonc), with security headers from
// public/_headers. The palette comes from @commerceworker/design at build time.
import { defineConfig, passthroughImageService } from 'astro/config';

export default defineConfig({
  site: 'https://commerceworker.com',
  trailingSlash: 'always',
  // No image transforms: the default service needs `sharp`, which these pages don't need.
  image: { service: passthroughImageService() },
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'es'],
    routing: { prefixDefaultLocale: false },
  },
});
