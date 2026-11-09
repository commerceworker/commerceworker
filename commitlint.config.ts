import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RuleConfigSeverity, type UserConfig } from '@commitlint/types';

// Commit messages follow Conventional Commits (https://www.conventionalcommits.org):
// `type(scope): subject`, e.g. `feat(engine): cancel an order as a use-case`. The scope is
// optional; when given it names a workspace package (its package.json name without
// `@commerceworker/`) or one of the repo-wide areas below. The commit-msg hook (.githooks/) checks
// each commit locally and CI checks every commit a pull request adds.

const root = import.meta.dirname;

/** Workspace package names without the `@commerceworker/` prefix, from pnpm-workspace.yaml's globs. */
function packageScopes(): string[] {
  const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const dirs = [...workspace.matchAll(/^\s+-\s+["']?([^"'\n]+)\/\*["']?\s*$/gm)].map(
    (m) => m[1] ?? '',
  );
  const scopes: string[] = [];
  for (const dir of dirs) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const { name } = JSON.parse(
          readFileSync(join(root, dir, entry.name, 'package.json'), 'utf8'),
        );
        if (typeof name === 'string') scopes.push(name.replace(/^@commerceworker\//, ''));
      } catch {}
    }
  }
  return scopes;
}

/** Areas that span the repo rather than one package. */
const REPO_SCOPES = ['repo', 'ci', 'deps', 'fleet', 'toolkit', 'release'];

const config: UserConfig = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [RuleConfigSeverity.Error, 'always', [...REPO_SCOPES, ...packageScopes()].sort()],
  },
};

export default config;
