import { type ApiConfig, loadConfig } from '@commerceworker/platform/config';

/**
 * A complete ApiConfig for the HTTP suites: what `loadConfig` produces for a dev-keyed, all-roles
 * deployment, with the test's own settings laid over it. Keeps every suite on the real config type,
 * so a new required field shows up here once rather than as a stale literal in each test.
 */
export function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    ...loadConfig({
      ROLE: 'all',
      CMA_KEY: 'cma',
      CDA_KEY: 'cda',
      CPA_KEY: 'cpa',
      ADMIN_TOKEN: 'admin',
      SEED_SPACE_ID: 's1',
    } as NodeJS.ProcessEnv),
    ...overrides,
  };
}
