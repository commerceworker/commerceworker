import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkg = fileURLToPath(new URL('..', import.meta.url));

describe('src/generated/limits.ts', () => {
  // The generator reads core and the delivery app's source, so it runs in its own process (tsx), as
  // the commerce client's does, instead of pulling that source into this package's bundle.
  it('is what the catalog edge enforces today', () => {
    const run = spawnSync('pnpm', ['exec', 'tsx', 'scripts/generate.ts', '--check'], {
      cwd: pkg,
      encoding: 'utf8',
    });
    expect(run.stderr + run.stdout).toContain('is current');
    expect(run.status).toBe(0);
  }, 60_000);
});
