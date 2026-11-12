import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONTENT_SECRETS, DERIVED, SECRETS } from './fleet.ts';

// .github/workflows/escrow-secrets.yml: its Encrypt step run for real against a stand-in for age,
// plus the shape that keeps the secrets away from everything but that step.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(join(ROOT, '.github/workflows/escrow-secrets.yml'), 'utf8');
const deploy = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8');

const names = (yaml: string) =>
  [...yaml.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1] as string);

/** The Encrypt step's script, with the workflow's indentation removed. */
const lines = (workflow.split('run: |\n').at(-1) as string).split('\n');
const end = lines.findIndex((line) => line !== '' && !line.startsWith('          '));
const script = lines
  .slice(0, end)
  .map((line) => line.slice(10))
  .join('\n');

const dir = mkdtempSync(join(tmpdir(), 'escrow-'));
after(() => rmSync(dir, { recursive: true, force: true }));
// Records its arguments, its environment and what it would have encrypted.
writeFileSync(
  join(dir, 'age'),
  `#!/bin/bash\necho "$*" >'${dir}/args'\n/usr/bin/env >'${dir}/env'\n/bin/cat >'${dir}/plaintext'\n`,
);
chmodSync(join(dir, 'age'), 0o755);

const RECIPIENT = `age1${'q'.repeat(58)}`;
const REQUIRED = {
  PRINCIPAL_KEY: 'principal-value',
  DATA_KEY: 'data-value',
  PASSWORD_PEPPER: 'pw-value',
};
const CONTENT = { TOKEN_PEPPER: 'token-value', MEDIA_SIGNING_SECRET: 'media-value' };

const encrypt = (env: Record<string, string>) => {
  const summary = join(dir, 'summary');
  writeFileSync(summary, '');
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      RUNNER_TEMP: dir,
      GITHUB_STEP_SUMMARY: summary,
      ...env,
    },
  });
  return { ...result, summary: readFileSync(summary, 'utf8') };
};

test('every secret a Worker receives is escrowed, except those derived from another', () => {
  const held = new Set<string>([...Object.values(SECRETS), ...Object.values(CONTENT_SECRETS)].flat());
  for (const name of Object.keys(DERIVED)) held.delete(name);
  assert.ok(held.has('DATA_KEY'));
  assert.deepEqual(names(workflow).sort(), [...held].sort());
  const deployed = names(deploy).filter((name) => !name.startsWith('CLOUDFLARE_'));
  assert.deepEqual(names(workflow).sort(), [...new Set(deployed)].sort());
});

test('a fleet in another repository can call it, naming its own environment', () => {
  assert.match(workflow, /\n {2}workflow_call:\n {4}inputs:\n {6}environment:\n/);
  assert.match(workflow, /\n {6}content:\n(?: {8}.+\n)*? {8}type: boolean\n/);
  assert.match(workflow, /\n {4}environment: \$\{\{ inputs\.environment \}\}\n/);
});

const PINNED = workflow.match(/ESCROW_RECIPIENT: (\S+)\n/)?.[1] as string;

test('the recipient is pinned in the file, so changing it takes a reviewed change', () => {
  assert.doesNotMatch(workflow, /vars\./);
  assert.equal(workflow.match(/ESCROW_RECIPIENT: /g)?.length, 1);
  // Either a real key or the placeholder the owner replaces; anything else is a typo.
  assert.match(PINNED, /^(age1[a-z0-9]{58}|age1-PLACEHOLDER-set-the-owner-public-key)$/);
});

test('the placeholder recipient is refused, with how to make and pin a key', () => {
  rmSync(join(dir, 'plaintext'), { force: true });
  const run = encrypt({
    ESCROW_RECIPIENT: 'age1-PLACEHOLDER-set-the-owner-public-key',
    ...REQUIRED,
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /age-keygen/);
  assert.match(run.stdout, /pin the public half/);
  assert.ok(!existsSync(join(dir, 'plaintext')), 'age must not run');
  // And so is the value the workflow ships with, whatever it is today.
  if (PINNED.startsWith('age1-PLACEHOLDER')) {
    const shipped = encrypt({ ESCROW_RECIPIENT: PINNED, ...REQUIRED });
    assert.equal(shipped.status, 1);
  }
});

test('nothing from the repository runs beside the secrets', () => {
  assert.doesNotMatch(workflow, /actions\/checkout|pnpm |node |apt-get/);
  assert.match(workflow, /AGE_SHA256: [0-9a-f]{64}\n/);
  assert.ok(workflow.indexOf('sha256sum --check') < workflow.indexOf('- name: Encrypt'));
  assert.equal(workflow.match(/\$\{\{ secrets\./g)?.length, names(workflow).length);
  const [before, rest] = workflow.split('- name: Encrypt');
  assert.doesNotMatch(before as string, /\$\{\{ secrets\./);
  assert.doesNotMatch((rest as string).split('upload-artifact')[1] as string, /\$\{\{ secrets\./);
});

test('the only action is pinned to a commit, and the artifact is short-lived ciphertext', () => {
  const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1] as string);
  assert.equal(uses.length, 1);
  assert.match(uses[0] as string, /^actions\/upload-artifact@[0-9a-f]{40}$/);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/escrow\.age/);
  assert.match(workflow, /retention-days: 1\n/);
});

test('the set secrets reach age on stdin alone, and no value is reported', () => {
  const run = encrypt({
    ESCROW_RECIPIENT: RECIPIENT,
    ...REQUIRED,
    ...CONTENT,
    CONTENT: 'true',
    MCP_TOKEN: 'mcp-value==',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    readFileSync(join(dir, 'plaintext'), 'utf8'),
    [
      'PRINCIPAL_KEY=principal-value',
      'DATA_KEY=data-value',
      'PASSWORD_PEPPER=pw-value',
      'TOKEN_PEPPER=token-value',
      'MEDIA_SIGNING_SECRET=media-value',
      'MCP_TOKEN=mcp-value==',
      '',
    ].join('\n'),
  );
  const args = readFileSync(join(dir, 'args'), 'utf8');
  assert.match(args, new RegExp(`--recipient ${RECIPIENT}`));
  assert.match(run.summary, /Escrowed 6 secrets/);
  for (const output of [run.stdout, run.stderr, run.summary, args]) {
    assert.doesNotMatch(output, /-value/);
  }
  assert.doesNotMatch(readFileSync(join(dir, 'env'), 'utf8'), /-value|DATA_KEY/);
});

test('a commerce-only deployment escrows without the content stack secrets', () => {
  const run = encrypt({ ESCROW_RECIPIENT: RECIPIENT, ...REQUIRED, STRIPE_SECRET_KEY: 'sk-value' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.summary, /Escrowed 4 secrets/);
  assert.doesNotMatch(readFileSync(join(dir, 'plaintext'), 'utf8'), /TOKEN_PEPPER|MEDIA_SIGNING/);
});

test('with the content stack on, its two secrets are required', () => {
  for (const missing of Object.keys(CONTENT) as (keyof typeof CONTENT)[]) {
    const { [missing]: _, ...rest } = CONTENT;
    const run = encrypt({ ESCROW_RECIPIENT: RECIPIENT, ...REQUIRED, ...rest, CONTENT: 'true' });
    assert.equal(run.status, 1);
    assert.match(run.stdout, new RegExp(`${missing} is not set`));
  }
});

test('refuses a value the NAME=value format could not restore', () => {
  const run = encrypt({ ESCROW_RECIPIENT: RECIPIENT, ...REQUIRED, UCP_SIGNING_KEY: 'two\nlines' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /UCP_SIGNING_KEY holds a newline/);
});

test('refuses without a valid recipient', () => {
  for (const ESCROW_RECIPIENT of ['', 'not-a-key', `${RECIPIENT}; id`]) {
    const run = encrypt({ ESCROW_RECIPIENT, ...REQUIRED });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /ESCROW_RECIPIENT in this workflow is not an age public key/);
  }
});

test('refuses when a secret that cannot be replaced is missing', () => {
  const { PASSWORD_PEPPER: _, ...rest } = REQUIRED;
  const run = encrypt({ ESCROW_RECIPIENT: RECIPIENT, ...rest });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /PASSWORD_PEPPER is not set/);
});
