/**
 * External media in rich text. An `embed` node holds structured metadata about a video, a post or
 * a track (its page URL, provider, title, thumbnail, size), never the provider's HTML: each
 * channel decides how to show it. `embedCard` gives the safe default, a link card; a front end
 * that wants a player builds one for `provider` from `url` (see the docs' rich text guide). A
 * `mastodon` embed's host is the author's choice: frame only instances you trust.
 */

/** What an embed is, for choosing a player or a card. */
export type EmbedKind = 'video' | 'post' | 'audio' | 'other';

/** The data of an `embed` rich-text node, as Delivery returns it. */
export interface EmbedData {
  /** The media's https page URL, on an allowed provider. */
  readonly url: string;
  /** `youtube`, `vimeo`, `x`, `bluesky`, `spotify`, `soundcloud` or `mastodon` (more may come). */
  readonly provider: string;
  readonly kind?: EmbedKind;
  readonly title?: string;
  readonly authorName?: string;
  readonly thumbnail?: { readonly url: string; readonly width?: number; readonly height?: number };
  /** The provider's suggested player size, in CSS pixels. */
  readonly width?: number;
  readonly height?: number;
  /** Width over height: reserve the player's box before it loads. */
  readonly aspectRatio?: number;
}

/** A link card for an embed: everything a framework needs to render `<a><img>title</a>`. */
export interface EmbedCard {
  /** The media's page; open it in a new tab with `rel="noopener noreferrer"`. */
  readonly href: string;
  /** The title, else the URL without its scheme. */
  readonly title: string;
  /** The provider's display name (`YouTube`), or its id when this SDK doesn't know it yet. */
  readonly providerName: string;
  readonly provider: string;
  readonly kind: EmbedKind;
  readonly authorName?: string;
  /** `<img>` attributes for the thumbnail, when the provider gave one. */
  readonly thumbnail?: {
    readonly src: string;
    readonly width?: number;
    readonly height?: number;
    readonly alt: '';
    readonly loading: 'lazy';
    readonly decoding: 'async';
    readonly referrerPolicy: 'no-referrer';
  };
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  youtube: 'YouTube',
  vimeo: 'Vimeo',
  x: 'X',
  bluesky: 'Bluesky',
  spotify: 'Spotify',
  soundcloud: 'SoundCloud',
  mastodon: 'Mastodon',
};

const KINDS: readonly string[] = ['video', 'post', 'audio', 'other'];

/** `raw` if it is an absolute https URL, else `undefined`: nothing else is safe to link or load. */
function httpsUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    return new URL(raw).protocol === 'https:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

const size = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;

/**
 * The link card for a rich-text node, or `undefined` when it is not an `embed` or its URL is not
 * https (the server never stores one, but a renderer should not trust that blindly). The
 * thumbnail is lazy, decorative (the title is the link's text) and loaded without a referrer.
 *
 * ```ts
 * const card = embedCard(node);
 * if (card) html`<a href=${card.href} target="_blank" rel="noopener noreferrer">${card.title}</a>`;
 * ```
 */
export function embedCard(node: {
  readonly nodeType: string;
  readonly data?: unknown;
}): EmbedCard | undefined {
  if (node.nodeType !== 'embed' || typeof node.data !== 'object' || node.data === null) {
    return undefined;
  }
  const data = node.data as Partial<Record<keyof EmbedData, unknown>>;
  const href = httpsUrl(data.url);
  if (!href) return undefined;
  const provider = typeof data.provider === 'string' ? data.provider : '';
  const title =
    typeof data.title === 'string' && data.title.trim()
      ? data.title.trim()
      : href.replace(/^https:\/\//, '');
  const thumb = (data.thumbnail ?? {}) as Partial<Record<'url' | 'width' | 'height', unknown>>;
  const src = httpsUrl(thumb.url);
  const width = size(thumb.width);
  const height = size(thumb.height);
  return {
    href,
    title,
    provider,
    providerName: (Object.hasOwn(PROVIDER_NAMES, provider) && PROVIDER_NAMES[provider]) || provider,
    kind: KINDS.includes(data.kind as string) ? (data.kind as EmbedKind) : 'other',
    ...(typeof data.authorName === 'string' && data.authorName.trim()
      ? { authorName: data.authorName.trim() }
      : {}),
    ...(src
      ? {
          thumbnail: {
            src,
            ...(width ? { width } : {}),
            ...(height ? { height } : {}),
            alt: '' as const,
            loading: 'lazy' as const,
            decoding: 'async' as const,
            referrerPolicy: 'no-referrer' as const,
          },
        }
      : {}),
  };
}
