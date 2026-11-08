import { describe, expect, it } from 'vitest';
import {
  collectionChangeIds,
  parseAssetMediaPath,
  parseShareLinkPath,
  shareLinkExpiry,
  shareLinkState,
  ValidationError,
  zipFileName,
} from '../src/index';

const TOKEN = 'abcdefghijklmnopqrstuv';

describe('share link paths', () => {
  it('parses the page, the unlock form and a file', () => {
    expect(parseShareLinkPath(`/s/shop/main/l1/${TOKEN}`)).toEqual({
      scope: { spaceId: 'shop', environmentId: 'main' },
      linkId: 'l1',
      token: TOKEN,
      request: { kind: 'page' },
    });
    expect(parseShareLinkPath(`/s/shop/main/l1/${TOKEN}/unlock`)?.request).toEqual({
      kind: 'unlock',
    });
    expect(parseShareLinkPath(`/s/shop/main/l1/${TOKEN}/f/a1/my%20file.pdf`)?.request).toEqual({
      kind: 'file',
      assetId: 'a1',
      fileName: 'my file.pdf',
    });
  });

  it('refuses anything else, and never collides with a published asset’s path', () => {
    for (const path of [
      `/s/shop/main/l1/short`,
      `/s/shop/main/l1/${TOKEN}/f/a1`,
      `/s/shop/main/l1/${TOKEN}/other`,
      `/s/shop/../l1/${TOKEN}`,
      `/s/shop/main/%E0%A4%A/${TOKEN}`,
      `/x/shop/main/l1/${TOKEN}`,
    ]) {
      expect(parseShareLinkPath(path)).toBeNull();
    }
    // A space named `s`: its asset paths are 8 segments, which no share path is.
    const assetPath = `/s/main/a1/v1/${TOKEN}/o/file.png`;
    expect(parseAssetMediaPath(assetPath)).not.toBeNull();
    expect(parseShareLinkPath(assetPath)).toBeNull();
  });
});

describe('share link rules', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  it('expires 5 minutes to 90 days out', () => {
    expect(shareLinkExpiry('2026-01-02T00:00:00+01:00', now)).toBe('2026-01-01T23:00:00.000Z');
    for (const bad of ['2026-01-01T00:04:00Z', '2026-04-02T00:00:00Z', 'nope']) {
      expect(() => shareLinkExpiry(bad, now)).toThrow(ValidationError);
    }
  });

  it('is revoked, expired or active', () => {
    const t = now.getTime();
    expect(shareLinkState({ expiresAt: '2026-01-02T00:00:00Z' }, t)).toBe('active');
    expect(shareLinkState({ expiresAt: '2025-12-31T00:00:00Z' }, t)).toBe('expired');
    expect(
      shareLinkState({ expiresAt: '2026-01-02T00:00:00Z', revokedAt: '2026-01-01T00:00:00Z' }, t),
    ).toBe('revoked');
  });

  it('takes 1..500 distinct ids for a collection change, and names zips safely', () => {
    expect(collectionChangeIds(['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(() => collectionChangeIds([])).toThrow(ValidationError);
    expect(() => collectionChangeIds(Array.from({ length: 501 }, (_, i) => `${i}`))).toThrow(
      ValidationError,
    );
    expect(zipFileName('../../Brand: kit.zip', 'x')).toBe('..-..-Brand- kit.zip');
    expect(zipFileName('  ', 'Kit')).toBe('Kit.zip');
  });
});
