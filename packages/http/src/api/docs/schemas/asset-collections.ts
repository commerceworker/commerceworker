import { z } from 'zod';
import { deliveredAsset } from './assets';

export const assetCollection = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().optional(),
  itemCount: z.int().describe('Assets in it, of every status'),
  createdAt: z.iso.datetime(),
  createdBy: z.string().optional(),
  updatedAt: z.iso.datetime(),
});

export const assetCollectionPage = z.object({
  items: z.array(assetCollection),
  nextCursor: z.string().optional(),
});

export const collectionAdded = z.object({
  added: z.int().describe('Assets added (members already in it are left where they are)'),
  skipped: z.array(z.string()).describe('Ids that are not assets in this environment'),
});

export const collectionRemoved = z.object({ removed: z.int() });

export const deliveredCollection = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  items: z.array(deliveredAsset).describe('Published members, in the collection’s order'),
  nextCursor: z.string().optional(),
});
