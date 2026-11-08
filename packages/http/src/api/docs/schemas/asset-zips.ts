import { z } from 'zod';

export const assetZip = z.object({
  id: z.uuid(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  source: z.union([
    z.object({ kind: z.literal('selection'), assetIds: z.array(z.string()) }),
    z.object({ kind: z.literal('collection'), collectionId: z.string() }),
  ]),
  fileName: z.string(),
  fileCount: z.int().optional(),
  totalBytes: z.int().optional(),
  partsDone: z.int(),
  partCount: z.int().optional(),
  error: z.string().optional(),
  createdAt: z.iso.datetime(),
  createdBy: z.string().optional(),
  completedAt: z.iso.datetime().optional(),
  expiresAt: z.iso.datetime().describe('The archive is removed then'),
  downloadUrl: z
    .string()
    .optional()
    .describe(
      'Once completed: a signed URL that works for 15 minutes (get the job again for another)',
    ),
});

export const assetZipList = z.object({ items: z.array(assetZip) });
