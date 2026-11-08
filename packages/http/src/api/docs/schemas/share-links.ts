import { z } from 'zod';

export const shareLink = z.object({
  id: z.uuid(),
  targetType: z.enum(['asset', 'collection']),
  targetId: z.string(),
  expiresAt: z.iso.datetime(),
  allowDownload: z.boolean(),
  hasPassword: z.boolean(),
  createdAt: z.iso.datetime(),
  createdBy: z.string().optional(),
  revokedAt: z.iso.datetime().optional(),
  url: z
    .string()
    .optional()
    .describe('The link to hand out, on the media origin (absent without MEDIA_PUBLIC_URL)'),
});

export const shareLinkList = z.object({ items: z.array(shareLink) });
