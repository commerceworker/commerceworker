import { describe, expect, it } from 'vitest';
import {
  assertWritableFields,
  authorize,
  authorizeApproval,
  authorizeContent,
  canAccessContentType,
  grantFor,
  maskDeniedFields,
  type Principal,
  ROLE_PRESET_DEFINITIONS,
  SCOPES,
  scopesForKind,
} from '../src/index';

const unrestricted: Principal = {
  spaceId: 's1',
  kind: 'cma',
  scopes: [SCOPES.contentWrite],
};

const editor: Principal = {
  spaceId: 's1',
  kind: 'cma',
  scopes: [SCOPES.contentWrite, SCOPES.previewRead],
  contentGrants: [
    {
      contentTypeApiId: 'post',
      actions: ['read', 'write'],
      deniedFields: ['internalNotes'],
      readOnlyFields: ['slug'],
    },
    { contentTypeApiId: '*', actions: ['read'] },
  ],
};

describe('granular RBAC: content grants', () => {
  it('an exact content-type grant wins over the wildcard', () => {
    expect(grantFor(editor, 'post')?.actions).toEqual(['read', 'write']);
    expect(grantFor(editor, 'page')?.actions).toEqual(['read']);
  });

  it('unrestricted principals pass every content check', () => {
    expect(canAccessContentType(unrestricted, 'publish', 'anything')).toBe(true);
    expect(() => authorizeContent(unrestricted, 'write', 'anything')).not.toThrow();
    expect(() => assertWritableFields(unrestricted, 'post', { internalNotes: {} })).not.toThrow();
  });

  it('denies ungranted actions and types', () => {
    expect(canAccessContentType(editor, 'publish', 'post')).toBe(false);
    expect(canAccessContentType(editor, 'write', 'page')).toBe(false);
    expect(() => authorizeContent(editor, 'publish', 'post')).toThrow(/content:publish:post/);
  });

  it('masks denied fields on read but keeps the rest', () => {
    const fields = { title: { 'en-US': 'T' }, internalNotes: { 'en-US': 'secret' } };
    const masked = maskDeniedFields(editor, 'post', fields);
    expect(Object.keys(masked)).toEqual(['title']);
    // Another type without field rules is untouched.
    expect(maskDeniedFields(editor, 'page', fields)).toEqual(fields);
  });

  it('rejects writes to denied and read-only fields', () => {
    expect(() => assertWritableFields(editor, 'post', { title: {} })).not.toThrow();
    expect(() => assertWritableFields(editor, 'post', { internalNotes: {} })).toThrow(
      /internalNotes/,
    );
    expect(() => assertWritableFields(editor, 'post', { slug: {} })).toThrow(/slug/);
  });

  it('coarse authorize is unchanged by grants', () => {
    expect(() => authorize(editor, SCOPES.contentWrite, 's1')).not.toThrow();
    expect(() => authorize(editor, SCOPES.spaceAdmin, 's1')).toThrow();
  });
});

describe('approvals and presets', () => {
  const as = (scopes: string[], spaceId = 's1'): Principal => ({ spaceId, kind: 'user', scopes });

  it('meets workflow:approve with that scope alone, checked against a read grant', () => {
    expect(authorizeApproval(as([SCOPES.workflowApprove]), SCOPES.workflowApprove, 's1')).toBe(
      'read',
    );
    expect(() =>
      authorizeApproval(as([SCOPES.contentPublish]), SCOPES.workflowApprove, 's1'),
    ).toThrow(/workflow:approve/);
    expect(() =>
      authorizeApproval(as([SCOPES.contentWrite]), SCOPES.workflowApprove, 's1'),
    ).toThrow(/workflow:approve/);
    expect(() =>
      authorizeApproval(as([SCOPES.workflowApprove], 's2'), SCOPES.workflowApprove, 's1'),
    ).toThrow();
  });

  it('requires any other scope exactly as named', () => {
    expect(() =>
      authorizeApproval(as([SCOPES.workflowApprove]), SCOPES.contentPublish, 's1'),
    ).toThrow(/content:publish/);
    expect(authorizeApproval(as([SCOPES.contentWrite]), SCOPES.contentWrite, 's1')).toBe('write');
    expect(authorizeApproval(as([SCOPES.contentPublish]), SCOPES.contentPublish, 's1')).toBe(
      'publish',
    );
  });

  it('gives management keys and the Administrator preset every scope', () => {
    const all = new Set(Object.values(SCOPES));
    expect(new Set(scopesForKind('cma'))).toEqual(all);
    expect(new Set(ROLE_PRESET_DEFINITIONS.at(-1)?.scopes)).toEqual(all);
  });
});
