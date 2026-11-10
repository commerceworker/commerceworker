import type { CatalogEnv } from '../../src/catalog/env';

// What `env` from cloudflare:workers holds in these tests (test/catalog/wrangler.jsonc).
declare global {
  namespace Cloudflare {
    interface Env extends CatalogEnv {}
  }
}
