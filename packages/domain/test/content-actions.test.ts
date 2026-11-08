import { describe, expect, it } from 'vitest';
import {
  assertCanGrant,
  authorizeContent,
  authorizeTrash,
  CONTENT_ACTIONS,
  type ContentAction,
  type ContentTypeGrant,
  canAccessContentType,
  ENTRY_OPERATION_ACTIONS,
  grantedActions,
  type ListedContentAction,
  type Principal,
  ROLE_PRESET_DEFINITIONS,
  SCOPES,
} from '../src/index';

const roleWith = (...grants: ContentTypeGrant[]): Principal => ({
  spaceId: 's1',
  kind: 'cma',
  scopes: [SCOPES.contentWrite, SCOPES.contentPublish, SCOPES.spaceAdmin],
  contentGrants: grants,
});

const draft = { contentTypeApiId: 'post', publishedVersion: null };
const live = { contentTypeApiId: 'post', publishedVersion: 3 };

/** Every subset of the actions a grant could list before `delete` and `unpublish` existed. */
const LEGACY_LISTS: ListedContentAction[][] = [[], ['read'], ['write'], ['publish']]
  .flatMap((l) => [l, [...l, 'read']])
  .flatMap((l) => [l, [...l, 'write']])
  .flatMap((l) => [l, [...l, 'publish']])
  .map((l) => [...new Set(l)] as ListedContentAction[]);

/**
 * What each entry operation asked of a grant before this change: trashing was a write, purging and
 * unpublishing were publishes.
 */
const LEGACY_OPERATIONS: Record<string, (held: readonly ListedContentAction[]) => boolean> = {
  read: (h) => h.includes('read'),
  write: (h) => h.includes('write'),
  publish: (h) => h.includes('publish'),
  trash: (h) => h.includes('write'),
  purge: (h) => h.includes('publish'),
  unpublish: (h) => h.includes('publish'),
};

const NOW: Record<string, readonly ContentAction[]> = {
  read: ['read'],
  write: ['write'],
  publish: ['publish'],
  ...ENTRY_OPERATION_ACTIONS,
};

describe('finer content actions: delete and unpublish', () => {
  it('authorizes every operation exactly as before for a grant that withholds nothing', () => {
    for (const actions of LEGACY_LISTS) {
      const principal = roleWith({ contentTypeApiId: 'post', actions });
      for (const [operation, allowedBefore] of Object.entries(LEGACY_OPERATIONS)) {
        const needs = NOW[operation] as readonly ContentAction[];
        expect(
          canAccessContentType(principal, needs, 'post'),
          `${operation} with [${actions.join(', ')}]`,
        ).toBe(allowedBefore(actions));
      }
      // Trashing a live entry, too: no stored grant withholds unpublish.
      const trashLive = () => authorizeTrash(principal, live);
      if (LEGACY_OPERATIONS.trash?.(actions)) expect(trashLive).not.toThrow();
      else expect(trashLive).toThrow();
    }
  });

  it('gives every preset all five actions on every type, unchanged', () => {
    for (const def of ROLE_PRESET_DEFINITIONS) {
      const [grant] = def.contentGrants;
      expect(grant?.deniedActions).toBeUndefined();
      const held = grantedActions(grant as ContentTypeGrant);
      const expected: ContentAction[] = def.contentGrants.some((g) => g.actions.includes('write'))
        ? [...CONTENT_ACTIONS]
        : ['read'];
      expect([...held].sort(), def.preset).toEqual([...expected].sort());
    }
  });

  it('implies delete from write or publish and unpublish from publish', () => {
    expect([...grantedActions({ contentTypeApiId: '*', actions: ['read'] })]).toEqual(['read']);
    expect(grantedActions({ contentTypeApiId: '*', actions: ['write'] })).toEqual(
      new Set(['write', 'delete']),
    );
    expect(grantedActions({ contentTypeApiId: '*', actions: ['publish'] })).toEqual(
      new Set(['publish', 'delete', 'unpublish']),
    );
  });

  it('lets a role write but not delete', () => {
    const writer = roleWith({
      contentTypeApiId: 'post',
      actions: ['read', 'write', 'publish'],
      deniedActions: ['delete'],
    });
    expect(() => authorizeContent(writer, 'write', 'post')).not.toThrow();
    expect(() => authorizeTrash(writer, draft)).toThrow(/content:delete:post/);
    expect(() => authorizeContent(writer, ENTRY_OPERATION_ACTIONS.purge, 'post')).toThrow(
      /content:delete:post/,
    );
    // Withholding delete leaves unpublish alone.
    expect(() => authorizeContent(writer, 'unpublish', 'post')).not.toThrow();
  });

  it('lets a role publish but not unpublish, including by trashing a live entry', () => {
    const publisher = roleWith({
      contentTypeApiId: 'post',
      actions: ['read', 'write', 'publish'],
      deniedActions: ['unpublish'],
    });
    expect(() => authorizeContent(publisher, 'publish', 'post')).not.toThrow();
    expect(() => authorizeContent(publisher, 'unpublish', 'post')).toThrow(
      /content:unpublish:post/,
    );
    // A draft is trashed as before; a live one would come down with it.
    expect(() => authorizeTrash(publisher, draft)).not.toThrow();
    expect(() => authorizeTrash(publisher, live)).toThrow(/content:unpublish:post/);
    expect(() => authorizeContent(publisher, ENTRY_OPERATION_ACTIONS.purge, 'post')).not.toThrow();
  });

  it('resolves the withhold on the grant that governs the type', () => {
    const principal = roleWith(
      { contentTypeApiId: 'post', actions: ['read', 'write'], deniedActions: ['delete'] },
      { contentTypeApiId: '*', actions: ['read', 'write'] },
    );
    expect(canAccessContentType(principal, 'delete', 'post')).toBe(false);
    expect(canAccessContentType(principal, 'delete', 'page')).toBe(true);
  });

  it('passes unrestricted principals through every operation', () => {
    const root: Principal = { spaceId: '*', kind: 'admin', scopes: [] };
    for (const needs of Object.values(ENTRY_OPERATION_ACTIONS)) {
      expect(canAccessContentType(root, needs, 'post')).toBe(true);
    }
    expect(() => authorizeTrash(root, live)).not.toThrow();
  });

  it('keeps an inviter from handing out an action they withhold', () => {
    const inviter: Principal = {
      ...roleWith({
        contentTypeApiId: '*',
        actions: ['read', 'write', 'publish'],
        deniedActions: ['delete'],
      }),
      kind: 'user',
      subject: 'ada',
    };
    const grant = (contentGrants: ContentTypeGrant[]) => ({
      spaceId: 's1',
      scopes: [],
      contentGrants,
    });
    // Implies delete, which the inviter withholds.
    expect(() =>
      assertCanGrant(inviter, 'member', [
        grant([{ contentTypeApiId: 'post', actions: ['read', 'write'] }]),
      ]),
    ).toThrow(/beyond your own/);
    expect(() =>
      assertCanGrant(inviter, 'member', [
        grant([
          { contentTypeApiId: 'post', actions: ['read', 'write'], deniedActions: ['delete'] },
        ]),
      ]),
    ).not.toThrow();
  });
  it('holds an inviter to the grant that governs each type, not any grant they hold', () => {
    const inviter: Principal = {
      ...roleWith(
        { contentTypeApiId: 'post', actions: ['read', 'write'], deniedActions: ['delete'] },
        { contentTypeApiId: '*', actions: ['read', 'write'] },
      ),
      kind: 'user',
      subject: 'ada',
    };
    const grant = (contentGrants: ContentTypeGrant[]) => ({
      spaceId: 's1',
      scopes: [],
      contentGrants,
    });
    // Delete on post is withheld by the post grant; the wildcard's delete doesn't lend it.
    expect(() =>
      assertCanGrant(inviter, 'member', [
        grant([{ contentTypeApiId: 'post', actions: ['read', 'write'] }]),
      ]),
    ).toThrow(/beyond your own/);
    // A wildcard would reach post too, where the inviter can't delete.
    expect(() =>
      assertCanGrant(inviter, 'member', [
        grant([{ contentTypeApiId: '*', actions: ['read', 'write'] }]),
      ]),
    ).toThrow(/beyond your own/);
    // Within both: the wildcard everywhere but post, post as the inviter holds it.
    expect(() =>
      assertCanGrant(inviter, 'member', [
        grant([
          { contentTypeApiId: '*', actions: ['read', 'write'] },
          { contentTypeApiId: 'post', actions: ['read', 'write'], deniedActions: ['delete'] },
        ]),
      ]),
    ).not.toThrow();
    expect(() =>
      assertCanGrant(inviter, 'member', [
        grant([{ contentTypeApiId: 'page', actions: ['read', 'write'] }]),
      ]),
    ).not.toThrow();
  });
});
