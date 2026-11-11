/**
 * CI's device tests run in Playwright's own container image (.github/workflows/ci.yml), whose
 * browsers are built for one Playwright release. A suite on another release fails to find its
 * browser, so the image's tag must be the catalog's @playwright/test version. Dependabot bumps the
 * catalog, not the image: this fails that pull request until the tag and digest move with it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';

const root = join(import.meta.dirname, '..');

it("CI's Playwright image is the catalog's Playwright version, pinned by digest", () => {
  const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const version = /^\s*'@playwright\/test':\s*([\d.]+)\s*$/m.exec(workspace)?.[1];
  assert.ok(version, "pnpm-workspace.yaml's catalog pins @playwright/test to an exact version");

  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const images = [...ci.matchAll(/image:\s*mcr\.microsoft\.com\/playwright:(\S+)/g)].map(
    (m) => m[1],
  );
  assert.equal(images.length, 1, 'ci.yml names one Playwright image');
  const match = /^v([\d.]+)-[a-z]+@sha256:[0-9a-f]{64}$/.exec(images[0] ?? '');
  assert.ok(match, `the image is a v<version>-<ubuntu> tag pinned by digest: ${images[0]}`);
  assert.equal(
    match[1],
    version,
    `ci.yml's Playwright image is v${match[1]}, the catalog's @playwright/test is ${version}: move the tag and digest`,
  );
});
