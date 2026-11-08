/**
 * The delivered asset is declared four times: the domain's projection (what the api sends), the
 * zod schema behind the OpenAPI document, sdk-core's interface and codegen's prelude (what
 * clients compile against). Nothing else ties them together, so a field added to one and not
 * the others would ship as a silent gap; this compares their keys, optionality and the keys of
 * their inline objects.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTypes } from '@commerceworker/sdk-codegen';
import { describe, expect, it } from 'vitest';
import { deliveredAsset } from '../src/api/docs/schemas/assets';
import { comparable, interfaceBody, parseShape, zodShape } from './interface-shape';

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, path), 'utf8');

const definitions = {
  zod: zodShape(deliveredAsset),
  domain: parseShape(interfaceBody(read('../../domain/src/asset/delivered.ts'), 'DeliveredAsset')),
  sdkCore: parseShape(interfaceBody(read('../../sdk/core/src/index.ts'), 'DeliveredAsset')),
  codegen: parseShape(interfaceBody(generateTypes([]), 'DeliveredAsset')),
};

describe('DeliveredAsset parity', () => {
  it('reads every definition (the parser found the fields)', () => {
    for (const shape of Object.values(definitions)) {
      expect(Object.keys(shape)).toEqual(expect.arrayContaining(['id', 'url', 'srcset', 'file']));
    }
    expect(definitions.codegen.video?.children?.thumbnailUrl).toEqual({ optional: true });
  });

  for (const name of ['domain', 'sdkCore', 'codegen'] as const) {
    it(`${name} has the zod schema's keys, optionality and inline object keys`, () => {
      const shape = definitions[name];
      expect(Object.keys(shape).sort()).toEqual(Object.keys(definitions.zod).sort());
      expect(comparable(shape, definitions.zod)).toEqual(comparable(definitions.zod, shape));
    });
  }

  it('the parser notices a missing, extra or newly optional key', () => {
    const drifted = parseShape('{ id: string; url?: string; extra: { a: number }; }');
    expect(drifted).toEqual({
      id: { optional: false },
      url: { optional: true },
      extra: { optional: false, children: { a: { optional: false } } },
    });
  });
});
