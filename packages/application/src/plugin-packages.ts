import {
  type InstalledPlugin,
  type PluginCapability,
  type PluginManifest,
  type Principal,
  ValidationError,
} from '@commerceworker/domain';
import type { BlobStore, RemoteFetcher } from '@commerceworker/ports';
import type { AppContext } from './context';
import { installPlugin, upgradePlugin } from './plugins';
import { sha256Hex } from './token-crypto';
import { assertSafeExternalUrl } from './url-safety';

/**
 * Installing a plugin from somewhere else.
 *
 * The registry already decided *authority* — what a plugin may do, and who
 * said so. This decides **provenance**: that the code about to be installed is
 * the code the operator meant to install, and not something that changed under
 * them between the decision and the download.
 *
 * There is no registry service here, and deliberately so. A URL and a checksum
 * cover the real need; a federated index is a distribution convenience layered
 * on top, not a prerequisite, and building it first would mean a trust root
 * nobody asked for.
 */

/** What a publisher hosts at the package URL. */
export interface PluginPackage {
  readonly manifest: PluginManifest;
  /** Where the bundle lives. Must be HTTPS. */
  readonly bundleUrl: string;
  /** SHA-256 of the bundle, hex. The bytes are refused if they disagree. */
  readonly checksum: string;
  /** When this release was published, ISO-8601. Backs `minimumReleaseAgeHours`. */
  readonly publishedAt?: string;
}

/** Largest package descriptor and bundle this will download. */
export const MAX_PACKAGE_BYTES = 64 * 1024;
export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;

export interface PluginSourcePolicy {
  /**
   * How old a release must be before it may be installed.
   *
   * A compromised release is usually caught within hours, so a deployment that
   * waits is not exposed to the window where it is public and unnoticed. The
   * cost is that a genuine fix also waits — which is why it is a deployment
   * decision rather than a default.
   */
  readonly minimumReleaseAgeHours?: number;
  /** Hosts packages may be fetched from. Empty means any (screened) HTTPS host. */
  readonly allowedHosts?: readonly string[];
}

export interface InstallFromUrlInput {
  /** URL of the package descriptor. */
  readonly packageUrl: string;
  /**
   * Checksum the operator is pinning to.
   *
   * When set, the package's own checksum must match it. This is what stops a
   * publisher — or anyone who took over the URL — from swapping the bytes
   * behind an approval that was given for something else.
   */
  readonly expectedChecksum?: string;
  /** Plugin id the caller believes this is. Refused if the manifest disagrees. */
  readonly expectedId?: string;
  /** Version the caller believes this is. Refused if the manifest disagrees. */
  readonly expectedVersion?: string;
  /** Exactly what the human approved. */
  readonly approvedCapabilities: readonly PluginCapability[];
  /** Ask for a longer wait than the deployment's own; never a shorter one. */
  readonly minimumReleaseAgeHours?: number;
}

/**
 * Fetches a package and installs it, disabled.
 *
 * Everything verified here is verified *before* a byte reaches the blob store,
 * so a package that fails any check leaves nothing behind.
 */
export async function installPluginFromUrl(
  ctx: AppContext,
  blob: BlobStore,
  fetcher: RemoteFetcher,
  principal: Principal,
  spaceId: string,
  input: InstallFromUrlInput,
  policy: PluginSourcePolicy = {},
): Promise<InstalledPlugin> {
  const { manifest, bundle } = await fetchPackage(ctx, fetcher, input, policy);
  return installPlugin(ctx, blob, principal, spaceId, {
    manifest,
    bundle,
    approvedCapabilities: input.approvedCapabilities,
  });
}

/** What a package turns out to be, once fetched and verified. */
export interface InspectedPackage {
  readonly manifest: PluginManifest;
  /** The checksum of the bytes that were actually fetched. */
  readonly checksum: string;
  readonly publishedAt?: string;
  readonly bundleBytes: number;
}

/**
 * Fetches and verifies a package without installing it.
 *
 * This is what makes install-from-URL consentable. A consent screen exists to
 * show a human what they are approving, and for a URL there is nothing to show
 * until someone fetches it — so the server fetches it, verifies it exactly as
 * an install would, and hands back what it found.
 *
 * The caller should then install with `expectedChecksum` set to the checksum
 * returned here. That closes the gap between the two calls: a release swapped
 * in between is refused instead of installed under an approval given for
 * something else.
 */
export async function inspectPluginPackage(
  ctx: AppContext,
  fetcher: RemoteFetcher,
  input: Omit<InstallFromUrlInput, 'approvedCapabilities'>,
  policy: PluginSourcePolicy = {},
): Promise<InspectedPackage> {
  const { manifest, bundle, publishedAt } = await fetchPackage(
    ctx,
    fetcher,
    { ...input, approvedCapabilities: [] },
    policy,
  );
  return {
    manifest,
    checksum: sha256Hex(bundle),
    ...(publishedAt ? { publishedAt } : {}),
    bundleBytes: bundle.length,
  };
}

export interface UpgradeFromUrlInput extends Omit<InstallFromUrlInput, 'approvedCapabilities'> {
  /** Omit to carry the existing grant forward; required when the new version asks for more. */
  readonly approvedCapabilities?: readonly PluginCapability[];
}

/** Fetches a package and upgrades an installed plugin to it. */
export async function upgradePluginFromUrl(
  ctx: AppContext,
  blob: BlobStore,
  fetcher: RemoteFetcher,
  principal: Principal,
  spaceId: string,
  input: UpgradeFromUrlInput,
  policy: PluginSourcePolicy = {},
): Promise<InstalledPlugin> {
  const { manifest, bundle } = await fetchPackage(
    ctx,
    fetcher,
    { ...input, approvedCapabilities: [] },
    policy,
  );
  return upgradePlugin(ctx, blob, principal, spaceId, {
    manifest,
    bundle,
    ...(input.approvedCapabilities ? { approvedCapabilities: input.approvedCapabilities } : {}),
  });
}

/**
 * The whole verification chain, in the order that keeps the dangerous step last.
 *
 * The bundle is downloaded only after everything knowable from the descriptor
 * has been checked, so a package that was never going to be installable does
 * not get to make the server fetch a two-megabyte file first.
 */
async function fetchPackage(
  ctx: AppContext,
  fetcher: RemoteFetcher,
  input: InstallFromUrlInput,
  policy: PluginSourcePolicy,
): Promise<{ manifest: PluginManifest; bundle: string; publishedAt?: string }> {
  assertHttpsAndAllowed(input.packageUrl, 'packageUrl', policy);

  const descriptor = await getJson(fetcher, input.packageUrl, MAX_PACKAGE_BYTES, 'packageUrl');
  const pkg = assertPackageShape(descriptor);

  if (input.expectedId && pkg.manifest.id !== input.expectedId) {
    throw refuse(
      'expectedId',
      `Package declares plugin "${pkg.manifest.id}", not "${input.expectedId}"`,
    );
  }
  if (input.expectedVersion && pkg.manifest.version !== input.expectedVersion) {
    throw refuse(
      'expectedVersion',
      `Package declares version ${pkg.manifest.version}, not ${input.expectedVersion}`,
    );
  }
  // A pin that disagrees with the package means the bytes changed since the
  // operator wrote the checksum down. That is exactly the case this exists for.
  if (input.expectedChecksum && !equalsIgnoringCase(pkg.checksum, input.expectedChecksum)) {
    throw refuse(
      'expectedChecksum',
      'Package checksum does not match the pinned checksum; the release changed since it was approved',
    );
  }

  assertOldEnough(
    ctx,
    pkg,
    Math.max(policy.minimumReleaseAgeHours ?? 0, input.minimumReleaseAgeHours ?? 0),
  );
  assertHttpsAndAllowed(pkg.bundleUrl, 'bundleUrl', policy);

  const fetched = await get(fetcher, pkg.bundleUrl, MAX_BUNDLE_BYTES, 'bundleUrl');
  const actual = sha256Hex(fetched);
  if (!equalsIgnoringCase(actual, pkg.checksum)) {
    // The one check nothing else can substitute for: whatever the descriptor
    // said, these are the bytes, and they are not the ones it described.
    throw refuse(
      'bundleUrl',
      `Bundle does not match its declared checksum (declared ${pkg.checksum}, got ${actual})`,
    );
  }

  return {
    manifest: pkg.manifest,
    bundle: fetched,
    ...(pkg.publishedAt ? { publishedAt: pkg.publishedAt } : {}),
  };
}

/**
 * Requires HTTPS, screens for SSRF, and applies the host allowlist.
 *
 * HTTPS rather than "http or https": this fetches code that will be executed,
 * and plaintext means anyone on the path chooses what runs.
 */
function assertHttpsAndAllowed(url: string, field: string, policy: PluginSourcePolicy): void {
  assertSafeExternalUrl(url, field);
  if (!url.toLowerCase().startsWith('https://')) {
    throw refuse(field, 'must use https — plugin code is executed, so plaintext is not acceptable');
  }
  const allowed = policy.allowedHosts;
  if (!allowed || allowed.length === 0) return;
  const host = hostOf(url);
  if (!allowed.some((entry) => hostMatches(entry, host))) {
    throw refuse(field, `host "${host}" is not in this deployment's plugin source allowlist`);
  }
}

function assertOldEnough(ctx: AppContext, pkg: PluginPackage, minimumHours: number): void {
  if (minimumHours <= 0) return;
  if (!pkg.publishedAt) {
    // Without a publish time the policy cannot be applied, and treating that as
    // "old enough" would make the knob bypassable by omitting a field.
    throw refuse(
      'publishedAt',
      `This deployment requires releases to be at least ${minimumHours}h old, and the package does not say when it was published`,
    );
  }
  const published = Date.parse(pkg.publishedAt);
  if (Number.isNaN(published)) {
    throw refuse('publishedAt', `"${pkg.publishedAt}" is not a valid ISO-8601 timestamp`);
  }
  const ageHours = (ctx.clock.now().getTime() - published) / 3_600_000;
  if (ageHours < minimumHours) {
    throw refuse(
      'publishedAt',
      `Release is ${ageHours.toFixed(1)}h old; this deployment waits ${minimumHours}h before adopting a new release`,
    );
  }
}

function assertPackageShape(value: unknown): PluginPackage {
  const pkg = value as Partial<PluginPackage>;
  if (typeof pkg !== 'object' || pkg === null) {
    throw refuse('packageUrl', 'Package is not a JSON object');
  }
  if (typeof pkg.manifest !== 'object' || pkg.manifest === null) {
    throw refuse('packageUrl', 'Package has no manifest');
  }
  if (typeof pkg.bundleUrl !== 'string' || !pkg.bundleUrl) {
    throw refuse('packageUrl', 'Package has no bundleUrl');
  }
  if (typeof pkg.checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(pkg.checksum)) {
    // Without a declared checksum there is nothing to verify the bundle
    // against, which is the entire point of installing from a URL rather than
    // uploading a file someone already has.
    throw refuse('packageUrl', 'Package has no valid SHA-256 checksum');
  }
  return pkg as PluginPackage;
}

async function getJson(
  fetcher: RemoteFetcher,
  url: string,
  maxBytes: number,
  field: string,
): Promise<unknown> {
  const body = await get(fetcher, url, maxBytes, field);
  try {
    return JSON.parse(body);
  } catch {
    throw refuse(field, 'Package is not valid JSON');
  }
}

async function get(
  fetcher: RemoteFetcher,
  url: string,
  maxBytes: number,
  field: string,
): Promise<string> {
  let doc: Awaited<ReturnType<RemoteFetcher['get']>>;
  try {
    doc = await fetcher.get(url, { maxBytes });
  } catch (err) {
    throw refuse(field, `Could not fetch: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (doc.status >= 300) {
    // Includes 3xx: the fetcher does not follow redirects, so a redirect is a
    // URL that was never screened rather than a detail to smooth over.
    throw refuse(field, `Fetch returned HTTP ${doc.status}`);
  }
  return doc.body;
}

const refuse = (field: string, message: string) => new ValidationError([{ field, message }]);

const equalsIgnoringCase = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function hostOf(url: string): string {
  const withoutScheme = url.slice(url.indexOf('://') + 3);
  const end = withoutScheme.search(/[/?#]/);
  const authority = end === -1 ? withoutScheme : withoutScheme.slice(0, end);
  const afterCredentials = authority.slice(authority.lastIndexOf('@') + 1);
  return afterCredentials.split(':')[0]?.toLowerCase() ?? '';
}

/** Exact match, or `*.example.com` covering subdomains but not the apex. */
function hostMatches(entry: string, host: string): boolean {
  const pattern = entry.toLowerCase();
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) && host !== pattern.slice(2);
  return host === pattern;
}
