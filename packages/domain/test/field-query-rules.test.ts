import { describe, expect, it } from 'vitest';
import { assertQueryRespectsFieldRules, ForbiddenError, type Principal } from '../src/index';

const restricted: Principal = {
  spaceId: 's1',
  kind: 'cda',
  scopes: ['delivery:read'],
  contentGrants: [{ contentTypeApiId: 'post', actions: ['read'], deniedFields: ['salary'] }],
};
const open: Principal = { spaceId: 's1', kind: 'cda', scopes: ['delivery:read'] };

describe('assertQueryRespectsFieldRules', () => {
  it('refuses filters, ordering, projection and search touching a hidden field', () => {
    const t = 'post';
    for (const q of [
      { contentTypeApiId: t, filters: [{ field: 'salary' }] },
      { contentTypeApiId: t, filters: [{ field: 'salary.amount' }] },
      { contentTypeApiId: t, order: [{ field: 'fields.salary' }] },
      { contentTypeApiId: t, select: ['salary'] },
      { contentTypeApiId: t, search: 'x' },
    ]) {
      expect(() => assertQueryRespectsFieldRules(restricted, q)).toThrow(ForbiddenError);
    }
  });

  it('allows readable fields, sys.* fields, and types without field rules', () => {
    expect(() =>
      assertQueryRespectsFieldRules(restricted, {
        contentTypeApiId: 'post',
        filters: [{ field: 'title' }, { field: 'sys.id' }],
        order: [{ field: 'sys.publishedAt' }],
      }),
    ).not.toThrow();
    expect(() =>
      assertQueryRespectsFieldRules(restricted, { contentTypeApiId: 'page', search: 'x' }),
    ).not.toThrow();
    expect(() =>
      assertQueryRespectsFieldRules(open, { filters: [{ field: 'salary' }], search: 'x' }),
    ).not.toThrow();
  });
});
