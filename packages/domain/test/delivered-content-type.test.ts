import { describe, expect, it } from 'vitest';
import {
  type ContentType,
  deliveredContentType,
  type FieldDefinition,
  type PublishedContentTypeDefinition,
} from '../src';

const field = (apiId: string, position: number): FieldDefinition => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required: false,
  position,
});

const draft: ContentType = {
  apiId: 'page',
  name: 'Pages',
  displayField: 'heading',
  fields: [field('heading', 0)],
  urlPattern: '/pages/{slug}',
  singleton: true,
  version: 3,
  status: 'draft',
};
const kept: PublishedContentTypeDefinition = {
  name: 'Page',
  displayField: 'title',
  fields: [field('title', 0)],
  urlPattern: '/{slug}',
  version: 1,
};

describe('deliveredContentType', () => {
  it('serves what was last published over a draft, reporting it published', () => {
    expect(deliveredContentType(draft, kept, false)).toEqual({
      apiId: 'page',
      ...kept,
      status: 'published',
    });
  });

  it('drops a draft’s URL pattern when the published definition had none', () => {
    const { urlPattern: _none, ...noPattern } = kept;
    expect(deliveredContentType(draft, noPattern, false).urlPattern).toBeUndefined();
  });

  it('takes a published row as it stands, whatever is kept beside it', () => {
    const row: ContentType = { ...draft, status: 'published' };
    expect(deliveredContentType(row, kept, true)).toEqual(row);
  });

  it('leaves a draft with nothing kept as it stands', () => {
    const { singleton: _draft, ...rest } = draft;
    expect(deliveredContentType(draft, null, false)).toEqual(rest);
  });

  it('reports the singleton flag as last published, either way', () => {
    expect(deliveredContentType(draft, kept, true).singleton).toBe(true);
    expect(deliveredContentType(draft, null, false).singleton).toBeUndefined();
    expect(deliveredContentType({ ...draft, status: 'published' }, null, false).singleton).toBe(
      undefined,
    );
  });
});
