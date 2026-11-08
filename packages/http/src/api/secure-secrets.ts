import { assertSecureSecrets, requireSecureSecretsFromEnv } from '@commerceworker/application';
import type { ApiConfig } from '@commerceworker/platform/config';

/** Validates auth secrets at API startup (production / REQUIRE_SECURE_SECRETS). */
export function validateApiSecrets(config: ApiConfig, env: NodeJS.ProcessEnv = process.env): void {
  assertSecureSecrets({
    requireSecureSecrets: requireSecureSecretsFromEnv(env),
    seedDev: config.seedDev,
    adminToken: config.adminToken,
    cmaKey: config.cmaKey,
    cdaKey: config.cdaKey,
    cpaKey: config.cpaKey,
    mcpToken: env.MCP_TOKEN,
    principalKeys: config.principalKeys,
  });
}
