/**
 * Regenerates the docs' Starlight theme and the diagrams' Mermaid themes from the Ledger tokens:
 *
 *   pnpm sync:theme
 *
 * The docs site's src/styles/theme.css (Starlight loads it through `customCss`) and
 * docs/diagrams/themes/ledger-{light,dark}.json (mermaid-cli's `-c`) are gitignored build outputs,
 * so two PRs that change tokens can't conflict on them: `pnpm install` (postinstall) and turbo's
 * `generate` task, which runs before every check-types, test, build and dev, write them.
 * tests/tokens.test.ts fails when one is stale, and a PreToolUse hook blocks hand edits.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mermaidThemeJson } from '../src/mermaid';
import { starlightThemeCss } from '../src/tokens';

const write = (relative: string, text: string) => {
  const file = fileURLToPath(new URL(`../../../${relative}`, import.meta.url));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  console.log(`wrote ${file} (${text.split('\n').length} lines)`);
};

write('apps/docs/src/styles/theme.css', starlightThemeCss());
for (const scheme of ['light', 'dark'] as const) {
  write(`docs/diagrams/themes/ledger-${scheme}.json`, mermaidThemeJson(scheme));
}
