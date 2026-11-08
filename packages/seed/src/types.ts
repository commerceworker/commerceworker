import type { AppContext } from '@commerceworker/application';
import type { Scope } from '@commerceworker/domain';
import type { BlobStore } from '@commerceworker/ports';

/**
 * The slice of app configuration the seed needs — deliberately narrower than
 * any app's config type so this package never depends on a composition root.
 */
export interface SeedConfig {
  readonly spaceId: string;
  readonly environmentId: string;
  readonly defaultLocale: string;
  readonly locales: readonly string[];
  /** Dev bearer tokens minted as hashed API keys (CMA/CDA/CPA). */
  readonly cmaKey: string;
  readonly cdaKey: string;
  readonly cpaKey: string;
  /** Optional pepper applied to token hashing (must match the API's). */
  readonly tokenPepper?: string;
  /**
   * Corpus multiplier: 1 (default) seeds the demo dataset (~550 generated
   * entries); larger values scale the generated types linearly for load and
   * pagination benchmarks (e.g. 100 → ~44k entries).
   */
  readonly scale?: number;
  /**
   * Also install the enterprise starter's brand into its own space (`aldermoor`). Default true:
   * local dev always has it; tests of the demo dataset alone turn it off.
   */
  readonly enterprise?: boolean;
}

/**
 * Maps the app-config shape both composition roots share (structurally — no
 * dependency on any app package) onto the seed's narrow config.
 */
export function seedConfigFrom(config: {
  readonly cmaKey: string;
  readonly cdaKey: string;
  readonly cpaKey: string;
  readonly tokenPepper?: string;
  readonly seed: {
    readonly spaceId: string;
    readonly environmentId: string;
    readonly defaultLocale: string;
    readonly locales: readonly string[];
    readonly scale?: number;
  };
}): SeedConfig {
  return {
    spaceId: config.seed.spaceId,
    environmentId: config.seed.environmentId,
    defaultLocale: config.seed.defaultLocale,
    locales: config.seed.locales,
    cmaKey: config.cmaKey,
    cdaKey: config.cdaKey,
    cpaKey: config.cpaKey,
    tokenPepper: config.tokenPepper,
    scale: config.seed.scale,
  };
}

/** Ports the seed uses beyond the AppContext. */
export interface SeedDeps {
  /** Object storage for demo assets; asset seeding is skipped when absent. */
  readonly blob?: BlobStore;
}

/** Everything the seed modules thread through, resolved once up front. */
export interface SeedRun {
  readonly ctx: AppContext;
  readonly scope: Scope;
  readonly locale: string;
  readonly locales: readonly string[];
  readonly hasDe: boolean;
  readonly scale: number;
  /** Leave a content type that already exists as it is (the starter); else re-save it (dev). */
  readonly keepExistingTypes?: boolean;
}
