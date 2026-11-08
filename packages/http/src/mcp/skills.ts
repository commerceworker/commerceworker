import {
  memorySkillFiles,
  type SkillCatalog,
  SkillsExtension,
} from '@modelcontextprotocol/server/ext/skills';
import { SKILL_FILES } from './skills.generated';

let catalog: Promise<SkillCatalog> | undefined;

/**
 * The skills this server publishes over the MCP Skills extension (SEP-2640).
 * Loading digests every file, so it runs once per process (or isolate) and the
 * catalog is shared: attaching it to each per-request server only registers
 * handlers. `strict` makes a malformed SKILL.md fail loudly instead of being
 * skipped with a warning.
 */
export function loadSkillCatalog(): Promise<SkillCatalog> {
  catalog ??= SkillsExtension.load(memorySkillFiles(SKILL_FILES), {
    prefix: 'commerceworker',
    strict: true,
    // Skills change only on deploy; clients may reuse a listing or file for an hour.
    cacheHint: { ttlMs: 60 * 60_000, cacheScope: 'private' },
  }).catch((err: unknown) => {
    catalog = undefined;
    throw err;
  });
  return catalog;
}
