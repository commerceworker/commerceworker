import { z } from 'zod';
import { asset } from './assets';

export const multipartUpload = z.object({
  asset,
  upload: z.object({
    uploadId: z.string(),
    partSize: z.int().describe('Every part but the last has exactly this many bytes'),
    partCount: z.int(),
  }),
});

export const multipartReplacement = multipartUpload.extend({
  version: z.int().describe('The version completing the upload makes current'),
});

export const signedParts = z.object({
  parts: z.array(
    z.object({
      partNumber: z.int(),
      url: z
        .string()
        .describe('PUT exactly `length` bytes here; the response’s ETag names the part'),
      length: z.int(),
      expiresAt: z.iso.datetime(),
    }),
  ),
});
