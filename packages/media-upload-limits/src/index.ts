/**
 * Canonical limits for tenant media gallery uploads (images in R2).
 *
 * - Admin UI should use these for `accept` / `maxSize` on dropzones.
 * - **admin-worker** `POST /admin/api/media/upload` must enforce the same set.
 * - **media-worker** `PUT /media/upload/*` uses wrangler `ALLOWED_MIME_TYPES` and
 *   `MAX_UPLOAD_SIZE_MB` — keep those strings equal to {@link ALLOWED_IMAGE_MIME_TYPES_CSV}
 *   and {@link MAX_UPLOAD_SIZE_MB}. Magic-byte checks remain media-worker-only.
 */
export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
] as const;

export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

export const ALLOWED_IMAGE_MIME_TYPES_CSV = ALLOWED_IMAGE_MIME_TYPES.join(',');

export const MAX_UPLOAD_SIZE_MB = 50;

export const MAX_UPLOAD_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;

export function isAllowedImageMimeType(type: string): boolean {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(type);
}

/** Shape compatible with react-dropzone `accept` for gallery image uploads. */
export function galleryDropzoneAccept(): Record<string, string[]> {
  return Object.fromEntries(ALLOWED_IMAGE_MIME_TYPES.map((m) => [m, [] as string[]]));
}
