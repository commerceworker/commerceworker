// What a deployed workspace answers before its first admin exists: the setup page and the requests
// it makes itself, so its form can be submitted; nothing else.
import { describe, expect, it } from 'vitest';
import { answersBeforeSetup } from '~/lib/setup-gate';

describe('answersBeforeSetup', () => {
  it('lets the setup page load, submit its form and find its routes', () => {
    for (const p of ['/setup', '/setup.data', '/__manifest', '/_static/root-abc123.js'])
      expect(answersBeforeSetup(p), p).toBe(true);
  });

  it('keeps every other page and data request behind the gate', () => {
    for (const p of [
      '/',
      '/login',
      '/login.data',
      '/dashboard',
      '/setup/x',
      '/setupx',
      '/setup.datax',
      '/spaces',
      // The asset library is a page like any other, not a built file.
      '/assets',
      '/assets/0198c0de-0000-7000-8000-000000000000',
    ])
      expect(answersBeforeSetup(p), p).toBe(false);
  });
});
