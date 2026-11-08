// Bindings provided by vitest.config.ts (miniflare section), typed as required.
declare global {
  namespace Cloudflare {
    interface Env {
      readonly DB: D1Database;
      readonly KV_CACHE: KVNamespace;
      readonly MEDIA_BUCKET: R2Bucket;
      readonly MEDIA_SIGNING_SECRET: string;
    }
  }
}

export {};
