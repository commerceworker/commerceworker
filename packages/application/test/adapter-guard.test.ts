import { describe, expect, it } from 'vitest';
import { assertNoFakeAdapters } from '../src/adapter-guard';

const stubAI = { key: 'ai', detail: 'StubAIProvider — bind AI' } as const;
const fakeBlob = { key: 'blob', detail: 'FakeBlobStore — bind MEDIA_BUCKET' } as const;

describe('assertNoFakeAdapters', () => {
  it('passes when the store is not persistent, whatever is bound', () => {
    expect(() =>
      assertNoFakeAdapters({ persistent: false, fakes: [stubAI, fakeBlob] }),
    ).not.toThrow();
  });

  it('passes when no fakes are bound', () => {
    expect(() => assertNoFakeAdapters({ persistent: true, fakes: [] })).not.toThrow();
  });

  it('throws on a persistent store with an unallowed fake, naming it', () => {
    expect(() => assertNoFakeAdapters({ persistent: true, fakes: [stubAI, fakeBlob] })).toThrow(
      /ai: StubAIProvider.*\n.*blob: FakeBlobStore/,
    );
  });

  it('suggests the exact ALLOW_FAKE_ADAPTERS value in the error', () => {
    expect(() => assertNoFakeAdapters({ persistent: true, fakes: [fakeBlob] })).toThrow(
      /ALLOW_FAKE_ADAPTERS=blob/,
    );
  });

  it('allows fakes named in ALLOW_FAKE_ADAPTERS, blocking the rest', () => {
    expect(() =>
      assertNoFakeAdapters({ persistent: true, allowFakeAdapters: 'ai', fakes: [stubAI] }),
    ).not.toThrow();
    expect(() =>
      assertNoFakeAdapters({
        persistent: true,
        allowFakeAdapters: 'ai',
        fakes: [stubAI, fakeBlob],
      }),
    ).toThrow(/blob/);
  });

  it('tolerates whitespace and case in the allow list', () => {
    expect(() =>
      assertNoFakeAdapters({
        persistent: true,
        allowFakeAdapters: ' AI , Blob ',
        fakes: [stubAI, fakeBlob],
      }),
    ).not.toThrow();
  });

  it('accepts all as a blanket allow, but not a stray boolean-looking "true"', () => {
    expect(() =>
      assertNoFakeAdapters({
        persistent: true,
        allowFakeAdapters: 'all',
        fakes: [stubAI, fakeBlob],
      }),
    ).not.toThrow();
    expect(() =>
      assertNoFakeAdapters({ persistent: true, allowFakeAdapters: 'true', fakes: [stubAI] }),
    ).toThrow(/ai/);
  });
});
