import { loadConfig } from '@commerceworker/platform/config';
import { describe, expect, it } from 'vitest';
import { oauthConfigFrom } from '../../src/api/oauth/routes';

describe('OAuth settings as the Worker configs declare them', () => {
  it('reads an empty OAUTH_RESOURCE as unset, so the resource is the issuer’s /mcp', () => {
    // apps/api/wrangler.jsonc declares OAUTH_RESOURCE as "", and the fleet sets only the issuer.
    const config = loadConfig({
      OAUTH_ISSUER: 'https://acme.commerceworker.com',
      OAUTH_RESOURCE: '',
    } as NodeJS.ProcessEnv);
    expect(oauthConfigFrom(config).resource).toBe('https://acme.commerceworker.com/mcp');
  });

  it('reads an empty OAUTH_ISSUER as off', () => {
    expect(loadConfig({ OAUTH_ISSUER: '' } as NodeJS.ProcessEnv).oauthIssuer).toBeUndefined();
  });

  it('keeps an explicit resource', () => {
    const config = loadConfig({
      OAUTH_ISSUER: 'https://acme.commerceworker.com',
      OAUTH_RESOURCE: 'https://api.acme.commerceworker.com/mcp',
    } as NodeJS.ProcessEnv);
    expect(oauthConfigFrom(config).resource).toBe('https://api.acme.commerceworker.com/mcp');
  });
});
