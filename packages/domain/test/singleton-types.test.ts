import { describe, expect, it } from 'vitest';
import {
  defineContentType,
  reviseContentType,
  SINGLETON_CLAIM_FIELD,
  singletonClaim,
  uniqueClaims,
} from '../src/index';

const draft = {
  apiId: 'settings',
  name: 'Settings',
  displayField: 'title',
  fields: [
    {
      apiId: 'title',
      name: 'Title',
      type: 'Symbol' as const,
      localized: false,
      required: false,
      unique: true,
      position: 0,
    },
  ],
};

describe('singleton types', () => {
  it('carries the flag only when true, and keeps it through a revision that leaves it out', () => {
    expect('singleton' in defineContentType(draft)).toBe(false);
    expect('singleton' in defineContentType({ ...draft, singleton: false })).toBe(false);
    const singleton = defineContentType({ ...draft, singleton: true });
    expect(singleton.singleton).toBe(true);
    expect(reviseContentType(singleton, { name: 'Site' }).singleton).toBe(true);
    expect('singleton' in reviseContentType(singleton, { singleton: false })).toBe(false);
  });

  it('makes every entry of a singleton type stake the same claim, beside its unique values', () => {
    const type = defineContentType({ ...draft, singleton: true });
    const claims = uniqueClaims(type, { title: { 'en-US': 'Home' } });
    expect(claims[0]).toEqual(singletonClaim('settings'));
    expect(claims.map((c) => c.fieldApiId)).toEqual([SINGLETON_CLAIM_FIELD, 'title']);
    // Even with no values at all: the claim is the entry's, not a field's.
    expect(uniqueClaims(type, {})).toEqual([singletonClaim('settings')]);
    expect(uniqueClaims(defineContentType(draft), {})).toEqual([]);
  });
});
