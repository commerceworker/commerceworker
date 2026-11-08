import { describe, expect, it } from 'vitest';
import {
  authorizeEveryContentType,
  type ContentTypeGrant,
  canRunEntryBulkJob,
  ENTRY_BULK_JOB_KINDS,
  entryBulkJobsFor,
  ForbiddenError,
  holdsOnEveryContentType,
  type Principal,
  rolePresetDefinition,
  SCOPES,
  unwritableFields,
} from '../src/index';

/**
 * Who may run a bulk job over entries: no per-type grants, or exactly one `*` grant holding every
 * action the job needs and restricting no field. A job can't be authorized entry by entry, and its
 * report names entries of every type.
 */
const member = (contentGrants: readonly ContentTypeGrant[] | undefined): Principal => ({
  spaceId: 's1',
  kind: 'user',
  scopes: [SCOPES.contentWrite, SCOPES.contentPublish],
  ...(contentGrants ? { contentGrants } : {}),
});
const preset = (name: 'viewer' | 'editor' | 'manager' | 'admin') =>
  member(rolePresetDefinition(name).contentGrants);

describe('who may run a bulk job over entries', () => {
  it('lets a principal with no per-type grants run every kind', () => {
    expect(entryBulkJobsFor(member(undefined))).toEqual(ENTRY_BULK_JOB_KINDS);
  });

  it('lets the Administrator, Manager and Editor presets run every kind', () => {
    for (const name of ['admin', 'manager', 'editor'] as const) {
      expect(entryBulkJobsFor(preset(name)), name).toEqual([
        'publish',
        'unpublish',
        'trash',
        'restore',
        'purge',
      ]);
    }
  });

  it('refuses the Viewer preset every kind', () => {
    expect(entryBulkJobsFor(preset('viewer'))).toEqual([]);
  });

  it('refuses trash and purge to a `*` grant that withholds delete', () => {
    const p = member([
      { contentTypeApiId: '*', actions: ['read', 'write', 'publish'], deniedActions: ['delete'] },
    ]);
    expect(canRunEntryBulkJob(p, 'trash')).toBe(false);
    expect(canRunEntryBulkJob(p, 'purge')).toBe(false);
    expect(canRunEntryBulkJob(p, 'restore')).toBe(true);
    expect(canRunEntryBulkJob(p, 'publish')).toBe(true);
  });

  it('refuses unpublish to a `*` grant that withholds it, and everything but restore to a writer', () => {
    const noUnpublish = member([
      {
        contentTypeApiId: '*',
        actions: ['read', 'write', 'publish'],
        deniedActions: ['unpublish'],
      },
    ]);
    expect(canRunEntryBulkJob(noUnpublish, 'unpublish')).toBe(false);
    // Trashing takes live entries offline, so withholding unpublish refuses a trash job too, as
    // authorizeTrash refuses one live entry; restore, purge and publish stay.
    expect(canRunEntryBulkJob(noUnpublish, 'trash')).toBe(false);
    expect(entryBulkJobsFor(noUnpublish)).toEqual(['publish', 'restore', 'purge']);
    const writer = member([{ contentTypeApiId: '*', actions: ['read', 'write'] }]);
    // A writer holds delete with write, so it may trash, but not publish or purge.
    expect(entryBulkJobsFor(writer)).toEqual(['trash', 'restore']);
  });

  it('refuses any field rule, a type-specific grant, or a grant on one type alone', () => {
    const all = ['read', 'write', 'publish'] as const;
    expect(
      entryBulkJobsFor(
        member([{ contentTypeApiId: '*', actions: [...all], deniedFields: ['secret'] }]),
      ),
    ).toEqual([]);
    expect(
      entryBulkJobsFor(
        member([{ contentTypeApiId: '*', actions: [...all], readOnlyFields: ['slug'] }]),
      ),
    ).toEqual([]);
    expect(
      entryBulkJobsFor(
        member([
          { contentTypeApiId: '*', actions: [...all] },
          { contentTypeApiId: 'post', actions: ['read'] },
        ]),
      ),
    ).toEqual([]);
    expect(entryBulkJobsFor(member([{ contentTypeApiId: 'post', actions: [...all] }]))).toEqual([]);
    expect(entryBulkJobsFor(member([]))).toEqual([]);
  });
});

describe('who may act on every content type alike', () => {
  const WRITES = ['read', 'write', 'publish'] as const;

  it('passes a principal with no per-type grants, and one full `*` grant', () => {
    expect(holdsOnEveryContentType(member(undefined), ['write', 'publish'])).toBe(true);
    expect(holdsOnEveryContentType(preset('manager'), ['read', 'write', 'publish'])).toBe(true);
  });

  it('refuses a grant that misses an action, names a type or restricts a field', () => {
    expect(holdsOnEveryContentType(preset('viewer'), ['write'])).toBe(false);
    const narrow = member([{ contentTypeApiId: 'post', actions: WRITES }]);
    expect(holdsOnEveryContentType(narrow, ['write'])).toBe(false);
    const extra = member([
      { contentTypeApiId: '*', actions: WRITES },
      { contentTypeApiId: 'post', actions: ['read'] },
    ]);
    expect(holdsOnEveryContentType(extra, ['write'])).toBe(false);
    for (const rule of [{ deniedFields: ['x'] }, { readOnlyFields: ['x'] }]) {
      const restricted = member([{ contentTypeApiId: '*', actions: WRITES, ...rule }]);
      expect(holdsOnEveryContentType(restricted, ['read'])).toBe(false);
      expect(() => authorizeEveryContentType(restricted, ['read'])).toThrow(ForbiddenError);
    }
  });
});

describe('which fields a role may not write', () => {
  it('lists the denied and read-only fields among those given, and nothing when unrestricted', () => {
    const role = member([
      {
        contentTypeApiId: 'post',
        actions: ['read', 'write'],
        deniedFields: ['a'],
        readOnlyFields: ['b'],
      },
    ]);
    expect(unwritableFields(role, 'post', { a: 1, b: 2, c: 3 })).toEqual(['a', 'b']);
    expect(unwritableFields(member(undefined), 'post', { a: 1 })).toEqual([]);
  });
});
