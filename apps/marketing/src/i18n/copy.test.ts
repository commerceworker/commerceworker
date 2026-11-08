import { describe, expect, it } from 'vitest';
import { en } from './en';
import { es } from './es';

/** Every leaf of a copy object, by its path, so two locales can be compared key for key. */
function leaves(value: unknown, path = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      for (const [p, leaf] of leaves(v, path ? `${path}.${k}` : k)) out.set(p, leaf);
    }
  } else out.set(path, value);
  return out;
}

describe('the Spanish copy', () => {
  const english = leaves(en);
  const spanish = leaves(es);

  it('has every key the English copy has, and no others', () => {
    expect([...spanish.keys()].sort()).toEqual([...english.keys()].sort());
  });

  it('leaves nothing empty', () => {
    const empty = [...spanish].filter(
      ([k, v]) => k !== 'lang' && (typeof v !== 'string' || !v.trim()),
    );
    expect(empty.filter(([, v]) => typeof v === 'string')).toEqual([]);
  });

  it('links each feature section to the same docs page', () => {
    expect(es.features.sections.map((s) => s.doc)).toEqual(en.features.sections.map((s) => s.doc));
  });
});
