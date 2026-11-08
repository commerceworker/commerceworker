/**
 * The Management asset is declared three times: the domain's `Asset` (what the api sends), the
 * zod schema behind the OpenAPI document, and sdk-management's interface (what clients compile
 * against). A field added to one and not the others ships as a silent gap; this compares their
 * keys, optionality and the keys of their nested objects (`file`, `file.video`, `metadata`,
 * `rights`, `aiSuggestions`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { SERVER_ONLY_ASSET_FIELDS } from '../src/api/asset-response';
import { asset, assetVersionList } from '../src/api/docs/schemas/assets';
import { comparable, interfaceBody, keyPaths, parseShape, zodShape } from './interface-shape';

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, path), 'utf8');
const shapeOf = (path: string, name = 'Asset') => {
  const source = read(path);
  return parseShape(interfaceBody(source, name), source);
};

/**
 * The server's own bookkeeping (where the bytes live in blob storage), which the one asset
 * serializer strips from every Management and MCP response: not part of the contract.
 */
const SERVER_ONLY: string[] = [...SERVER_ONLY_ASSET_FIELDS];

const zod = zodShape(asset);
const sdk = shapeOf('../../sdk/management/src/index.ts');
const domainAll = shapeOf('../../domain/src/asset/asset.ts');
const domain = Object.fromEntries(
  Object.entries(domainAll).filter(([name]) => !SERVER_ONLY.includes(name)),
);

describe('Management Asset parity', () => {
  it('reads every definition, nested objects included', () => {
    for (const shape of [zod, sdk, domain]) {
      expect(keyPaths(shape)).toEqual(
        expect.arrayContaining([
          'id',
          'file',
          'file.video?',
          'file.video.status',
          'metadata',
          'metadata.focalPoint.x',
          'rights.embargoUntil?',
        ]),
      );
    }
    expect(Object.keys(domainAll)).toEqual(expect.arrayContaining(SERVER_ONLY));
  });

  it('sdk-management has the zod schema’s keys, optionality and nested keys', () => {
    expect(keyPaths(sdk).sort()).toEqual(keyPaths(zod).sort());
    expect(comparable(sdk, zod)).toEqual(comparable(zod, sdk));
  });

  it('the domain Asset has the zod schema’s keys, but for server bookkeeping', () => {
    expect(keyPaths(domain).sort()).toEqual(keyPaths(zod).sort());
    expect(comparable(domain, zod)).toEqual(comparable(zod, domain));
  });

  it('a file version has the same keys in the domain (but for r2Key), the schema and the SDK', () => {
    const items = assetVersionList.shape.items as unknown as { element: z.ZodObject };
    const zodVersion = zodShape(items.element);
    const sdkVersion = shapeOf('../../sdk/management/src/index.ts', 'AssetVersion');
    const domainVersion = Object.fromEntries(
      Object.entries(shapeOf('../../domain/src/asset/asset.ts', 'AssetVersion')).filter(
        ([name]) => !SERVER_ONLY.includes(name),
      ),
    );
    expect(keyPaths(zodVersion)).toEqual(expect.arrayContaining(['version', 'file', 'current']));
    expect(keyPaths(sdkVersion).sort()).toEqual(keyPaths(zodVersion).sort());
    expect(keyPaths(domainVersion).sort()).toEqual(keyPaths(zodVersion).sort());
  });

  it('the parser follows a named interface in the same source', () => {
    const source = `
      export interface Inner { readonly a: number; readonly b?: string; }
      export interface Outer { readonly inner?: Inner; readonly other: Record<string, unknown>; }`;
    expect(parseShape(interfaceBody(source, 'Outer'), source)).toEqual({
      inner: { optional: true, children: { a: { optional: false }, b: { optional: true } } },
      other: { optional: false },
    });
  });
});
