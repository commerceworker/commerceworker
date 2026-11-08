import {
  EMBED_PROVIDERS,
  type EmbedData,
  embedFromOEmbed,
  matchEmbedProvider,
  ValidationError,
} from '@commerceworker/domain';
import type { RemoteFetcher } from '@commerceworker/ports';
import { assertSafeExternalUrl } from './url-safety';

/** The largest oEmbed answer read. Real ones are a few kilobytes, most of it the `html` we drop. */
export const MAX_OEMBED_BYTES = 64 * 1024;
/** How long a provider gets to answer: someone is waiting, in the editor, on a paste. */
export const OEMBED_TIMEOUT_MS = 5_000;

export interface ResolvedEmbed {
  /** The embed node's `data`: always valid, whether or not the provider answered. */
  readonly embed: EmbedData;
  /**
   * Whether the provider answered with metadata. `false` (it was down, slow,
   * refused the URL, or sent something that is not oEmbed) still returns a
   * storable embed holding only the URL, its provider and kind.
   */
  readonly resolved: boolean;
}

/**
 * Resolves a media URL to the structured data of an `embed` node, by asking
 * its provider's oEmbed endpoint for the title, author, thumbnail and size.
 *
 * Only the fields an embed stores are kept: the provider's `html` (its player
 * markup and script) is never returned, so no caller — the editor, an import,
 * an agent — can end up storing it.
 *
 * A URL that is not https or not on an allowed provider is refused, and so is
 * an oEmbed endpoint that is not a public address (a Mastodon URL names its
 * own host, so that endpoint is the caller's choice). The fetch is bounded in
 * size and time and does not follow redirects. A provider that fails to answer
 * is not an error: the embed is valid with its URL alone.
 *
 * Reads and writes nothing in a space, so it takes no `Scope`; the surfaces
 * authorize the caller against the space they name, as for any content write.
 */
export async function resolveEmbed(
  fetcher: RemoteFetcher,
  input: { readonly url: string },
): Promise<ResolvedEmbed> {
  const match = matchEmbedProvider(input.url);
  if (!match) {
    throw new ValidationError([
      {
        field: 'url',
        message: `must be an https URL from an allowed embed provider (${EMBED_PROVIDERS.map((p) => p.name).join(', ')})`,
      },
    ]);
  }
  const endpoint = match.provider.oembedUrl(match.url);
  assertSafeExternalUrl(match.url.href, 'url');
  assertSafeExternalUrl(endpoint, 'url');

  const bare: ResolvedEmbed = { embed: embedFromOEmbed(match, undefined), resolved: false };
  let body: string;
  try {
    const doc = await fetcher.get(endpoint, {
      maxBytes: MAX_OEMBED_BYTES,
      timeoutMs: OEMBED_TIMEOUT_MS,
    });
    // 3xx included: the fetcher does not follow redirects, and a redirect is
    // a host nothing screened.
    if (doc.status < 200 || doc.status >= 300) return bare;
    body = doc.body;
  } catch {
    return bare;
  }
  let answer: unknown;
  try {
    answer = JSON.parse(body);
  } catch {
    return bare;
  }
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return bare;
  return { embed: embedFromOEmbed(match, answer), resolved: true };
}
