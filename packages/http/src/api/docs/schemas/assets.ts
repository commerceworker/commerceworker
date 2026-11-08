import { z } from 'zod';

export const assetPlaceholder = z
  .object({
    thumbhash: z
      .string()
      .describe('ThumbHash of the image (base64): decode it on the client to a blurred preview'),
    dominantColor: z.string().describe('The image’s dominant colour, #rrggbb'),
  })
  .describe('What to show while a raster image loads, computed by ingest');

export const assetVideo = z
  .object({
    provider: z.string().describe('The video host that owns the bytes, e.g. stream'),
    videoId: z.string().describe('The host’s id for the video'),
    status: z.enum(['pending', 'processing', 'ready', 'error']),
    hlsUrl: z.string().optional(),
    dashUrl: z.string().optional(),
    thumbnailUrl: z.string().optional().describe('Poster frame'),
    durationSeconds: z.number().optional(),
    errorReason: z.string().optional().describe('Why processing failed, while status is error'),
  })
  .describe('A video hosted by the video service: it plays from these URLs, not file.url');

export const assetFile = z.object({
  url: z.string().describe('A short-lived signed read URL'),
  fileName: z.string(),
  contentType: z.string().describe('MIME type'),
  size: z.int().optional(),
  width: z.int().optional(),
  height: z.int().optional(),
  placeholder: assetPlaceholder.optional().describe('Absent until ingest has computed one'),
  video: assetVideo.optional().describe('Present on a hosted video'),
});

export const assetMetadata = z.object({
  altText: z.record(z.string(), z.unknown()).describe('Alt text per locale'),
  tags: z.array(z.string()).describe('Taxonomy tag ids'),
  focalPoint: z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe('0..1 on each axis; crops are anchored here'),
  fields: z.record(z.string(), z.unknown()).optional().describe('Free-form custom values'),
});

export const asset = z.object({
  id: z.uuid(),
  status: z.enum(['draft', 'published', 'archived']),
  file: assetFile,
  title: z.record(z.string(), z.unknown()),
  description: z.record(z.string(), z.unknown()),
  metadata: assetMetadata,
  folderId: z.string().optional().describe('The folder it is filed in; absent at the root'),
  version: z.int().optional(),
  createdAt: z.iso.datetime().optional(),
  createdBy: z.string().optional(),
  archivedAt: z.iso.datetime().optional(),
  rights: z
    .object({
      license: z.string().optional(),
      credit: z.string().optional(),
      expiresAt: z.iso.datetime().optional(),
      embargoUntil: z.iso.datetime().optional(),
    })
    .optional(),
  contentHash: z.string().optional().describe('SHA-256 of the bytes (hex), once ingested'),
  ingestStatus: z
    .enum(['pending', 'processing', 'ready', 'error'])
    .optional()
    .describe('Where ingest stands on the current file; absent when it never ran'),
  ingestError: z.string().optional().describe('Why the last ingest failed'),
  duplicateOf: z
    .string()
    .optional()
    .describe('The oldest other asset here with the same bytes (a warning, not a block)'),
  aiSuggestions: z
    .object({
      altText: z.array(z.string()).optional().describe('Locales whose alt text a model wrote'),
      tags: z.array(z.string()).optional().describe('Tag ids a model chose'),
    })
    .optional()
    .describe('What ingest filled from a model that no person has saved yet'),
});

const assetFacets = z
  .object({
    kind: z.record(z.string(), z.int()),
    tag: z.record(z.string(), z.int()).describe('By tag id'),
    folder: z.record(z.string(), z.int()).describe('By folder id; root for assets in no folder'),
  })
  .describe('Matches per value, each counted with the other filters but not its own');

export const assetSearchPage = z.object({
  items: z.array(asset).describe('Best match first'),
  total: z.int().describe('Matches after the filters'),
  facets: assetFacets,
});

export const assetReindex = z.object({
  assets: z.int().describe('Assets sent through ingest'),
  job: z
    .looseObject({ id: z.string(), status: z.string(), totalItems: z.int() })
    .optional()
    .describe('The bulk job (GET /bulk/jobs/{id}); absent when there was nothing to do'),
  running: z
    .literal(true)
    .optional()
    .describe('Set when job is a reindex that was already running, not a new one'),
});

export const assetPage = z.object({
  items: z.array(asset),
  nextCursor: z
    .string()
    .optional()
    .describe('Pass as ?cursor= for the next page; absent on the last page'),
});

const localizedText = z
  .union([z.string(), z.record(z.string(), z.unknown()), z.null()])
  .describe('One locale’s value with ?locale=, else the value per locale');

export const deliveredAsset = z.object({
  id: z.string(),
  title: localizedText,
  description: localizedText,
  altText: localizedText,
  focalPoint: z.object({ x: z.number(), y: z.number() }).nullable(),
  contentType: z.string().describe('MIME type'),
  size: z.int().nullable(),
  width: z.int().nullable(),
  height: z.int().nullable(),
  kind: z.enum(['image', 'video', 'audio', 'document', 'other']),
  url: z.string().describe('The original file on the media origin (a video’s HLS manifest)'),
  renditions: z
    .record(z.string(), z.string())
    .describe('The space’s renditions of this image, by name'),
  srcset: z
    .array(z.object({ width: z.int(), url: z.string() }))
    .describe('The width ladder (320–2560), up to the image’s own width'),
  placeholder: assetPlaceholder
    .nullable()
    .describe('A raster image’s ThumbHash and dominant colour; null until ingest computed them'),
  video: z
    .object({
      status: z.string(),
      hlsUrl: z.string().optional(),
      dashUrl: z.string().optional(),
      thumbnailUrl: z.string().optional(),
      durationSeconds: z.number().optional(),
    })
    .optional(),
  rights: z.object({ credit: z.string().optional(), license: z.string().optional() }).optional(),
  file: z
    .record(z.string(), z.unknown())
    .describe('The stored file description, kept for existing readers; file.url is url'),
});

export const deliveredAssetPage = z.object({
  items: z.array(deliveredAsset),
  total: z.int().describe('Items on this page'),
  nextCursor: z
    .string()
    .optional()
    .describe('Pass as ?cursor= for the next page; absent on the last page'),
});

export const deliveredAssetSearchPage = z.object({
  items: z.array(deliveredAsset).describe('Best match first'),
  total: z.int().describe('Matches after the filters'),
  facets: assetFacets,
});

export const assetUsage = z.object({
  items: z.array(
    z.object({
      fromEntryId: z.string(),
      fromField: z.string(),
      toId: z.string(),
      toType: z.enum(['Entry', 'Asset']),
    }),
  ),
});

const imageTransform = z.object({
  width: z.int().optional(),
  height: z.int().optional(),
  fit: z.enum(['clip', 'crop', 'fill', 'max', 'scale']).optional(),
  format: z.enum(['auto', 'jpg', 'png', 'webp', 'avif']).optional(),
  quality: z.int().optional(),
});

export const transformedImage = z.object({
  url: z.string().describe('The transformed image'),
  transform: imageTransform.describe('The transform it applies'),
});

const aiUsage = z
  .object({ inputTokens: z.int(), outputTokens: z.int() })
  .describe('Tokens the model run used');

export const altTextResult = z.object({
  altText: z.string(),
  locale: z.string(),
  applied: z.boolean().describe('Saved on the asset’s metadata (apply: true)'),
  usage: aiUsage,
});

export const autoTagResult = z.object({
  tagIds: z.array(z.string()).describe('Existing tags the model chose'),
  newTags: z.array(z.string()).describe('New tag names it suggests'),
  applied: z.boolean().describe('Created and set on the asset (apply: true)'),
  usage: aiUsage,
});

export const uploadTicket = z.object({
  asset,
  upload: z.object({
    url: z
      .string()
      .describe(
        'Signed PUT URL — upload bytes directly here (root-relative when the deployment has no MEDIA_BASE_URL)',
      ),
    headers: z.record(z.string(), z.string()),
  }),
});

export const assetFileReplacement = z.object({
  asset,
  upload: z.object({
    url: z.string().describe('Signed PUT URL for the new file (expires); upload the bytes here'),
    headers: z.record(z.string(), z.string()),
  }),
  commit: z
    .object({
      version: z.int(),
      fileName: z.string(),
      contentType: z.string(),
      attempt: z.string().describe('This replace start’s own id, in its upload’s key'),
    })
    .describe('POST this to /assets/{id}/file/commit once the bytes are uploaded'),
});

export const assetVersionList = z.object({
  items: z.array(
    z.object({
      version: z.int(),
      file: assetFile.describe('file.url is a short-lived signed read URL'),
      contentHash: z.string().optional(),
      createdAt: z.iso.datetime().optional().describe('When this file became the asset’s'),
      createdBy: z.string().optional(),
      current: z.boolean(),
      published: z.boolean().describe('The file Delivery serves now'),
      restoredFrom: z
        .int()
        .optional()
        .describe('For a restore: the earliest version with the same file'),
    }),
  ),
});

export const assetBulkJob = z.looseObject({
  id: z.string(),
  action: z.enum(['asset_move', 'asset_tag', 'asset_publish', 'asset_unpublish', 'asset_archive']),
  status: z.enum(['running', 'completed', 'cancelled']),
  totalItems: z.int(),
  totalChunks: z.int(),
  completedChunks: z.int(),
  succeeded: z.int(),
  failed: z.int(),
});

export const videoUploadTicket = z.object({
  asset,
  upload: z.object({
    videoId: z.string().describe("The video host's id for the upload"),
    uploadUrl: z.url().describe('One-time direct upload URL on the video host'),
    method: z.literal('POST'),
    fileField: z.string().describe('Multipart form field carrying the file'),
  }),
});
