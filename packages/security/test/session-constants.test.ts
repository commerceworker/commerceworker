import { expect, test } from 'vitest';
// The commerce stack's roles module has no imports, so the two are read side by side here without
// this package depending on core.
import * as commerce from '../../core/src/roles';
import * as content from '../src/principal';
import * as contentRoles from '../src/roles';

// Two stacks, two sets of trust-boundary primitives (commerce: packages/core/src/roles.ts; content:
// packages/security). They are not merged until the stacks converge, but a person signed in to one
// admin must be held to the same session rules as in the other, and a development key that differs
// would split a local dev session in two. This holds the shared values equal.

test('both stacks end a session at the same maximum and idle lifetimes', () => {
  expect(commerce.SESSION_MAX_MS).toBe(contentRoles.SESSION_MAX_MS);
  expect(commerce.SESSION_IDLE_MS).toBe(contentRoles.SESSION_IDLE_MS);
  expect(commerce.SESSION_IDLE_ADMIN_MS).toBe(contentRoles.SESSION_IDLE_ADMIN_MS);
  expect(commerce.SESSION_TOUCH_MS).toBe(contentRoles.SESSION_TOUCH_MS);
});

test('an admin is idled out sooner than anyone else, in both stacks', () => {
  expect(commerce.sessionIdleMs('admin')).toBe(contentRoles.sessionIdleMs('admin'));
  for (const role of ['viewer', 'approver', 'operator'] as const)
    expect(commerce.sessionIdleMs(role)).toBe(contentRoles.sessionIdleMs('member'));
  expect(commerce.SESSION_IDLE_ADMIN_MS).toBeLessThan(commerce.SESSION_IDLE_MS);
});

test('a forwarded principal is good for the same time, and local dev shares one key', () => {
  expect(commerce.PRINCIPAL_TTL_MS).toBe(content.PRINCIPAL_TTL_S * 1000);
  expect(commerce.DEV_PRINCIPAL_KEY).toBe(content.DEV_PRINCIPAL_KEY);
});

test('the differences that remain are the intended ones', () => {
  // Different headers: each stack's engine or api accepts only its own envelope, so a principal
  // signed for one is never read by the other.
  expect(commerce.PRINCIPAL_HEADER).not.toBe(content.PRINCIPAL_HEADER);
  // Commerce has four ordered roles (viewer to admin); the content stack has two (member, admin),
  // with content permissions resolved per space by the api.
  expect([...commerce.ROLES]).toEqual(['viewer', 'approver', 'operator', 'admin']);
  expect([...contentRoles.ROLES]).toEqual(['member', 'admin']);
});
