import type { SavedView } from '@commerceworker/domain';
import { describe, expect, it } from 'vitest';
import {
  listQueryToViewQuery,
  listStateFromParams,
  listStateToParams,
  matchesView,
  viewToListState,
} from '~/cms/lib/entry-url';
import { entryQueryParams } from '~/cms/lib/management';

const view = (over: Partial<SavedView> = {}): SavedView => ({
  id: 'v1',
  name: 'Drafts',
  contentTypeApiId: 'article',
  visibility: 'personal',
  createdBy: 'ada',
  query: {},
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('the entries list URL', () => {
  it('reads the Preview API’s own query string, and writes it back the same', () => {
    const url =
      'view=v1&fields.title[match]=cat&sys.status=draft&fields.tags[in]=a,b&fields.rank[exists]=false' +
      '&order=-sys.updatedAt,fields.title&query=launch&columns=sys.status,rank&space=s1&next=me';
    const state = listStateFromParams(new URLSearchParams(url));
    expect(state).toEqual({
      viewId: 'v1',
      columns: ['sys.status', 'rank'],
      query: {
        filters: [
          { field: 'title', op: 'match', value: 'cat' },
          { field: 'sys.status', op: 'eq', value: 'draft' },
          { field: 'tags', op: 'in', value: ['a', 'b'] },
          { field: 'rank', op: 'exists', value: false },
        ],
        order: [
          { field: 'sys.updatedAt', direction: 'desc' },
          { field: 'title', direction: 'asc' },
        ],
        search: 'launch',
        // Kept, never sent; the connection's `space` is the client's, not the list's.
        extra: { next: 'me' },
      },
    });
    expect(listStateFromParams(listStateToParams(state))).toEqual(state);
  });

  it('carries a where tree through as JSON, and drops one that isn’t', () => {
    const where = { or: [{ field: 'title', op: 'startsWith', value: 'A' }] };
    const params = listStateToParams({ query: { where } });
    expect(listStateFromParams(params).query.where).toEqual(where);
    expect(listStateFromParams(new URLSearchParams('where={nope')).query).toEqual({});
  });

  it('opens a view as its URL, and saves the URL back as the view’s structured query', () => {
    const saved = view({
      query: {
        filters: [{ field: 'rank', op: 'gt', value: 3 }],
        order: [{ field: 'title', direction: 'asc' }],
        extra: { assignee: 'me' },
      },
      columns: ['rank'],
    });
    const state = viewToListState(saved);
    expect(listStateToParams(state).toString()).toBe(
      'view=v1&fields.rank%5Bgt%5D=3&order=fields.title&assignee=me&columns=rank',
    );
    expect(matchesView(state, saved)).toBe(true);
    // A link to it reads back as the same view, unchanged.
    expect(matchesView(listStateFromParams(listStateToParams(state)), saved)).toBe(true);
    expect(matchesView({ ...state, columns: undefined }, saved)).toBe(false);
    expect(listQueryToViewQuery(state.query, saved.query)).toEqual({
      filters: [{ field: 'rank', op: 'gt', value: 3 }],
      order: [{ field: 'title', direction: 'asc' }],
      extra: { assignee: 'me' },
    });
  });

  it('never lets a view’s extra act: a filter, a tree, the trash, a space or a page size', () => {
    const saved = view({
      query: {
        extra: {
          where: '{"field":"salary","op":"gt","value":0}',
          order: '-fields.salary',
          query: 'secret',
          trashed: 'true',
          view: 'someone-elses',
          columns: 'salary',
          space: 'other',
          env: 'other',
          locale: 'de',
          limit: 1,
          skip: 5,
          select: 'fields.salary',
          content_type: 'staff',
          since: '2020',
          links_to_entry: 'e1',
          'fields.salary[gt]': 0,
          'sys.status': 'draft',
          'metadata.tags[in]': 't1',
          'metadata.tags.slug': 'news',
          assignee: 'me',
        },
      },
    });
    const state = viewToListState(saved);
    expect(state.query).toEqual({ extra: { assignee: 'me' } });
    const params = listStateToParams(state);
    expect(params.toString()).toBe('view=v1&assignee=me');
    // A state that somehow holds one still doesn't write it, and the URL reads back clean.
    const forced = listStateToParams({
      query: { extra: { where: '{}', 'fields.salary[gt]': '0', trashed: 'true', assignee: 'me' } },
    });
    expect(forced.toString()).toBe('assignee=me');
    const read = listStateFromParams(params).query;
    expect(read.filters).toBeUndefined();
    expect(read.where).toBeUndefined();
    expect(read.trashed).toBeUndefined();
    expect(read.extra).toEqual({ assignee: 'me' });
  });

  it('keeps the Preview API’s control parameters out of extra', () => {
    const url =
      'limit=5&skip=2&select=fields.title&content_type=page&since=2020&cursor=c&preview_token=t' +
      '&fields.title[nope]=x&metadata.tags.slug=news&assignee=me';
    expect(listStateFromParams(new URLSearchParams(url)).query).toEqual({
      extra: { assignee: 'me' },
    });
  });

  it('keeps several any-field filters ANDed, through the URL and back into a save', () => {
    const refs = [
      { field: '*', op: 'ref' as const, value: 'e1' },
      { field: '*', op: 'refIn' as const, value: ['e2', 'e3'] },
    ];
    const where = { field: 'rank', op: 'gt' as const, value: 3 };
    const query = { filters: [...refs, { field: 'team', op: 'eq' as const, value: 'a' }], where };
    const refsView = view({ query });
    const opened = viewToListState(refsView);
    expect(opened.query.linksToEntry).toBeUndefined();

    const state = listStateFromParams(listStateToParams(opened));
    expect(state.query.where).toEqual({ and: [...refs, where] });
    expect(entryQueryParams(state.query).get('links_to_entry')).toBeNull();
    expect(JSON.parse(entryQueryParams(state.query).get('where') as string)).toEqual({
      and: [...refs, where],
    });
    expect(matchesView(state, refsView)).toBe(true);

    const saved = listQueryToViewQuery(state.query, query);
    expect(saved.where).toEqual(where);
    expect(saved.filters).toEqual(expect.arrayContaining(query.filters));
    expect(saved.filters).toHaveLength(3);
  });

  it('keeps a saved extra value verbatim while the URL still spells it', () => {
    const saved = { extra: { rank: 3, tags: ['a', 'b'], flag: false, gone: 'x' } };
    const opened = viewToListState(view({ query: saved }));
    expect(listQueryToViewQuery(opened.query, saved).extra).toEqual(saved.extra);
    const edited = { extra: { rank: '4', tags: 'a,b', constructor: 'x' } };
    expect(listQueryToViewQuery(edited, saved).extra).toEqual({
      rank: '4',
      tags: ['a', 'b'],
      constructor: 'x',
    });
  });

  it('sends links_to_entry to the list, and saves it as the any-field filter it is', () => {
    const state = listStateFromParams(new URLSearchParams('links_to_entry=e1,e2'));
    expect(state.query).toEqual({ linksToEntry: ['e1', 'e2'] });
    expect(listStateToParams(state).get('links_to_entry')).toBe('e1,e2');
    expect(entryQueryParams(state.query).get('links_to_entry')).toBe('e1,e2');
    const saved = listQueryToViewQuery(state.query);
    expect(saved).toEqual({ filters: [{ field: '*', op: 'refIn', value: ['e1', 'e2'] }] });
    const opened = viewToListState(view({ query: saved }));
    expect(opened.query).toEqual({ linksToEntry: ['e1', 'e2'] });
    expect(listQueryToViewQuery({ linksToEntry: ['e1'] }).filters).toEqual([
      { field: '*', op: 'ref', value: 'e1' },
    ]);
  });

  it('reads Mine from the URL, and saves it as the filter each reader runs as their own', () => {
    const state = listStateFromParams(new URLSearchParams('sys.createdBy=me&sys.status=draft'));
    expect(state.query).toEqual({
      filters: [{ field: 'sys.status', op: 'eq', value: 'draft' }],
      mine: true,
    });
    expect(listStateToParams(state).get('sys.createdBy')).toBe('me');
    const saved = listQueryToViewQuery(state.query);
    expect(saved.filters).toContainEqual({ field: 'sys.createdBy', op: 'eq', value: 'me' });
    expect(viewToListState(view({ query: saved })).query).toEqual(state.query);
    // Someone else's id is an ordinary filter.
    expect(listStateFromParams(new URLSearchParams('sys.createdBy=u1')).query.mine).toBeUndefined();
  });

  it('sends every filter on one key to the list', () => {
    const params = entryQueryParams({
      filters: [
        { field: 'rank', op: 'gt', value: '1' },
        { field: 'rank', op: 'gt', value: '2' },
        { field: 'tags', op: 'eq', value: 'a' },
        { field: 'tags', op: 'eq', value: 'b' },
      ],
    });
    expect(params.getAll('fields.rank[gt]')).toEqual(['1', '2']);
    expect(params.getAll('fields.tags')).toEqual(['a', 'b']);
  });

  it('keeps an unchanged filter’s typed comparand on a re-save, through the URL and back', () => {
    const query: SavedView['query'] = {
      filters: [
        { field: 'rank', op: 'gt', value: 3 },
        { field: 'live', op: 'eq', value: true },
        { field: 'rank', op: 'between', value: [1, 9] },
        { field: 'title', op: 'match', value: '' },
        { field: 'subtitle', op: 'eq', value: null as never },
      ],
    };
    const state = listStateFromParams(listStateToParams(viewToListState(view({ query }))));
    expect(listQueryToViewQuery(state.query, query)).toEqual(query);
  });

  it('stores what changed as typed, and each saved filter for one filter only', () => {
    const query: SavedView['query'] = { filters: [{ field: 'rank', op: 'gt', value: 3 }] };
    expect(
      listQueryToViewQuery(
        {
          filters: [
            { field: 'rank', op: 'gt', value: '3' },
            { field: 'rank', op: 'gt', value: '3' },
            { field: 'rank', op: 'lt', value: '9' },
            { field: 'title', op: 'match', value: '' },
          ],
        },
        query,
      ).filters,
    ).toEqual([
      { field: 'rank', op: 'gt', value: 3 },
      { field: 'rank', op: 'gt', value: '3' },
      { field: 'rank', op: 'lt', value: '9' },
    ]);
  });

  it('leaves a half-typed filter out of a saved view', () => {
    expect(
      listQueryToViewQuery({
        filters: [
          { field: 'title', op: 'eq', value: '' },
          { field: 'rank', op: 'exists', value: true },
        ],
        trashed: true,
      }),
    ).toEqual({ filters: [{ field: 'rank', op: 'exists', value: true }] });
  });
});
