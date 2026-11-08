import { describe, expect, it } from 'vitest';
import {
  archive,
  defineContentType,
  type Entry,
  InvalidStateError,
  publish,
  saveDraft,
  unpublish,
  validateEntryFields,
} from '../src/index';

const baseEntry: Entry = {
  id: 'e1',
  contentTypeApiId: 'article',
  status: 'draft',
  currentVersion: 1,
  publishedVersion: null,
};

describe('entry publish state machine', () => {
  it('transitions draft -> published -> changed -> published', () => {
    const published = publish(baseEntry);
    expect(published.status).toBe('published');
    expect(published.publishedVersion).toBe(1);

    const { entry: edited } = saveDraft(published, {});
    expect(edited.status).toBe('changed');
    expect(edited.currentVersion).toBe(2);

    const republished = publish(edited);
    expect(republished.status).toBe('published');
    expect(republished.publishedVersion).toBe(2);
  });

  it('unpublish reverts to draft', () => {
    const updated = unpublish(publish(baseEntry));
    expect(updated.status).toBe('draft');
    expect(updated.publishedVersion).toBeNull();
  });

  it('refuses to archive a published entry', () => {
    expect(() => archive(publish(baseEntry))).toThrow(InvalidStateError);
  });
});

describe('field validation', () => {
  const ct = defineContentType({
    apiId: 'product',
    name: 'Product',
    displayField: 'name',
    fields: [
      {
        apiId: 'name',
        name: 'Name',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
      {
        apiId: 'price',
        name: 'Price',
        type: 'Number',
        localized: false,
        required: true,
        position: 1,
        validations: { range: { min: 0 } },
      },
    ],
  });
  const vctx = { defaultLocale: 'en-US', locales: ['en-US'] };

  it('passes valid values', () => {
    const issues = validateEntryFields(
      ct,
      { name: { 'en-US': 'Widget' }, price: { 'en-US': 9.99 } },
      vctx,
    );
    expect(issues).toHaveLength(0);
  });

  it('flags missing required fields and out-of-range numbers', () => {
    const issues = validateEntryFields(ct, { price: { 'en-US': -1 } }, vctx);
    expect(issues.some((i) => i.field === 'name')).toBe(true);
    expect(issues.some((i) => i.field === 'price' && />= 0/.test(i.message))).toBe(true);
  });
});
