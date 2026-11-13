import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { sweep } from '../src/retention';

describe('retention sweep isolation', () => {
  it('reports each failing step by name and still runs the ones after it', async () => {
    await env.DOCS.put('plugin-exports/iso-plugin/a.ndjson', 'x');
    await env.DOCS.put('intake/iso-channel/a.json', 'x');
    // D1 refuses every statement: each step that reads it fails, and the export and intake expiries
    // (R2) are the last steps, so they only run if the failures before them didn't stop the sweep.
    const downDb = {
      prepare: () => {
        throw new Error('D1 is down');
      },
      batch: () => Promise.reject(new Error('D1 is down')),
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const swept = await sweep(
      { ...env, DB: downDb } as unknown as Env,
      Date.now() + 31 * 86_400_000,
    );
    const logged = errors.mock.calls.map((c) => String(c[0]));
    errors.mockRestore();

    expect(swept.failed).toEqual(expect.arrayContaining(['pruned', 'cardHolds', 'secrets']));
    expect(swept.failed).not.toContain('pluginExports');
    expect(swept.secrets).toBeNull();
    for (const name of swept.failed)
      expect(logged.some((l) => l.includes(`"step":"${name}"`))).toBe(true);
    expect(swept.pluginExports).toBe(1);
    expect(swept.failed).not.toContain('intakeBodies');
    expect(swept.intakeBodies).toBeGreaterThanOrEqual(1);
    expect((await env.DOCS.list({ prefix: 'intake/iso-channel/' })).objects).toHaveLength(0);
    expect((await env.DOCS.list({ prefix: 'plugin-exports/iso-plugin/' })).objects).toHaveLength(0);
  });
});
