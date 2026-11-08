/**
 * External media in rich text: a video, a social post, a track, held as an
 * `embed` block whose `data` is structured metadata, never the provider's
 * markup.
 *
 * A provider's oEmbed answer carries an `html` snippet (an `<iframe>`, a
 * `<blockquote>` and a `<script>`). Storing it would put someone else's script
 * into every channel that renders the document, and freeze one provider's
 * player markup into content that outlives it. So an embed stores the URL, the
 * provider it belongs to and what a renderer needs to lay it out (title,
 * author, thumbnail, size); each channel builds its own player, or a link card,
 * from that.
 *
 * Only vetted providers are accepted: an embed is a URL a renderer will load,
 * and a URL from anywhere is a tracking pixel or a phishing frame waiting for a
 * renderer that trusts it. The allowlist is code, so adding a provider is a
 * reviewed change.
 */

/** What an embed is, for a renderer choosing a player or a card. */
export const EMBED_KINDS = ['video', 'post', 'audio', 'other'] as const;
export type EmbedKind = (typeof EMBED_KINDS)[number];

/** The structured data of an `embed` node. Everything but `url` and `provider` is optional. */
export interface EmbedData {
  /** The page URL of the media, https, on an allowed provider. */
  readonly url: string;
  /** The allowed provider `url` belongs to (`EMBED_PROVIDERS[].id`). */
  readonly provider: string;
  readonly kind?: EmbedKind;
  readonly title?: string;
  readonly authorName?: string;
  readonly thumbnail?: {
    readonly url: string;
    readonly width?: number;
    readonly height?: number;
  };
  /** The provider's suggested player size, in CSS pixels. */
  readonly width?: number;
  readonly height?: number;
  /** Width over height, so a renderer can reserve the player's box before it loads. */
  readonly aspectRatio?: number;
}

/**
 * A parsed URL: the part of the WHATWG `URL` this module reads. Every runtime
 * the domain runs on (Node, workerd, browsers) provides that parser, but the
 * domain's ES-only lib does not declare it, and a hand-rolled parser that
 * disagreed with the one a fetcher uses is how an allowlist gets bypassed.
 */
export interface EmbedUrl {
  readonly href: string;
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly searchParams: { get(name: string): string | null };
}
declare const URL: new (input: string) => EmbedUrl;

/** `raw` parsed as an absolute URL (any scheme), or `undefined` when it is not one. */
export function parseAbsoluteUrl(raw: string): EmbedUrl | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/** A provider an embed may come from. */
export interface EmbedProvider {
  /** Stored in `data.provider`; never renamed once shipped. */
  readonly id: string;
  /** Shown to people. */
  readonly name: string;
  readonly kind: EmbedKind;
  /** Whether `url` is a page of this provider's that it can embed. */
  readonly matches: (url: EmbedUrl) => boolean;
  /** The provider's oEmbed endpoint asked about `url`. */
  readonly oembedUrl: (url: EmbedUrl) => string;
}

const hostIs =
  (...hosts: string[]) =>
  (url: EmbedUrl): boolean =>
    hosts.includes(url.hostname);

const oembed = (endpoint: string) => (url: EmbedUrl) =>
  `${endpoint}${endpoint.includes('?') ? '&' : '?'}url=${encodeURIComponent(url.href)}`;

const YOUTUBE_ID = /^[\w-]{11}$/;

/** Hosts the named providers own, which the Mastodon URL shape must not claim. */
const NAMED_PROVIDER_HOSTS: ReadonlySet<string> = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
  'vimeo.com',
  'www.vimeo.com',
  'player.vimeo.com',
  'x.com',
  'www.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'bsky.app',
  'open.spotify.com',
  'soundcloud.com',
  'www.soundcloud.com',
  'm.soundcloud.com',
]);

/** A host name that names something: dotted, and not an IP literal. */
const isDomainName = (host: string): boolean =>
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(host);

/**
 * The vetted providers, in matching order. Mastodon comes last: it is matched
 * by URL shape on any host, because instances are many and federated, and the
 * named providers' URLs must win before that shape is tried.
 */
export const EMBED_PROVIDERS: readonly EmbedProvider[] = [
  {
    id: 'youtube',
    name: 'YouTube',
    kind: 'video',
    matches: (url) => {
      if (url.hostname === 'youtu.be') return YOUTUBE_ID.test(url.pathname.slice(1));
      if (url.hostname === 'www.youtube-nocookie.com') {
        return YOUTUBE_ID.test(/^\/embed\/([^/]+)$/.exec(url.pathname)?.[1] ?? '');
      }
      if (!hostIs('youtube.com', 'www.youtube.com', 'm.youtube.com')(url)) return false;
      if (url.pathname === '/watch') return YOUTUBE_ID.test(url.searchParams.get('v') ?? '');
      return YOUTUBE_ID.test(/^\/(?:shorts|embed|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? '');
    },
    oembedUrl: oembed('https://www.youtube.com/oembed?format=json'),
  },
  {
    id: 'vimeo',
    name: 'Vimeo',
    kind: 'video',
    matches: (url) =>
      (hostIs('vimeo.com', 'www.vimeo.com')(url) &&
        /^\/(?:channels\/[\w-]+\/|groups\/[\w-]+\/videos\/)?\d+(?:\/[0-9a-f]+)?\/?$/.test(
          url.pathname,
        )) ||
      (url.hostname === 'player.vimeo.com' && /^\/video\/\d+\/?$/.test(url.pathname)),
    oembedUrl: oembed('https://vimeo.com/api/oembed.json'),
  },
  {
    id: 'x',
    name: 'X',
    kind: 'post',
    matches: (url) =>
      hostIs('x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com')(url) &&
      /^\/(?:\w{1,15}|i\/web)\/status\/\d+\/?$/.test(url.pathname),
    oembedUrl: oembed('https://publish.twitter.com/oembed?omit_script=true&dnt=true'),
  },
  {
    id: 'bluesky',
    name: 'Bluesky',
    kind: 'post',
    matches: (url) =>
      url.hostname === 'bsky.app' &&
      /^\/profile\/(?:did:[a-z]+:[\w.:%-]+|[a-z0-9.-]+)\/post\/[\w~.:-]{1,64}\/?$/i.test(
        url.pathname,
      ),
    oembedUrl: oembed('https://embed.bsky.app/oembed?format=json'),
  },
  {
    id: 'spotify',
    name: 'Spotify',
    kind: 'audio',
    matches: (url) =>
      url.hostname === 'open.spotify.com' &&
      /^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(?:embed\/)?(?:track|album|playlist|episode|show|artist|audiobook)\/[A-Za-z0-9]{22}\/?$/.test(
        url.pathname,
      ),
    oembedUrl: oembed('https://open.spotify.com/oembed'),
  },
  {
    id: 'soundcloud',
    name: 'SoundCloud',
    kind: 'audio',
    matches: (url) =>
      hostIs('soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com')(url) &&
      /^\/[\w-]+\/(?:sets\/)?[\w-]+\/?$/.test(url.pathname),
    oembedUrl: oembed('https://soundcloud.com/oembed?format=json'),
  },
  {
    // `/@user/123`, `/@user@other.host/123` (a remote account seen from this
    // instance) and the ActivityPub form `/users/user/statuses/123`. Every
    // instance answers oEmbed at the same path.
    //
    // The host is the author's choice: any public domain with this shape
    // passes. So a `mastodon` embed vouches for its shape, not its origin, and
    // a channel must not frame `<url>/embed` without its own list of trusted
    // instances; the link card is always safe. A host one of the named
    // providers owns is never Mastodon.
    id: 'mastodon',
    name: 'Mastodon',
    kind: 'post',
    matches: (url) =>
      isDomainName(url.hostname) &&
      !NAMED_PROVIDER_HOSTS.has(url.hostname) &&
      /^\/(?:@\w+(?:@[a-z0-9.-]+)?|users\/\w+\/statuses)\/\d+\/?$/i.test(url.pathname),
    oembedUrl: (url) => oembed(`https://${url.hostname}/api/oembed?format=json`)(url),
  },
];

/** The longest URL an embed may hold; a page link past this is not a page link. */
export const MAX_EMBED_URL_LENGTH = 2048;
/** The longest title or author name kept. */
export const MAX_EMBED_TEXT_LENGTH = 500;
/** The largest pixel size kept for a player or thumbnail. */
const MAX_EMBED_PIXELS = 10_000;

/**
 * The https URL `raw` parses to, if it is one an embed may point at: no
 * credentials, no port, nothing but `https:`.
 */
function parseEmbedUrl(raw: string): EmbedUrl | undefined {
  if (raw.length > MAX_EMBED_URL_LENGTH) return undefined;
  const url = parseAbsoluteUrl(raw.trim());
  if (url?.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
  return url;
}

/** The allowed provider `raw` belongs to, with the parsed URL; `undefined` when none does. */
export function matchEmbedProvider(
  raw: string,
  providers: readonly EmbedProvider[] = EMBED_PROVIDERS,
): { readonly provider: EmbedProvider; readonly url: EmbedUrl } | undefined {
  const url = parseEmbedUrl(raw);
  if (!url) return undefined;
  const provider = providers.find((p) => p.matches(url));
  return provider ? { provider, url } : undefined;
}

const EMBED_DATA_KEYS: ReadonlySet<string> = new Set([
  'url',
  'provider',
  'kind',
  'title',
  'authorName',
  'thumbnail',
  'width',
  'height',
  'aspectRatio',
]);

const isPixels = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_EMBED_PIXELS;

const isHttpsUrl = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= MAX_EMBED_URL_LENGTH && parseEmbedUrl(v) !== undefined;

/**
 * Problems with an `embed` node's `data`, each prefixed `data.` (empty when
 * valid). Unknown keys are refused rather than ignored, so nothing (an `html`
 * snippet least of all) rides along in a stored embed unchecked.
 */
export function embedDataIssues(data: Readonly<Record<string, unknown>> | undefined): string[] {
  if (!data) return ['embed requires data { url, provider }'];
  const issues: string[] = [];
  for (const key of Object.keys(data)) {
    if (!EMBED_DATA_KEYS.has(key)) issues.push(`embed data.${key} is not allowed`);
  }
  const match = typeof data.url === 'string' ? matchEmbedProvider(data.url) : undefined;
  if (!match) {
    issues.push(
      `embed requires data.url, an https URL from an allowed provider (${EMBED_PROVIDERS.map((p) => p.name).join(', ')})`,
    );
  } else if (data.provider !== match.provider.id) {
    issues.push(`embed data.provider must be "${match.provider.id}" for this URL`);
  }
  if (data.kind !== undefined && !(EMBED_KINDS as readonly unknown[]).includes(data.kind)) {
    issues.push(`embed data.kind must be one of ${EMBED_KINDS.join(', ')}`);
  }
  for (const key of ['title', 'authorName'] as const) {
    const value = data[key];
    if (
      value !== undefined &&
      (typeof value !== 'string' || value.length > MAX_EMBED_TEXT_LENGTH)
    ) {
      issues.push(`embed data.${key} must be a string of at most ${MAX_EMBED_TEXT_LENGTH}`);
    }
  }
  for (const key of ['width', 'height'] as const) {
    if (data[key] !== undefined && !isPixels(data[key])) {
      issues.push(`embed data.${key} must be an integer from 1 to ${MAX_EMBED_PIXELS}`);
    }
  }
  const ratio = data.aspectRatio;
  if (
    ratio !== undefined &&
    !(typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 && ratio <= 100)
  ) {
    issues.push('embed data.aspectRatio must be a positive number (width / height)');
  }
  const thumbnail = data.thumbnail;
  if (thumbnail !== undefined) {
    const t = thumbnail as Record<string, unknown>;
    const shapeOk =
      typeof t === 'object' &&
      t !== null &&
      !Array.isArray(t) &&
      Object.keys(t).every((k) => k === 'url' || k === 'width' || k === 'height') &&
      isHttpsUrl(t.url) &&
      (t.width === undefined || isPixels(t.width)) &&
      (t.height === undefined || isPixels(t.height));
    if (!shapeOk) issues.push('embed data.thumbnail must be { url (https), width?, height? }');
  }
  return issues;
}

/** A string worth keeping from an untrusted answer: trimmed, non-empty, capped. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, MAX_EMBED_TEXT_LENGTH) : undefined;
}

/** A pixel size from an untrusted answer, which may send `"315"`, `315.0` or `null`. */
function pixels(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n)
    ? isPixels(Math.round(n))
      ? Math.round(n)
      : undefined
    : undefined;
}

/**
 * Embed data for `url` from a provider's oEmbed answer. Only the fields an
 * embed stores are read; the rest, `html` above all, is never looked at.
 * Whatever the answer holds that is malformed is left out, so the result
 * always validates.
 */
export function embedFromOEmbed(
  match: { readonly provider: EmbedProvider; readonly url: EmbedUrl },
  answer: unknown,
): EmbedData {
  const base: EmbedData = {
    url: match.url.href,
    provider: match.provider.id,
    kind: match.provider.kind,
  };
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return base;
  const a = answer as Record<string, unknown>;
  const title = text(a.title);
  const authorName = text(a.author_name);
  const width = pixels(a.width);
  const height = pixels(a.height);
  const thumbnailUrl = isHttpsUrl(a.thumbnail_url) ? a.thumbnail_url : undefined;
  const thumbnailWidth = pixels(a.thumbnail_width);
  const thumbnailHeight = pixels(a.thumbnail_height);
  return {
    ...base,
    ...(title ? { title } : {}),
    ...(authorName ? { authorName } : {}),
    ...(thumbnailUrl
      ? {
          thumbnail: {
            url: thumbnailUrl,
            ...(thumbnailWidth ? { width: thumbnailWidth } : {}),
            ...(thumbnailHeight ? { height: thumbnailHeight } : {}),
          },
        }
      : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(width && height ? { aspectRatio: Math.round((width / height) * 10_000) / 10_000 } : {}),
  };
}
