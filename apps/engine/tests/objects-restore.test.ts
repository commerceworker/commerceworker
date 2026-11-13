import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Point-in-time recovery doesn't run in workerd, so what a restore does to an object is tested
// against a fake port (packages/application/test/objects-restore.test.ts). What runs here is the
// Workflow's own refusals: a restore that asks for what it may not changes nothing and says why.

async function run(params: unknown, id: string) {
  await env.OBJECTS_RESTORE.create({ id, params: params as never });
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const s = await (await env.OBJECTS_RESTORE.get(id)).status();
    if (['errored', 'complete', 'terminated'].includes(s.status)) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${id} did not end`);
}

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;
beforeAll(async () => {
  introspector = await introspectWorkflow(env.OBJECTS_RESTORE);
  await introspector.modifyAll(async (m) => m.disableRetryDelays());
});
afterAll(async () => introspector.dispose());

describe('the objects restore Workflow refuses', () => {
  const at = new Date(Date.now() - 3_600_000).toISOString();

  it.each([
    ['an unknown class', { class: 'AssistantAgent', names: ['a'], at }, /"class" is one of/],
    [
      'too many names',
      { class: 'OrderAgent', names: Array.from({ length: 51 }, (_, i) => `o${i}`), at },
      /too many/,
    ],
    [
      'a time older than 30 days',
      {
        class: 'OrderAgent',
        names: ['a'],
        at: new Date(Date.now() - 31 * 86_400_000).toISOString(),
      },
      /30 days/,
    ],
    ['no time and no bookmarks', { class: 'CartAgent', names: ['a'] }, /exactly one/],
  ])('%s', async (_why, params, message) => {
    const result = await run(params, `or-${Math.random().toString(36).slice(2)}`);
    expect(result.status).toBe('errored');
    expect((result.error as { message: string }).message).toMatch(message);
    // Nothing was written: no report.
    const reports = await env.BACKUPS.list({ prefix: 'objects/restores/' });
    expect(reports.objects).toEqual([]);
  });
});
