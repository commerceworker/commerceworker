import { z } from 'zod';

export const releaseList = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      description: z.string().optional(),
      status: z.enum(['open', 'published', 'archived']),
      createdAt: z.iso.datetime(),
      publishedAt: z.iso.datetime().optional(),
      itemCount: z.int().describe('Members (entries) in the release, from one grouped count'),
    }),
  ),
});
