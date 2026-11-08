import { z } from 'zod';

/** An `embed` rich-text node's `data`: structured metadata, never the provider's markup. */
export const embedData = z
  .object({
    url: z.string().describe('https page URL on an allowed provider'),
    provider: z
      .string()
      .describe('Allowed provider id: youtube, vimeo, x, bluesky, spotify, soundcloud or mastodon'),
    kind: z.enum(['video', 'post', 'audio', 'other']).optional(),
    title: z.string().optional(),
    authorName: z.string().optional(),
    thumbnail: z
      .object({ url: z.string(), width: z.int().optional(), height: z.int().optional() })
      .optional(),
    width: z.int().optional().describe("Provider's suggested player width, CSS pixels"),
    height: z.int().optional(),
    aspectRatio: z.number().optional().describe('width / height'),
  })
  .describe('Data of an `embed` rich-text node');

export const resolvedEmbed = z.object({
  embed: embedData,
  resolved: z
    .boolean()
    .describe(
      'Whether the provider answered with metadata; when false, `embed` holds only url, provider and kind (still valid to store)',
    ),
});
