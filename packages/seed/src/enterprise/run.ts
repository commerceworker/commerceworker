import type { Principal } from '@commerceworker/domain';
import type { BlobStore } from '@commerceworker/ports';
import type { SeedRun } from '../types';

/** What every enterprise phase gets: the seed run plus the space's locales, a principal, files. */
export interface EnterpriseRun extends SeedRun {
  readonly space: { readonly defaultLocale: string; readonly locales: readonly string[] };
  /** The service principal for the use-cases that take one (see `installPrincipal`). */
  readonly principal: Principal;
  /** Object storage for the brand's files; asset phases skip without it. */
  readonly blob?: BlobStore;
}
