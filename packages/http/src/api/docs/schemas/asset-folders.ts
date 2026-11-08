import { z } from 'zod';

export const assetFolder = z.object({
  id: z.uuid(),
  name: z.string(),
  parentId: z.string().optional().describe('Absent at the root'),
  path: z.string().describe('Materialized path of folder ids, e.g. /a/b/'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const assetFolderList = z.object({ items: z.array(assetFolder) });

export const assetMoved = z.object({
  moved: z.int().describe('How many of the ids were assets here and were filed'),
});
