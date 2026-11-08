/**
 * The developer skills in the repo's top-level `skills/` folder are instructions an agent follows
 * literally, so a renamed command, flag or SDK method there is a broken migration somewhere. This
 * checks each skill's frontmatter against the SKILL.md format, and that everything a skill tells
 * an agent to run or call exists: every `commerceworker` command and flag (against the CLI's own
 * registry), every `client.` and `cma.` method (against real SDK clients), every name imported
 * from an SDK, every docs link (against the docs site's pages and headings) and every relative
 * link.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeliveryClient } from '@commerceworker/sdk-core';
import { createManagementClient } from '@commerceworker/sdk-management';
import { describe, expect, it } from 'vitest';
import { COMMANDS, GLOBAL_OPTIONS } from '../src/commands.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const skillsDir = join(root, 'skills');
const skills = readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

/** Every Markdown file of a skill: SKILL.md and its references. */
function files(skill: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md')) out.push({ path, text: readFileSync(path, 'utf8') });
    }
  };
  walk(join(skillsDir, skill));
  return out;
}

function frontmatter(text: string): Record<string, string> | undefined {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return undefined;
  const out: Record<string, string> = {};
  for (const line of (match[1] as string).split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

/**
 * Code an agent would run or type: fenced blocks (with `\` continuations joined) and inline code
 * spans, one string each.
 */
function codeSnippets(text: string): string[] {
  const out: string[] = [];
  const fenced = /```[^\n]*\n([\s\S]*?)```/g;
  for (const m of text.matchAll(fenced)) {
    out.push(...(m[1] as string).replace(/\\\n\s*/g, ' ').split('\n'));
  }
  const prose = text.replace(fenced, '');
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) out.push(m[1] as string);
  return out;
}

const commandNames = new Set(COMMANDS.map((c) => c.name));

/** `commerceworker <command> … --flag …` invocations: [command, flags]. */
function invocations(snippet: string): { command: string; flags: string[]; raw: string }[] {
  const out: { command: string; flags: string[]; raw: string }[] = [];
  // Never `commerceworker-codegen`, `@commerceworker/…` or a hostname.
  for (const m of snippet.matchAll(/(?:^|[\s($])commerceworker(?![-/.\w])((?:\s+[^\s|;&)]+)*)/g)) {
    const words = (m[1] as string).trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const two = `${words[0]} ${words[1]}`;
    const command = commandNames.has(two) ? two : (words[0] as string);
    const flags = words
      .filter((w) => w.startsWith('--'))
      .map((w) => (w.slice(2).split('=')[0] as string).replace(/^no-/, ''));
    out.push({ command, flags, raw: m[0].trim() });
  }
  return out;
}

const delivery = createDeliveryClient({
  baseUrl: 'https://x.test',
  space: 's',
  environment: 'e',
  token: 't',
  fetch: (() => Promise.reject(new Error('no network'))) as typeof fetch,
});
const management = createManagementClient({
  baseUrl: 'https://x.test',
  space: 's',
  environment: 'e',
  token: 't',
  fetch: (() => Promise.reject(new Error('no network'))) as typeof fetch,
});
const CLIENTS: Record<string, object> = { client: delivery, cma: management };

/** Whether `a.b.c` exists on the object (getters included). */
function resolves(target: object, path: readonly string[]): boolean {
  let at: unknown = target;
  for (const key of path) {
    if ((typeof at !== 'object' && typeof at !== 'function') || at === null || !(key in at)) {
      return false;
    }
    at = (at as Record<string, unknown>)[key];
  }
  return true;
}

/** What a package's entry module exports, by name, read from its source. */
function exportsOf(pkg: string): Set<string> {
  const dir = join(root, 'packages/sdk', pkg.replace('@commerceworker/sdk-', ''), 'src');
  const names = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))) {
    const source = readFileSync(join(dir, file), 'utf8');
    for (const m of source.matchAll(
      /export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|class|interface|type|let)\s+(\w+)/g,
    )) {
      names.add(m[1] as string);
    }
    for (const m of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
      for (const part of (m[1] as string).split(',')) {
        const name = part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)
          .pop();
        if (name) names.add(name);
      }
    }
  }
  return names;
}

const SDKS = readdirSync(join(root, 'packages/sdk')).map((d) => `@commerceworker/sdk-${d}`);

/** github-slugger, as Starlight makes heading anchors. */
const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');

function docsPage(path: string): string | undefined {
  for (const ext of ['.mdx', '.md']) {
    const file = join(root, 'apps/docs/src/content', `${path.replace(/\/$/, '')}${ext}`);
    if (existsSync(file)) return readFileSync(file, 'utf8');
  }
  return undefined;
}

describe('developer skills', () => {
  it('ships the three skills', () => {
    expect(skills).toEqual([
      'building-on-commerceworker',
      'migrating-to-commerceworker',
      'modeling-content-with-commerceworker',
    ]);
  });

  describe.each(skills)('%s', (skill) => {
    const main = readFileSync(join(skillsDir, skill, 'SKILL.md'), 'utf8');
    const all = files(skill);

    it('has SKILL.md frontmatter with its own name and a description that says when to use it', () => {
      const meta = frontmatter(main);
      expect(meta, 'frontmatter between --- lines').toBeDefined();
      expect(Object.keys(meta ?? {}).sort()).toEqual(['description', 'name']);
      expect(meta?.name).toBe(skill);
      expect(meta?.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect((meta?.name ?? '').length).toBeLessThanOrEqual(64);
      const description = meta?.description ?? '';
      expect(description.length).toBeGreaterThan(50);
      expect(description.length).toBeLessThanOrEqual(1024);
      expect(description).not.toMatch(/[<>]/);
      expect(description).toMatch(/\bUse when\b/);
      // Concise: the body loads whole into an agent's context.
      expect(main.split('\n').length).toBeLessThan(500);
    });

    it('links only files that exist, and links every reference it ships', () => {
      const linked = new Set<string>();
      for (const { path, text } of all) {
        for (const m of text.matchAll(/\]\(((?!https?:|#)[^)\s]+)\)/g)) {
          const target = join(dirname(path), (m[1] as string).split('#')[0] as string);
          expect(existsSync(target), `${path} links ${m[1]}`).toBe(true);
          linked.add(target);
        }
      }
      for (const { path } of all) {
        if (!path.endsWith('SKILL.md')) expect(linked, `${path} is never linked`).toContain(path);
      }
    });

    it('names only CLI commands and flags that exist', () => {
      const seen: string[] = [];
      for (const { path, text } of all) {
        for (const snippet of codeSnippets(text)) {
          for (const { command, flags, raw } of invocations(snippet)) {
            const spec = COMMANDS.find((c) => c.name === command);
            expect(spec, `${path}: \`${raw}\` is not a commerceworker command`).toBeDefined();
            const known = { ...GLOBAL_OPTIONS, ...spec?.options };
            for (const flag of flags) {
              expect(known, `${path}: \`${raw}\` has no --${flag}`).toHaveProperty(flag);
            }
            seen.push(command);
          }
        }
      }
      if (skill !== 'building-on-commerceworker') expect(seen.length).toBeGreaterThan(0);
    });

    it('calls only SDK methods that exist', () => {
      for (const { path, text } of all) {
        for (const snippet of codeSnippets(text)) {
          for (const m of snippet.matchAll(/(?<![\w.])(client|cma)\.([a-zA-Z][\w.]*)/g)) {
            const segments = (m[2] as string).replace(/\.$/, '').split('.');
            expect(
              resolves(CLIENTS[m[1] as string] as object, segments),
              `${path}: ${m[0]} is not on the ${m[1] === 'cma' ? 'Management' : 'Delivery'} client`,
            ).toBe(true);
          }
        }
      }
    });

    it('imports and names only what the SDKs export', () => {
      for (const { path, text } of all) {
        for (const m of text.matchAll(
          /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'(@commerceworker\/sdk-[\w-]+)'/g,
        )) {
          const exported = exportsOf(m[2] as string);
          for (const name of (m[1] as string)
            .split(',')
            .map((n) => n.trim().replace(/^type\s+/, ''))) {
            if (name) expect(exported, `${path}: ${m[2]} has no ${name}`).toContain(name);
          }
        }
        // Prose: "`useEntry`, `Image` from `@commerceworker/sdk-web`", within one sentence.
        for (const sentence of text.split(/\.\s|\n\n/)) {
          for (const m of sentence.matchAll(
            /((?:`\w+`[,\s(]*(?:and\s+)?)+)from\s+`(@commerceworker\/sdk-[\w-]+)`/g,
          )) {
            const exported = exportsOf(m[2] as string);
            for (const n of (m[1] as string).matchAll(/`(\w+)`/g)) {
              expect(exported, `${path}: ${m[2]} has no ${n[1]}`).toContain(n[1]);
            }
          }
        }
        // Anything shaped like an SDK function (`isConflict`, `createEdgeClient`, `useEntry`).
        const everything = new Set(SDKS.flatMap((p) => [...exportsOf(p)]));
        for (const m of text.matchAll(/`((?:is|create|use)[A-Z]\w*)`/g)) {
          expect(everything, `${path}: no SDK exports ${m[1]}`).toContain(m[1]);
        }
      }
    });

    it('links docs pages and headings that exist', () => {
      for (const { path, text } of all) {
        for (const m of text.matchAll(
          /https:\/\/docs\.commerceworker\.com\/([\w/-]*)(#[\w-]+)?/g,
        )) {
          const page = docsPage(m[1] as string);
          expect(page, `${path}: no docs page for ${m[0]}`).toBeDefined();
          if (m[2]) {
            const anchors = [...(page ?? '').matchAll(/^#{2,4}\s+(.+)$/gm)].map((h) =>
              slug(h[1] as string),
            );
            expect(anchors, `${path}: no heading for ${m[0]}`).toContain((m[2] as string).slice(1));
          }
        }
        for (const m of text.matchAll(/`([a-z]+(?:-[a-z]+)*-commerceworker)`/g)) {
          expect(skills, `${path}: no skill ${m[1]}`).toContain(m[1]);
        }
      }
    });
  });
});
