import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { test } from 'node:test';

// The words people read must keep docs/brand/messaging.md's voice. This holds the part a machine
// can check: the product's name, the names we never use, the words the guide says to avoid, and
// the capability's name. Tone is a reviewer's job; a reviewer shouldn't spend time on these.
//
// What is scanned: the admin's routes, components and lib, the assistant's cards, the strings of
// core, the marketing copy, and the published docs. In source files comment lines are skipped
// (a comment may say where a port came from); in docs, code spans and fences are, since an API
// path or an identifier (`workflows/copilot`) is not prose.
//
// To allow a hit, reword it. This file has no allowlist on purpose.

const root = join(import.meta.dirname, '..');

const SOURCES = [
  'apps/web/app',
  'apps/engine/src/assistant',
  'apps/marketing/src/i18n',
  'packages/core/src',
];
const DOCS = ['apps/docs/src/content'];

/** Never in public copy: the product written two words, and names we have retired or don't use. */
const NAMES: [RegExp, string][] = [
  [/Commerce Worker/, '“Commerce Worker” (the product is one word: CommerceWorker)'],
  [/\bCommerceworker\b/, '“Commerceworker” (CommerceWorker, or `commerceworker` in code)'],
  [/\border ?loop\b/i, 'the retired order engine’s name (an Order Flow, the OrderWorkflow class)'],
  [/\bcontent ?worker\b/i, 'the retired content product’s name'],
  // Platforms we compete with. Shopify is not here: it is a channel the product connects to.
  [
    /\b(magento|bigcommerce|woocommerce|commercetools|saleor|medusa(js)?|vtex|prestashop|spree commerce|salesforce commerce|sap commerce|shopware)\b/i,
    'a competing platform’s name (say “the surveyed platform”)',
  ],
];

/** Words the guide says to avoid, and the tones it rules out. Whole words, any case. */
const VOICE: [RegExp, string][] = [
  [/\bAI-powered\b/i, '“AI-powered”'],
  [/\b(seamless|seamlessly|revolutionary|supercharge|unleash|magical)\b/i, 'hype'],
  [/\b(oops|whoops|uh-oh)\b/i, 'a cutesy error'],
];

/** The capability is Order Flows; a bare “Flows” heading, label or title isn’t a name we use. */
const BARE_FLOWS = /(['"`>])Flows(?: ·[^'"`<]*)?(['"`<])/;

/** Docs prose only: marketing words that are fine in an identifier but not in a sentence. */
const PROSE: [RegExp, string][] = [
  [/\bcopilot\b/i, '“copilot” (say what it does: the assistant, or drafting a flow)'],
  [/\w!(\s|$)/, 'an exclamation mark'],
  [/\bheadless\b/i, '“headless” as a descriptor'],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'generated') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const isTest = (p: string) => /(\.|\/)(test|spec)\.|\/tests?\//.test(p);

/** A source file's lines of code and strings: no comments, no imports. */
function sourceLines(text: string): [number, string][] {
  const lines: [number, string][] = [];
  text.split('\n').forEach((raw, i) => {
    const t = raw.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*'))
      return;
    if (/^import\b/.test(t) || /^\} from /.test(t)) return;
    lines.push([i + 1, raw.replace(/\s\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')]);
  });
  return lines;
}

/** A docs page's prose lines: no front-matter keys that hold paths, no fences, no code spans. */
function proseLines(text: string): [number, string][] {
  const lines: [number, string][] = [];
  let fenced = false;
  text.split('\n').forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced || /^\s*import\b/.test(raw)) return;
    lines.push([i + 1, raw.replace(/`[^`]*`/g, '``').replace(/\]\([^)]*\)/g, '](…)')]);
  });
  return lines;
}

function scan(): string[] {
  const hits: string[] = [];
  const check = (file: string, lines: [number, string][], rules: [RegExp, string][]) => {
    for (const [n, line] of lines)
      for (const [re, why] of rules)
        if (re.test(line)) hits.push(`${relative(root, file)}:${n}  ${why}\n    ${line.trim()}`);
  };
  for (const dir of SOURCES) {
    for (const file of walk(join(root, dir))) {
      if (!['.ts', '.tsx'].includes(extname(file)) || isTest(file)) continue;
      const lines = sourceLines(readFileSync(file, 'utf8'));
      check(file, lines, [...NAMES, ...VOICE, [BARE_FLOWS, 'a bare “Flows” (say Order Flows)']]);
    }
  }
  for (const dir of DOCS) {
    for (const file of walk(join(root, dir))) {
      if (!['.md', '.mdx'].includes(extname(file))) continue;
      const lines = proseLines(readFileSync(file, 'utf8'));
      check(file, lines, [...NAMES, ...VOICE, ...PROSE]);
    }
  }
  return hits;
}

test('user-facing copy keeps the brand names and the voice', () => {
  const hits = scan();
  assert.deepEqual(hits, [], `\n${hits.join('\n')}\n`);
});

test('the scan reads the surfaces it claims to', () => {
  for (const dir of [...SOURCES, ...DOCS]) assert.ok(walk(join(root, dir)).length > 0, dir);
});

test('each rule catches what it is for', () => {
  const catches = (rules: [RegExp, string][], s: string) => rules.some(([re]) => re.test(s));
  assert.ok(catches(NAMES, 'Welcome to Commerce Worker'));
  assert.ok(catches(NAMES, 'Import from Magento'));
  assert.ok(catches(VOICE, 'A seamless checkout'));
  assert.ok(BARE_FLOWS.test("title: 'Flows · CommerceWorker'"));
  assert.ok(BARE_FLOWS.test('<h1>Flows</h1>'));
  assert.ok(!BARE_FLOWS.test("'Order Flows'"));
  assert.ok(catches(PROSE, 'It is done!'));
  assert.ok(!catches(PROSE, 'a != b'));
  assert.ok(!catches([...NAMES, ...VOICE], 'Shopify order webhooks'));
});
