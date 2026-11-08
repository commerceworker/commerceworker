import { describe, expect, it } from 'vitest';
import {
  type Asset,
  type AssetFolder,
  archiveAsset,
  assertFolderMove,
  assetFolderName,
  assetFolderPath,
  assetKind,
  clearAcceptedSuggestions,
  InvalidStateError,
  MAX_ASSET_FOLDER_DEPTH,
  publishAsset,
  restoreAsset,
  ValidationError,
} from '../src/index';

const asset: Asset = {
  id: 'a1',
  status: 'published',
  file: { url: '/media/x', fileName: 'x.png', contentType: 'image/png' },
  title: {},
  description: {},
  metadata: { altText: {}, tags: [] },
};

describe('asset kind', () => {
  it.each([
    ['image/png', 'image'],
    ['IMAGE/SVG+XML; charset=utf-8', 'image'],
    ['video/mp4', 'video'],
    ['audio/mpeg', 'audio'],
    ['application/pdf', 'document'],
    ['text/markdown', 'document'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document'],
    ['application/zip', 'other'],
    ['', 'other'],
  ])('%s is %s', (contentType, kind) => {
    expect(assetKind(contentType)).toBe(kind);
  });
});

describe('archiving an asset', () => {
  it('archives with a timestamp, blocks publishing, and restores as a draft', () => {
    const archived = archiveAsset(asset, '2026-05-01T00:00:00.000Z');
    expect(archived).toMatchObject({ status: 'archived', archivedAt: '2026-05-01T00:00:00.000Z' });
    expect(() => archiveAsset(archived, 'x')).toThrow(InvalidStateError);
    expect(() => publishAsset(archived)).toThrow(InvalidStateError);
    const restored = restoreAsset(archived);
    expect(restored.status).toBe('draft');
    expect('archivedAt' in restored).toBe(false);
    expect(() => restoreAsset(restored)).toThrow(InvalidStateError);
  });
});

describe('asset folders', () => {
  const f = (id: string, path: string): AssetFolder => ({
    id,
    name: id,
    path,
    createdAt: '',
    updatedAt: '',
  });

  it('builds materialized paths and bounds their depth', () => {
    expect(assetFolderPath(null, 'a')).toBe('/a/');
    expect(assetFolderPath(f('a', '/a/'), 'b')).toBe('/a/b/');
    const deepest = `/${Array.from({ length: MAX_ASSET_FOLDER_DEPTH }, (_, i) => i).join('/')}/`;
    expect(() => assetFolderPath({ path: deepest }, 'x')).toThrow(ValidationError);
  });

  it('trims names and refuses empty, long or slashed ones', () => {
    expect(assetFolderName('  Brand ')).toBe('Brand');
    for (const bad of ['', '   ', 'a/b', 'x'.repeat(129)]) {
      expect(() => assetFolderName(bad)).toThrow(ValidationError);
    }
  });

  it('never moves a folder into itself or its subtree', () => {
    const a = f('a', '/a/');
    expect(() => assertFolderMove(a, a)).toThrow(ValidationError);
    expect(() => assertFolderMove(a, f('b', '/a/b/'))).toThrow(ValidationError);
    expect(() => assertFolderMove(a, f('ab', '/ab/'))).not.toThrow();
    expect(() => assertFolderMove(a, null)).not.toThrow();
  });
});

describe('clearAcceptedSuggestions', () => {
  const marks = { altText: ['en-US', 'de-DE'], tags: ['t1', 't2'] };
  const metadata = { altText: { 'en-US': 'A mug', 'de-DE': 'Ein Becher' }, tags: ['t1', 't2'] };

  it('keeps every mark when the save carries the values back unchanged', () => {
    expect(clearAcceptedSuggestions(marks, metadata, metadata)).toEqual(marks);
    expect(clearAcceptedSuggestions(marks, metadata, {})).toEqual(marks);
  });

  it('clears the mark of each alt text locale the save changed, and only those', () => {
    const patch = { altText: { 'en-US': 'My mug', 'de-DE': 'Ein Becher', fr: 'Une tasse' } };
    expect(clearAcceptedSuggestions(marks, metadata, patch)).toEqual({
      altText: ['de-DE'],
      tags: ['t1', 't2'],
    });
  });

  it('clears the mark of a suggested tag the save removed, and keeps the rest', () => {
    expect(clearAcceptedSuggestions(marks, metadata, { tags: ['t2', 'mine'] })).toEqual({
      altText: ['en-US', 'de-DE'],
      tags: ['t2'],
    });
  });

  it('is undefined once nothing is left a suggestion', () => {
    expect(
      clearAcceptedSuggestions({ altText: ['en-US'] }, metadata, { altText: { 'en-US': 'x' } }),
    ).toBeUndefined();
    expect(clearAcceptedSuggestions(undefined, metadata, {})).toBeUndefined();
  });
});
