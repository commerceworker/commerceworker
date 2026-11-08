import type { AssetPlaceholder, FocalPoint, Scope } from '@commerceworker/domain';
import type {
  AssetGate,
  AssetGateEntry,
  AssetIngestParams,
  AssetIngestQueue,
  AssetIngestRequest,
  AssetIngestStarter,
  AssetZipParams,
  AssetZipStarter,
  ByteStream,
  ExtractableFile,
  HostedVideo,
  ImageInfo,
  ImageProbe,
  ImageTransformer,
  ImageTransformSpec,
  MediaPathSigner,
  PasswordHasher,
  TextExtractor,
  VideoHost,
  VideoUpload,
} from '@commerceworker/ports';

/**
 * An ImageTransformer that records each call and returns a deterministic URL
 * (`<source>#t=<json>`), so tests can assert the transform and focal point the
 * application handed over without depending on any provider's URL grammar.
 */
export class FakeImageTransformer implements ImageTransformer {
  readonly calls: {
    sourceUrl: string;
    transform: ImageTransformSpec;
    focalPoint?: FocalPoint;
    expiresInSeconds?: number;
  }[] = [];

  async transformUrl(
    sourceUrl: string,
    transform: ImageTransformSpec,
    focalPoint?: FocalPoint,
    opts?: { readonly expiresInSeconds?: number },
  ) {
    this.calls.push({
      sourceUrl,
      transform,
      ...(focalPoint ? { focalPoint } : {}),
      ...(opts?.expiresInSeconds ? { expiresInSeconds: opts.expiresInSeconds } : {}),
    });
    return `${sourceUrl}#t=${encodeURIComponent(JSON.stringify({ ...transform, focalPoint }))}`;
  }
}

/**
 * A MediaPathSigner with no key: the token is a deterministic 22-character digest of the scope,
 * the asset and the version, so tests can tell tokens apart without a secret. Not a MAC.
 */
export class FakeMediaPathSigner implements MediaPathSigner {
  token(scope: Scope, assetId: string, version: number): string {
    const input = `${scope.spaceId}\n${scope.environmentId}\n${assetId}\n${version}`;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let h = 0x811c9dc5;
    let out = '';
    for (let i = 0; i < 22; i++) {
      for (const ch of `${i}${input}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
      out += alphabet[h % 64];
    }
    return out;
  }
  verify(scope: Scope, assetId: string, version: number, token: string): boolean {
    return token === this.token(scope, assetId, version);
  }
  linkToken(scope: Scope, linkId: string): string {
    // Version -1 never names an asset file, so a link's token is never an asset path's.
    return this.token(scope, `link:${linkId}`, -1);
  }
  verifyLink(scope: Scope, linkId: string, token: string): boolean {
    return token === this.linkToken(scope, linkId);
  }
}

/**
 * A PasswordHasher without key stretching (`fake:<password reversed>`): tests check that a
 * password is hashed, never stored, and verified, without paying for PBKDF2.
 */
export class FakePasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return `fake:${[...password].reverse().join('')}`;
  }
  async verify(password: string, stored: string): Promise<boolean> {
    return stored === (await this.hash(password));
  }
}

/** An in-memory AssetGate (the media origin's KV gate), inspectable by tests. */
export class InMemoryAssetGate implements AssetGate {
  readonly entries = new Map<string, AssetGateEntry>();
  private key = (scope: Scope, id: string) => `${scope.spaceId}:${scope.environmentId}:${id}`;

  async get(scope: Scope, assetId: string) {
    return this.entries.get(this.key(scope, assetId)) ?? null;
  }
  async put(scope: Scope, assetId: string, entry: AssetGateEntry) {
    this.entries.set(this.key(scope, assetId), entry);
  }
  async delete(scope: Scope, assetId: string) {
    this.entries.delete(this.key(scope, assetId));
  }
  async deleteScope(scope: Scope) {
    // As the KV adapter: only keys with no ':' past the prefix (an environment id may hold one).
    const prefix = `${scope.spaceId}:${scope.environmentId}:`;
    for (const k of [...this.entries.keys()]) {
      if (k.startsWith(prefix) && !k.slice(prefix.length).includes(':')) this.entries.delete(k);
    }
  }
}

/**
 * An in-memory VideoHost. Uploads are "received" by the test calling
 * {@link FakeVideoHost.setVideo} — the stand-in for the host finishing an
 * encode — so status transitions are fully under the test's control.
 */
export class FakeVideoHost implements VideoHost {
  readonly provider = 'fake';
  readonly uploads: {
    videoId: string;
    maxDurationSeconds: number;
    meta?: Record<string, string>;
  }[] = [];
  readonly deleted: string[] = [];
  private readonly videos = new Map<string, HostedVideo>();
  private seq = 0;

  async createUpload(opts: {
    maxDurationSeconds: number;
    meta?: Readonly<Record<string, string>>;
  }): Promise<VideoUpload> {
    this.seq += 1;
    const videoId = `vid-${this.seq}`;
    this.uploads.push({
      videoId,
      maxDurationSeconds: opts.maxDurationSeconds,
      ...(opts.meta ? { meta: { ...opts.meta } } : {}),
    });
    this.videos.set(videoId, { videoId, status: 'pending' });
    return {
      videoId,
      uploadUrl: `https://upload.video.local/${videoId}`,
      method: 'POST',
      fileField: 'file',
    };
  }

  async getVideo(videoId: string) {
    return this.videos.get(videoId) ?? null;
  }

  async delete(videoId: string) {
    this.deleted.push(videoId);
    this.videos.delete(videoId);
  }

  /** Sets what the host reports for a video (merged over the current state). */
  setVideo(videoId: string, patch: Partial<HostedVideo>): void {
    const current: HostedVideo = this.videos.get(videoId) ?? { videoId, status: 'pending' };
    this.videos.set(videoId, { ...current, ...patch, videoId });
  }

  /** Simulates the host losing the video (deleted out-of-band). */
  forget(videoId: string): void {
    this.videos.delete(videoId);
  }
}

/**
 * An ImageProbe that reads the dimensions a test planted: `set(bytes, info)` keyed by the bytes'
 * text, so a test uploads a "file" and says what an image service would find in it. Anything else
 * is not an image (`null`). `failNext` makes the next call throw, for the retry path.
 */
export class FakeImageProbe implements ImageProbe {
  private readonly known = new Map<string, ImageInfo>();
  private readonly placeholders = new Map<string, AssetPlaceholder>();
  calls = 0;
  failNext = false;
  /** Calls to `placeholder`, and whether each one throws (the service failing). */
  placeholderCalls = 0;
  failPlaceholders = false;

  set(bytes: string, info: ImageInfo): void {
    this.known.set(bytes, info);
  }

  /** What `placeholder` finds in these bytes; anything else has none (`null`). */
  setPlaceholder(bytes: string, placeholder: AssetPlaceholder): void {
    this.placeholders.set(bytes, placeholder);
  }

  async placeholder(body: ByteStream): Promise<AssetPlaceholder | null> {
    this.placeholderCalls += 1;
    let text = '';
    for await (const chunk of body) text += asciiOf(chunk);
    if (this.failPlaceholders) throw new Error('image service unavailable');
    return this.placeholders.get(text) ?? null;
  }

  async info(body: ByteStream): Promise<ImageInfo | null> {
    this.calls += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('image service unavailable');
    }
    let text = '';
    for await (const chunk of body) text += asciiOf(chunk);
    return this.known.get(text) ?? null;
  }
}

/**
 * A TextExtractor for documents (`application/pdf`, office types) and audio: returns what a test
 * planted for the file name, or the file's bytes as text. Records every file it read.
 */
export class FakeTextExtractor implements TextExtractor {
  readonly read: ExtractableFile[] = [];
  private readonly texts = new Map<string, string>();

  setText(fileName: string, text: string): void {
    this.texts.set(fileName, text);
  }

  supports(contentType: string): boolean {
    return (
      contentType === 'application/pdf' ||
      contentType.startsWith('application/vnd.openxmlformats-officedocument.') ||
      contentType.startsWith('audio/')
    );
  }

  async extract(file: ExtractableFile): Promise<string> {
    this.read.push(file);
    return this.texts.get(file.fileName) ?? file.chunks.map(asciiOf).join('');
  }
}

/** An AssetIngestQueue that records what was handed to ingest. */
export class FakeAssetIngestQueue implements AssetIngestQueue {
  readonly created: { key: string; etag?: string }[] = [];
  readonly requested: AssetIngestRequest[] = [];

  async objectCreated(key: string, etag?: string): Promise<void> {
    this.created.push({ key, ...(etag ? { etag } : {}) });
  }

  async request(requests: readonly AssetIngestRequest[]): Promise<void> {
    this.requested.push(...requests);
  }
}

/**
 * An AssetIngestStarter with the Workflows binding's id semantics: a second start under an id
 * already used is not a second run. `started` lists the runs that did start.
 */
export class RecordingAssetIngestStarter implements AssetIngestStarter {
  readonly started: { instanceId: string; params: AssetIngestParams }[] = [];

  async start(instanceId: string, params: AssetIngestParams): Promise<boolean> {
    if (this.started.some((s) => s.instanceId === instanceId)) return false;
    this.started.push({ instanceId, params });
    return true;
  }
}

/** Bytes as text, one char per byte (exact for the ASCII the tests write). */
function asciiOf(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

/** An AssetZipStarter that records each start; a job id starts once, as Workflows' ids do. */
export class FakeAssetZipStarter implements AssetZipStarter {
  readonly started: AssetZipParams[] = [];
  async start(params: AssetZipParams): Promise<boolean> {
    if (this.started.some((p) => p.jobId === params.jobId)) return false;
    this.started.push(params);
    return true;
  }
}
