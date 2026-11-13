import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCart } from '../src/cart/carts';
import { ensureTemplates } from '../src/flows';

const today = new Date().toISOString().slice(0, 10);

async function until<T>(fn: () => Promise<T | false>, what: string, ms = 50_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function run(wf: Workflow<never>, id: string) {
  await wf.create({ id });
  return until(async () => {
    const s = await (await wf.get(id)).status();
    return ['errored', 'complete', 'terminated'].includes(s.status) ? s : false;
  }, `${id} to end`);
}

async function lines(key: string): Promise<Record<string, any>[]> {
  const object = await env.BACKUPS.get(key);
  const body = object!.body.pipeThrough(new DecompressionStream('gzip'));
  return (await new Response(body).text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const introspectors: Awaited<ReturnType<typeof introspectWorkflow>>[] = [];
beforeAll(async () => {
  const i = await introspectWorkflow(env.OBJECTS_BACKUP);
  await i.modifyAll(async (m) => m.disableRetryDelays());
  introspectors.push(i);
  await ensureTemplates(env);
});
afterAll(async () => {
  for (const i of introspectors) await i.dispose();
});

describe('the nightly copy of live order and cart state', () => {
  it('copies active orders and open carts in pages, with the manifest last', async () => {
    // Past one page of 25: three pages of orders, a sixth of them finished and left out. One
    // statement, since D1 binds at most 100 parameters.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 59)
       INSERT INTO orders (id, model, status, flow_id, flow_version, created_at, updated_at)
       SELECT 'objbk_' || printf('%03d', i), 'b2b', CASE WHEN i % 6 = 5 THEN 'completed' ELSE 'running' END,
         'tpl-b2b-order', 1, 1, 1 FROM n`,
    ).run();
    const cart = await createCart(env, {
      title: 'Nightly copy cart',
      flowId: 'tpl-b2b-order',
      customerId: 'cus_northwind',
      createdBy: 'usr_objbk',
    });
    if (!cart.ok) throw new Error(cart.error);

    const active = await env.DB.prepare(
      `SELECT count(*) AS n FROM orders WHERE status NOT IN ('completed','declined','cancelled','failed','rolled_back')`,
    ).first<{ n: number }>();
    const openCarts = await env.DB.prepare(
      `SELECT count(*) AS n FROM carts WHERE status NOT IN ('submitted','returned','canceled') AND purged_at IS NULL`,
    ).first<{ n: number }>();

    const result = await run(env.OBJECTS_BACKUP, 'ob-1');
    expect(result.status, JSON.stringify(result.error)).toBe('complete');
    expect(result.output).toMatchObject({
      date: today,
      orders: active!.n,
      carts: openCarts!.n,
      errors: 0,
    });

    const manifest = (await (await env.BACKUPS.get(
      `objects/${today}/manifest.json`,
    ))!.json()) as any;
    expect(manifest.classes.OrderAgent.objects).toBe(active!.n);
    expect(manifest.classes.OrderAgent.capped).toBe(false);
    // 25 objects a chunk, so a page per step.
    expect(manifest.classes.OrderAgent.chunks).toHaveLength(Math.ceil(active!.n / 25));
    expect(manifest.classes.OrderAgent.chunks[0].key).toBe(
      `objects/${today}/OrderAgent/0.ndjson.gz`,
    );
    expect(manifest.classes.CartAgent.objects).toBe(openCarts!.n);

    // Every chunk is there with the hash and counts the manifest holds; the manifest is the last write.
    const manifestAt = (await env.BACKUPS.head(
      `objects/${today}/manifest.json`,
    ))!.uploaded.getTime();
    const names: string[] = [];
    for (const chunk of manifest.classes.OrderAgent.chunks) {
      const head = (await env.BACKUPS.head(chunk.key))!;
      expect(head.customMetadata?.sha256).toBe(chunk.sha256);
      expect(head.uploaded.getTime()).toBeLessThanOrEqual(manifestAt);
      const got = await lines(chunk.key);
      expect(got).toHaveLength(chunk.objects);
      for (const l of got) names.push(l.name);
    }
    // In name order, none twice, and no finished order.
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('objbk_000');
    expect(names).not.toContain('objbk_005');

    // A cart's copy holds the synced state the Agents SDK keeps, with its title.
    const [chunk] = manifest.classes.CartAgent.chunks;
    const cartLine = (await lines(chunk.key)).find((l) => l.name === cart.id)!;
    expect(cartLine.state.tables.cf_agents_state[0].state).toContain('Nightly copy cart');
  });

  it('does nothing a second time the same day', async () => {
    const again = await run(env.OBJECTS_BACKUP, 'ob-2');
    expect(again.output).toEqual({ date: today, skipped: true });
  });
});
