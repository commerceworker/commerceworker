import { z } from 'zod';

export const assetRendition = z.object({
  name: z.string().describe('Its URL segment: …/r-<name>/…'),
  width: z.int().optional(),
  height: z.int().optional(),
  fit: z.enum(['clip', 'crop', 'fill', 'max', 'scale']).optional(),
  format: z.enum(['auto', 'jpg', 'png', 'webp', 'avif']).optional(),
  quality: z.int().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const assetRenditionList = z.object({ items: z.array(assetRendition) });
