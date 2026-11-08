import {
  type PluginManifest,
  type Principal,
  SCOPES,
  ValidationError,
} from '@commerceworker/domain';
import type { RemoteFetcher } from '@commerceworker/ports';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AppContext,
  installPluginFromUrl,
  type PluginSourcePolicy,
  setPluginEnabled,
  upgradePluginFromUrl,
} from '../src/index';
import { sha256Hex } from '../src/token-crypto';

const SPACE = 's1';
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };

let ctx: AppContext;
let blob: FakeBlobStore;

const NOW = new Date('2026-08-16T12:00:00.000Z');
const BUNDLE = 'export class Plugin { async onEntryBeforeSave(p) { return { payload: p }; } }';
const CHECKSUM = sha256Hex(BUNDLE);

const PACKAGE_URL = 'https://plugins.example.com/seo/1.0.0.json';
const BUNDLE_URL = 'https://plugins.example.com/seo/1.0.0.js';

const manifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  id: 'com.example.seo',
  name: 'SEO helper',
  version: '1.0.0',
  capabilities: ['content:read'],
  allowedHosts: [],
  hooks: ['entry:beforeSave'],
  entrypoint: 'index.js',
  ...over,
});

/** Serves a package descriptor and a bundle; a test can bend either. */
function fakeFetcher(
  over: { pkg?: Record<string, unknown>; bundle?: string; status?: number; throwOn?: string } = {},
): RemoteFetcher & { calls: string[] } {
  const calls: string[] = [];
  const pkg = {
    manifest: manifest(),
    bundleUrl: BUNDLE_URL,
    checksum: CHECKSUM,
    publishedAt: '2026-08-01T00:00:00.000Z',
    ...over.pkg,
  };
  return {
    calls,
    async get(url) {
      calls.push(url);
      if (over.throwOn && url.includes(over.throwOn)) throw new Error('network is down');
      if (over.status && over.status >= 300) return { status: over.status, body: '' };
      if (url.endsWith('.json')) return { status: 200, body: JSON.stringify(pkg) };
      return { status: 200, body: over.bundle ?? BUNDLE };
    },
    async getBytes() {
      throw new Error('plugin packages are read as text');
    },
  };
}

const install = (
  fetcher: RemoteFetcher,
  over: Record<string, unknown> = {},
  policy: PluginSourcePolicy = {},
) =>
  installPluginFromUrl(
    ctx,
    blob,
    fetcher,
    admin,
    SPACE,
    { packageUrl: PACKAGE_URL, approvedCapabilities: ['content:read'], ...over },
    policy,
  );

/** The actionable text of a refusal; `ValidationError.message` is generic. */
const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (err) {
    return err instanceof ValidationError ? (err.issues[0]?.message ?? '') : String(err);
  }
  return '';
};

beforeEach(() => {
  blob = new FakeBlobStore();
  ctx = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(NOW),
    ids: new SequenceIdGenerator('p'),
  };
});

describe('installing from a URL', () => {
  it('fetches, verifies and installs — disabled', async () => {
    const plugin = await install(fakeFetcher());
    expect(plugin.id).toBe('com.example.seo');
    expect(plugin.checksum).toBe(CHECKSUM);
    // Downloading code and running it are still two decisions.
    expect(plugin.enabled).toBe(false);
  });

  it('stores the bytes it verified, not the ones it was promised', async () => {
    const plugin = await install(fakeFetcher());
    expect(await blob.get(plugin.bundleKey)).toBe(BUNDLE);
  });

  it('still applies consent — a grant wider than the manifest is refused', async () => {
    await expect(
      install(fakeFetcher(), { approvedCapabilities: ['content:publish'] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('the bundle must be the bundle', () => {
  it('refuses bytes that do not match the declared checksum', async () => {
    // The one check nothing substitutes for: whatever the descriptor said,
    // these are not the bytes it described.
    const reason = await refusal(
      install(fakeFetcher({ bundle: 'export class Plugin {} // evil' })),
    );
    expect(reason).toMatch(/does not match its declared checksum/i);
  });

  it('leaves nothing behind when the bundle fails verification', async () => {
    await refusal(install(fakeFetcher({ bundle: 'tampered' })));
    // Verified before a byte reaches storage, so a bad package leaves no trace.
    expect(blob.keys()).toHaveLength(0);
  });

  it('refuses a package with no checksum at all', async () => {
    const reason = await refusal(install(fakeFetcher({ pkg: { checksum: undefined } })));
    expect(reason).toMatch(/no valid sha-256 checksum/i);
  });

  it('refuses a checksum that is not a SHA-256', async () => {
    expect(await refusal(install(fakeFetcher({ pkg: { checksum: 'abc' } })))).toMatch(
      /no valid sha-256/i,
    );
  });
});

describe('pinning', () => {
  it('installs when the pin agrees with the package', async () => {
    await expect(install(fakeFetcher(), { expectedChecksum: CHECKSUM })).resolves.toBeTruthy();
  });

  it('is case-insensitive about hex', async () => {
    await expect(
      install(fakeFetcher(), { expectedChecksum: CHECKSUM.toUpperCase() }),
    ).resolves.toBeTruthy();
  });

  it('refuses when the release changed since it was approved', async () => {
    // A publisher, or whoever took over the URL, swapping bytes behind an
    // approval given for something else is what a pin exists to catch.
    const reason = await refusal(install(fakeFetcher(), { expectedChecksum: 'f'.repeat(64) }));
    expect(reason).toMatch(/changed since it was approved/i);
  });

  it('refuses a package that is a different plugin', async () => {
    expect(await refusal(install(fakeFetcher(), { expectedId: 'com.example.other' }))).toMatch(
      /not "com.example.other"/,
    );
  });

  it('refuses a package that is a different version', async () => {
    expect(await refusal(install(fakeFetcher(), { expectedVersion: '2.0.0' }))).toMatch(
      /not 2\.0\.0/,
    );
  });

  it('checks identity before downloading the bundle', async () => {
    const fetcher = fakeFetcher();
    await refusal(install(fetcher, { expectedVersion: '2.0.0' }));
    // A package that was never installable does not get to make the server
    // fetch two megabytes first.
    expect(fetcher.calls).toEqual([PACKAGE_URL]);
  });
});

describe('where a package may come from', () => {
  it('refuses plaintext http', async () => {
    // The bytes are executed; plaintext means anyone on the path picks the code.
    expect(
      await refusal(install(fakeFetcher(), { packageUrl: 'http://plugins.example.com/p.json' })),
    ).toMatch(/must use https/i);
  });

  it('refuses an internal address', async () => {
    expect(
      await refusal(install(fakeFetcher(), { packageUrl: 'https://169.254.169.254/latest.json' })),
    ).toMatch(/loopback, link-local, or private/i);
  });

  it('refuses a bundle URL that is not https, even when the package URL was', async () => {
    const reason = await refusal(
      install(fakeFetcher({ pkg: { bundleUrl: 'http://plugins.example.com/x.js' } })),
    );
    expect(reason).toMatch(/must use https/i);
  });

  it('refuses a bundle URL pointing somewhere internal', async () => {
    const reason = await refusal(
      install(fakeFetcher({ pkg: { bundleUrl: 'https://localhost/x.js' } })),
    );
    expect(reason).toMatch(/loopback/i);
  });

  it('honours a deployment host allowlist', async () => {
    const policy = { allowedHosts: ['plugins.example.com'] };
    await expect(install(fakeFetcher(), {}, policy)).resolves.toBeTruthy();
    expect(
      await refusal(install(fakeFetcher(), { packageUrl: 'https://evil.test/p.json' }, policy)),
    ).toMatch(/not in this deployment's plugin source allowlist/i);
  });

  it('matches a wildcard against subdomains but not the apex', async () => {
    const policy = { allowedHosts: ['*.example.com'] };
    await expect(install(fakeFetcher(), {}, policy)).resolves.toBeTruthy();
    expect(
      await refusal(install(fakeFetcher(), { packageUrl: 'https://example.com/p.json' }, policy)),
    ).toMatch(/allowlist/i);
  });

  it('treats a redirect as a URL nothing screened', async () => {
    expect(await refusal(install(fakeFetcher({ status: 302 })))).toMatch(/HTTP 302/);
  });

  it('reports a fetch failure rather than throwing something opaque', async () => {
    expect(await refusal(install(fakeFetcher({ throwOn: '.json' })))).toMatch(/could not fetch/i);
  });
});

describe('minimum release age', () => {
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

  it('installs a release that has aged enough', async () => {
    await expect(
      install(
        fakeFetcher({ pkg: { publishedAt: hoursAgo(48) } }),
        {},
        { minimumReleaseAgeHours: 24 },
      ),
    ).resolves.toBeTruthy();
  });

  it('refuses one that has not, and says how long it waits', async () => {
    // A compromised release is usually caught within hours; waiting means the
    // deployment is not exposed to the window where it is public and unnoticed.
    const reason = await refusal(
      install(
        fakeFetcher({ pkg: { publishedAt: hoursAgo(2) } }),
        {},
        { minimumReleaseAgeHours: 24 },
      ),
    );
    expect(reason).toMatch(/waits 24h/);
  });

  it('cannot be bypassed by omitting the publish time', async () => {
    const reason = await refusal(
      install(fakeFetcher({ pkg: { publishedAt: undefined } }), {}, { minimumReleaseAgeHours: 24 }),
    );
    expect(reason).toMatch(/does not say when it was published/i);
  });

  it('lets a caller ask for longer than the deployment requires', async () => {
    const reason = await refusal(
      install(
        fakeFetcher({ pkg: { publishedAt: hoursAgo(30) } }),
        { minimumReleaseAgeHours: 72 },
        { minimumReleaseAgeHours: 24 },
      ),
    );
    expect(reason).toMatch(/waits 72h/);
  });

  it('does not let a caller ask for shorter', async () => {
    const reason = await refusal(
      install(
        fakeFetcher({ pkg: { publishedAt: hoursAgo(2) } }),
        { minimumReleaseAgeHours: 0 },
        { minimumReleaseAgeHours: 24 },
      ),
    );
    // A policy a caller can turn off is not a policy.
    expect(reason).toMatch(/waits 24h/);
  });

  it('is off when no deployment policy is set', async () => {
    await expect(
      install(fakeFetcher({ pkg: { publishedAt: NOW.toISOString() } })),
    ).resolves.toBeTruthy();
  });
});

describe('upgrading from a URL', () => {
  const V2 = 'export class Plugin { /* v2 */ }';
  const v2Package = (over: Record<string, unknown> = {}) =>
    fakeFetcher({
      pkg: {
        manifest: manifest({ version: '2.0.0' }),
        checksum: sha256Hex(V2),
        ...over,
      },
      bundle: V2,
    });

  const upgrade = (fetcher: RemoteFetcher, over: Record<string, unknown> = {}) =>
    upgradePluginFromUrl(ctx, blob, fetcher, admin, SPACE, {
      packageUrl: 'https://plugins.example.com/seo/2.0.0.json',
      ...over,
    });

  beforeEach(async () => {
    const plugin = await install(fakeFetcher());
    await setPluginEnabled(ctx, SPACE, plugin.id, true);
  });

  it('replaces the bundle and carries the grant forward', async () => {
    const upgraded = await upgrade(v2Package());
    expect(upgraded.manifest.version).toBe('2.0.0');
    expect(upgraded.checksum).toBe(sha256Hex(V2));
    expect(upgraded.approvedCapabilities).toEqual(['content:read']);
    // No capability change, so it keeps running.
    expect(upgraded.enabled).toBe(true);
  });

  it('verifies the new bundle just as hard', async () => {
    const fetcher = fakeFetcher({
      pkg: { manifest: manifest({ version: '2.0.0' }), checksum: sha256Hex(V2) },
      bundle: 'something else entirely',
    });
    expect(await refusal(upgrade(fetcher))).toMatch(/does not match its declared checksum/i);
  });

  it('still demands fresh consent when the new version wants more', async () => {
    const wider = v2Package({
      manifest: manifest({ version: '2.0.0', capabilities: ['content:read', 'content:publish'] }),
    });
    // An upgrade over the network must not be a quieter way to acquire authority.
    await expect(upgrade(wider)).rejects.toBeInstanceOf(ValidationError);
  });

  it('applies the release-age policy to upgrades too', async () => {
    const reason = await refusal(
      upgradePluginFromUrl(
        ctx,
        blob,
        v2Package({ publishedAt: new Date(NOW.getTime() - 3_600_000).toISOString() }),
        admin,
        SPACE,
        { packageUrl: 'https://plugins.example.com/seo/2.0.0.json' },
        { minimumReleaseAgeHours: 24 },
      ),
    );
    expect(reason).toMatch(/waits 24h/);
  });
});

describe('the fetcher is only asked for what it should be', () => {
  it('fetches the descriptor, then the bundle, and nothing else', async () => {
    const fetcher = fakeFetcher();
    await install(fetcher);
    expect(fetcher.calls).toEqual([PACKAGE_URL, BUNDLE_URL]);
  });

  it('bounds both downloads', async () => {
    const get = vi.fn(async (url: string) => ({
      status: 200,
      body: url.endsWith('.json')
        ? JSON.stringify({ manifest: manifest(), bundleUrl: BUNDLE_URL, checksum: CHECKSUM })
        : BUNDLE,
    }));
    await installPluginFromUrl(ctx, blob, { get } as unknown as RemoteFetcher, admin, SPACE, {
      packageUrl: PACKAGE_URL,
      approvedCapabilities: ['content:read'],
    });
    // A hostile origin must not be able to stream until memory runs out.
    for (const call of get.mock.calls) {
      expect((call[1] as { maxBytes: number }).maxBytes).toBeGreaterThan(0);
    }
  });
});
