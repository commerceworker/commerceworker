/**
 * Deep-merging i18next resource bundles.
 *
 * This is how an app's own translations layer over the shared base bundle: same language, same
 * namespace, extra wins key by key. Getting the depth wrong is a silent failure — a shallow merge
 * would replace whole namespaces, so an app that overrides one string would lose every other key
 * in that namespace and render raw translation ids in production.
 */
import { describe, expect, it } from 'vitest';
import { mergeResources } from './merge-resources';

describe('mergeResources', () => {
  it('merges keys within a shared namespace', () => {
    const base = { en: { common: { yes: 'Yes', no: 'No' } } };
    const extra = { en: { common: { no: 'Nope' } } };

    // The key survives: overriding `no` must not drop `yes`.
    expect(mergeResources(base, extra)).toEqual({ en: { common: { yes: 'Yes', no: 'Nope' } } });
  });

  it('lets extra win on conflicting keys', () => {
    const base = { en: { common: { greeting: 'Hello' } } };
    const extra = { en: { common: { greeting: 'Hi' } } };

    expect(mergeResources(base, extra)).toEqual({ en: { common: { greeting: 'Hi' } } });
  });

  it('keeps namespaces that only the base defines', () => {
    const base = { en: { common: { yes: 'Yes' }, errors: { notFound: 'Not found' } } };
    const extra = { en: { common: { yes: 'Yeah' } } };

    expect(mergeResources(base, extra)).toEqual({
      en: { common: { yes: 'Yeah' }, errors: { notFound: 'Not found' } },
    });
  });

  it('adds namespaces that only extra defines', () => {
    const base = { en: { common: { yes: 'Yes' } } };
    const extra = { en: { marketing: { tagline: 'Commerce at the edge' } } };

    expect(mergeResources(base, extra)).toEqual({
      en: { common: { yes: 'Yes' }, marketing: { tagline: 'Commerce at the edge' } },
    });
  });

  it('keeps languages that only one side defines', () => {
    const base = { en: { common: { yes: 'Yes' } } };
    const extra = { es: { common: { yes: 'Sí' } } };

    expect(mergeResources(base, extra)).toEqual({
      en: { common: { yes: 'Yes' } },
      es: { common: { yes: 'Sí' } },
    });
  });

  it('merges several languages independently', () => {
    const base = { en: { common: { yes: 'Yes' } }, es: { common: { yes: 'Sí', no: 'No' } } };
    const extra = { es: { common: { no: 'Nop' } } };

    expect(mergeResources(base, extra)).toEqual({
      en: { common: { yes: 'Yes' } },
      es: { common: { yes: 'Sí', no: 'Nop' } },
    });
  });

  it('replaces rather than merges when a namespace is not an object', () => {
    const base = { en: { common: 'not-an-object' as unknown as Record<string, unknown> } };
    const extra = { en: { common: { yes: 'Yes' } } };

    expect(mergeResources(base, extra)).toEqual({ en: { common: { yes: 'Yes' } } });
  });

  it('falls back to the base when extra has no value for the namespace', () => {
    const base = { en: { common: { yes: 'Yes' } } };
    const extra = { en: {} };

    expect(mergeResources(base, extra)).toEqual({ en: { common: { yes: 'Yes' } } });
  });

  it('returns an empty resource when both sides are empty', () => {
    expect(mergeResources({}, {})).toEqual({});
  });

  it('returns the other side when one is empty', () => {
    const base = { en: { common: { yes: 'Yes' } } };

    expect(mergeResources(base, {})).toEqual(base);
    expect(mergeResources({}, base)).toEqual(base);
  });

  it('does not mutate either input', () => {
    // The base bundle is a module-level singleton shared by every app; mutating it would leak one
    // app's overrides into the next caller.
    const base = { en: { common: { yes: 'Yes' } } };
    const extra = { en: { common: { no: 'No' } } };
    const baseSnapshot = structuredClone(base);
    const extraSnapshot = structuredClone(extra);

    mergeResources(base, extra);

    expect(base).toEqual(baseSnapshot);
    expect(extra).toEqual(extraSnapshot);
  });

  it('produces a fresh namespace object rather than aliasing an input', () => {
    const base = { en: { common: { yes: 'Yes' } } };
    const extra = { en: { common: { no: 'No' } } };

    const merged = mergeResources(base, extra);

    expect(merged.en?.common).not.toBe(base.en.common);
    expect(merged.en?.common).not.toBe(extra.en.common);
  });
});
