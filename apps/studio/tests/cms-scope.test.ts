import { describe, expect, it } from 'vitest';
import { readScope, SCOPE_KEY } from '~/cms/lib/client-context';

const storage = (value: unknown) => ({
  getItem: (k: string) => (k === SCOPE_KEY && value !== undefined ? JSON.stringify(value) : null),
});

describe('the CMS scope (space, environment, locale)', () => {
  it('starts on main with no space or locale when nothing is stored', () => {
    expect(readScope('', storage(undefined))).toEqual({
      space: '',
      environment: 'main',
      locale: '',
    });
  });

  it('reads the stored scope', () => {
    expect(
      readScope('', storage({ space: 'blog', environment: 'staging', locale: 'de-DE' })),
    ).toEqual({ space: 'blog', environment: 'staging', locale: 'de-DE' });
  });

  it('lets ?space=, ?env= and ?locale= in the URL override what is stored', () => {
    const stored = storage({ space: 'blog', environment: 'staging', locale: 'de-DE' });
    expect(readScope('?space=docs&env=main&locale=fr-FR', stored)).toEqual({
      space: 'docs',
      environment: 'main',
      locale: 'fr-FR',
    });
    expect(readScope('?env=preview', stored)).toEqual({
      space: 'blog',
      environment: 'preview',
      locale: 'de-DE',
    });
  });

  it('ignores a corrupt stored value and empty params', () => {
    const bad = { getItem: () => '{not json' };
    expect(readScope('?space=', bad)).toEqual({ space: '', environment: 'main', locale: '' });
  });

  it('survives storage that throws (a private window)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readScope('?space=blog', throwing).space).toBe('blog');
  });
});
