import { assertSecureSecrets, requireSecureSecretsFromEnv } from '@commerceworker/application';
import type { ApiConfig } from './config';
import type { EdgeEnv } from './env';

/**
 * Validates auth secrets at API startup (production / REQUIRE_SECURE_SECRETS). Reads the Worker's
 * env (`NODE_ENV` too, when it is set as a var), so it lives with the composition roots and the
 * HTTP library never reads an environment itself.
 */
export function validateApiSecrets(config: ApiConfig, env: EdgeEnv): void {
  assertSecureSecrets({
    requireSecureSecrets: requireSecureSecretsFromEnv(env as unknown as NodeJS.ProcessEnv),
    seedDev: config.seedDev,
    adminToken: config.adminToken,
    cmaKey: config.cmaKey,
    cdaKey: config.cdaKey,
    cpaKey: config.cpaKey,
    mcpToken: env.MCP_TOKEN,
    principalKeys: config.principalKeys,
  });
}
