import { describe, expect, it } from 'vitest';
import {
  checkMenuHandle,
  checkMenuItems,
  checkMenuUrl,
  countMenuItems,
  entryUrlPath,
  MAX_MENU_DEPTH,
  MAX_MENU_ITEMS,
  type MenuItem,
  menuTargets,
  moveMenuItem,
  NotFoundError,
  resolveMenuItems,
  ValidationError,
} from '../src/index';

let n = 0;
const newId = () => `gen${++n}`;
const url = (label: string, href = '/x', children: unknown[] = []) => ({
  label,
  link: { type: 'url', url: href },
  children,
});
const entry = (entryId: string, children: unknown[] = []) => ({
  link: { type: 'entry', entryId },
  children,
});

const issuesOf = (fn: () => unknown): { field: string; message: string }[] => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ValidationError) return [...err.issues];
    throw err;
  }
  throw new Error('expected a ValidationError');
};

describe('menu handles and URLs', () => {
  it('takes lowercase handles joined by - or _', () => {
    expect(checkMenuHandle(' main ')).toBe('main');
    expect(checkMenuHandle('footer-legal_2')).toBe('footer-legal_2');
    for (const bad of ['', 'Main', 'a b', '-main', 'main-', 'x'.repeat(65), 7]) {
      expect(() => checkMenuHandle(bad)).toThrow(ValidationError);
    }
  });

  it('takes paths, fragments, http(s), mailto and tel; refuses script and protocol-relative', () => {
    for (const ok of [
      '/about',
      '/search?q=a#top',
      '#top',
      '?page=2',
      'https://example.com/x',
      'http://localhost:8787',
      'mailto:hi@example.com',
      'tel:+15550100',
    ]) {
      expect(checkMenuUrl(ok)).toBe(ok);
    }
    for (const bad of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,x',
      '//evil.example',
      'https://user:pw@example.com',
      'https://',
      'about us',
      'relative/path',
      'mailto:',
      `/${'a'.repeat(2048)}`,
    ]) {
      expect(() => checkMenuUrl(bad), bad).toThrow(ValidationError);
    }
  });
});

describe('menu items', () => {
  it('normalizes items, keeping given ids and making the rest', () => {
    const items = checkMenuItems(
      [
        { id: 'home', label: ' Home ', link: { type: 'url', url: '/' }, target: '_self' },
        {
          link: { type: 'entry', entryId: 'e1' },
          label: '',
          target: '_blank',
          attrs: { rel: 'noopener', 'data-track': 'nav' },
          children: [{ link: { type: 'term', termKind: 'tag', termId: 't1' } }],
        },
      ],
      newId,
    );
    expect(items[0]).toEqual({
      id: 'home',
      label: 'Home',
      link: { type: 'url', url: '/' },
      children: [],
    });
    expect(items[1]?.id).toMatch(/^gen/);
    expect(items[1]?.label).toBeUndefined();
    expect(items[1]?.target).toBe('_blank');
    expect(items[1]?.attrs).toEqual({ rel: 'noopener', 'data-track': 'nav' });
    expect(items[1]?.children[0]?.link).toEqual({ type: 'term', termKind: 'tag', termId: 't1' });
  });

  it('names every bad item by its path in one refusal', () => {
    const issues = issuesOf(() =>
      checkMenuItems(
        [
          { link: { type: 'url', url: '/a' } },
          { label: 'x', link: { type: 'url', url: 'javascript:void(0)' } },
          { label: 'y', link: { type: 'page', id: 'p' } },
          {
            id: 'dup',
            label: 'z',
            link: { type: 'url', url: '/z' },
            attrs: { onclick: 'x', style: 'y' },
            children: [{ id: 'dup', label: 'w', link: { type: 'url', url: '/w' } }],
          },
          { label: 'v', link: { type: 'url', url: '/v' }, target: '_top' },
        ],
        newId,
      ),
    );
    expect(issues.map((i) => i.field)).toEqual([
      'items[0].label',
      'items[1].link.url',
      'items[2].link',
      'items[3].attrs.onclick',
      'items[3].attrs.style',
      'items[3].children[0].id',
      'items[4].target',
    ]);
  });

  it(`nests at most ${MAX_MENU_DEPTH} deep and holds at most ${MAX_MENU_ITEMS} items`, () => {
    let deep: unknown = url('leaf');
    for (let d = 1; d < MAX_MENU_DEPTH; d++) deep = url(`l${d}`, '/x', [deep]);
    expect(countMenuItems(checkMenuItems([deep], newId))).toBe(MAX_MENU_DEPTH);
    expect(issuesOf(() => checkMenuItems([url('top', '/', [deep])], newId))[0]?.message).toMatch(
      /levels deep/,
    );
    const many = Array.from({ length: MAX_MENU_ITEMS + 1 }, (_, i) => url(`i${i}`));
    expect(issuesOf(() => checkMenuItems(many, newId))[0]?.field).toBe('items');
  });

  it('collects the entries and terms a menu links to, once each', () => {
    const items = checkMenuItems(
      [
        entry('e1', [entry('e2'), entry('e1')]),
        { link: { type: 'term', termKind: 'concept', termId: 'c1' } },
        { link: { type: 'term', termKind: 'tag', termId: 'c1' } },
      ],
      newId,
    );
    expect(menuTargets(items)).toEqual({
      entryIds: ['e1', 'e2'],
      terms: [
        { kind: 'concept', id: 'c1' },
        { kind: 'tag', id: 'c1' },
      ],
    });
  });
});

describe('moving a menu item', () => {
  const tree = (): MenuItem[] =>
    checkMenuItems(
      [
        {
          id: 'a',
          ...url('A', '/a', [
            { id: 'a1', ...url('A1') },
            { id: 'a2', ...url('A2') },
          ]),
        },
        { id: 'b', ...url('B') },
        {
          id: 'c',
          ...url('C', '/c', [{ id: 'c1', ...url('C1', '/c1', [{ id: 'c11', ...url('C11') }]) }]),
        },
      ],
      newId,
    );
  const shape = (items: readonly MenuItem[]): unknown =>
    items.map((i) => (i.children.length ? { [i.id]: shape(i.children) } : i.id));

  it('reorders siblings and moves between parents, subtree and all', () => {
    expect(shape(moveMenuItem(tree(), { itemId: 'b', parentId: null, index: 0 }))).toEqual([
      'b',
      { a: ['a1', 'a2'] },
      { c: [{ c1: ['c11'] }] },
    ]);
    expect(shape(moveMenuItem(tree(), { itemId: 'a2', parentId: 'a', index: 0 }))).toEqual([
      { a: ['a2', 'a1'] },
      'b',
      { c: [{ c1: ['c11'] }] },
    ]);
    expect(shape(moveMenuItem(tree(), { itemId: 'a', parentId: 'b', index: 99 }))).toEqual([
      { b: [{ a: ['a1', 'a2'] }] },
      { c: [{ c1: ['c11'] }] },
    ]);
  });

  it('refuses a move under itself, past the depth, or to an item that isn’t there', () => {
    expect(() => moveMenuItem(tree(), { itemId: 'c', parentId: 'c11', index: 0 })).toThrow(
      ValidationError,
    );
    // c1 has a child: under a1 (depth 2) it would reach depth 4.
    expect(
      issuesOf(() => moveMenuItem(tree(), { itemId: 'c1', parentId: 'a1', index: 0 }))[0]?.message,
    ).toMatch(/levels deep/);
    expect(() => moveMenuItem(tree(), { itemId: 'zz', parentId: null, index: 0 })).toThrow(
      NotFoundError,
    );
    expect(() => moveMenuItem(tree(), { itemId: 'b', parentId: 'zz', index: 0 })).toThrow(
      NotFoundError,
    );
  });
});

describe('resolving a menu for delivery', () => {
  it('drops a dangling item and lifts its children into its place', () => {
    const items = checkMenuItems(
      [
        {
          id: 'docs',
          ...entry('gone', [
            { id: 'guide', ...entry('e1') },
            { id: 'ref', ...url('Ref', '/ref') },
          ]),
        },
        { id: 'blog', label: 'Our blog', ...entry('e2') },
      ],
      newId,
    );
    const published: Record<string, string> = { e1: '/docs/guide', e2: '/blog' };
    const out = resolveMenuItems(items, (link) => {
      if (link.type === 'url') return { url: link.url, label: '' };
      if (link.type !== 'entry') return null;
      const path = published[link.entryId];
      return path
        ? {
            url: path,
            label: `Title of ${link.entryId}`,
            entry: { id: link.entryId, contentType: 'page' },
          }
        : null;
    });
    expect(out).toEqual([
      {
        id: 'guide',
        label: 'Title of e1',
        url: '/docs/guide',
        entry: { id: 'e1', contentType: 'page' },
        children: [],
      },
      { id: 'ref', label: 'Ref', url: '/ref', children: [] },
      {
        id: 'blog',
        label: 'Our blog',
        url: '/blog',
        entry: { id: 'e2', contentType: 'page' },
        children: [],
      },
    ]);
  });

  it('builds an entry’s path in a locale, falling back for a slug that isn’t localized', () => {
    const config = { defaultLocale: 'en-US', locales: ['en-US', 'de-DE'] };
    const fields = { slug: { 'en-US': 'hello' }, title: { 'en-US': 'Hello', 'de-DE': 'Hallo' } };
    expect(entryUrlPath('/{locale}/blog/{slug}', { id: 'e1', fields }, config, 'de-DE')).toBe(
      '/de-DE/blog/hello',
    );
    expect(entryUrlPath('/p/{id}', { id: 'e 1', fields }, config, 'en-US')).toBe('/p/e%201');
    expect(entryUrlPath('/blog/{missing}', { id: 'e1', fields }, config, 'en-US')).toBeNull();
  });
});
