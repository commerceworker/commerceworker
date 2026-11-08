import { describe, expect, it } from 'vitest';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_IMAGE_MIME_TYPES_CSV,
  galleryDropzoneAccept,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_SIZE_MB,
} from './index';

describe('media-upload-limits', () => {
  it('CSV matches wrangler defaults for media-worker / admin parity', () => {
    expect(ALLOWED_IMAGE_MIME_TYPES_CSV).toBe(
      'image/jpeg,image/png,image/gif,image/webp,image/svg+xml',
    );
  });

  it('bytes match MB cap', () => {
    expect(MAX_UPLOAD_BYTES).toBe(MAX_UPLOAD_SIZE_MB * 1024 * 1024);
  });

  it('lists five image types', () => {
    expect(ALLOWED_IMAGE_MIME_TYPES).toHaveLength(5);
  });

  it('galleryDropzoneAccept keys match MIME list', () => {
    const acc = galleryDropzoneAccept();
    for (const m of ALLOWED_IMAGE_MIME_TYPES) {
      expect(acc[m]).toEqual([]);
    }
  });
});
