import { env } from 'cloudflare:workers';
import type { FlowNode, Order, RunContext } from '@commerceworker/core';
import { generateText } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assistantModelId, runJson, textModel } from '../src/ai';
import { assistantModel, type ModelSource, type Turn } from '../src/assistant/model';
import { EXECUTORS, type ExecInput } from '../src/nodes';
import { finishTurn } from '../src/usage';

/**
 * Model calls through the deployment's AI Gateway routes (`AI_ROUTE`, `ASSISTANT_ROUTE`, set with
 * the registry's `redundancy`). The stand-in gateway does what a route does: it tries the first
 * model, and when that fails answers with the second, naming the model that served in
 * `cf-aig-model`. Both models down, or a limit with nothing to fall back to, is a status, as the
 * gateway answers it. Counting is read from the engine's `METRICS` writes.
 */

const FIRST = String(env.AI_MODEL);
const SECOND = '@cf/meta/llama-3.1-8b-instruct';
const ASSISTANT_FIRST = String(env.ASSISTANT_MODEL);
const ASSISTANT_SECOND = '@cf/zai-org/glm-4.7-flash';

type Call = {
  model: string;
  input: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
};

/**
 * `down` lists the models that fail; `status` makes the route itself answer that status (the
 * gateway refusing); `text` makes it the assistant's route, answering in prose.
 */
function gateway(opts: { down?: string[]; status?: number; text?: string } = {}) {
  const calls: Call[] = [];
  const [first, second] =
    opts.text === undefined ? [FIRST, SECOND] : [ASSISTANT_FIRST, ASSISTANT_SECOND];
  const AI = {
    aiGatewayLogId: null,
    async run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>) {
      calls.push({ model, input, options });
      // A fixed model, called directly (no route): the answer as Workers AI gives it.
      if (!model.startsWith('dynamic/')) {
        if (opts.down?.includes(model)) throw new Error('3040: Capacity temporarily exceeded');
        return { response: { ok: true }, usage: { total_tokens: 30 } };
      }
      if (opts.status)
        return Response.json({ errors: [{ message: 'refused' }] }, { status: opts.status });
      const served = opts.down?.includes(first) ? second : first;
      if (opts.down?.includes(served))
        return Response.json({ errors: [{ message: 'Model execution failed' }] }, { status: 500 });
      return Response.json(
        {
          choices: [
            {
              message: { role: 'assistant', content: opts.text ?? '{"ok":true}' },
              finish_reason: 'stop',
            },
          ],
          usage: { total_tokens: 30, prompt_tokens: 25, completion_tokens: 5 },
        },
        { headers: { 'cf-aig-model': served, 'cf-aig-provider': 'workers-ai' } },
      );
    },
    fetch: () => Promise.reject(new Error('not used')),
  };
  return { AI, calls };
}

/** The deployment's env with routes on (the base config's `AI_ROUTE`s), over the fake gateway. */
const routed = (g: { AI: unknown }, over: Record<string, unknown> = {}) =>
  ({
    ...env,
    AI_MODE: 'live',
    AI_GATEWAY_ID: 'commerceworker',
    AI_ROUTE: 'cw-text',
    ASSISTANT_ROUTE: 'cw-assistant',
    ...over,
    AI: g.AI,
  }) as unknown as Env;

/** Failovers the engine counts, by kind. */
function counted() {
  const writes = vi.spyOn(env.METRICS, 'writeDataPoint');
  return (kind: string) =>
    writes.mock.calls.filter(([p]) => p?.blobs?.[0] === 'failover' && p.blobs[2] === kind).length;
}

afterEach(() => vi.restoreAllMocks());

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
const ask = (e: Env, call: { retry?: boolean; orderId?: string } = {}) =>
  runJson(e, 'risk', [], schema, () => ({ ok: false }), call);

describe('structured calls through the text route', () => {
  it('call the route, not the fixed model, and name the model that served', async () => {
    const g = gateway();
    const failovers = counted();
    const r = await ask(routed(g), { orderId: 'ord_1' });
    expect(r).toMatchObject({ source: 'model', model: FIRST, value: { ok: true }, tokens: 30 });
    expect(g.calls.map((c) => c.model)).toEqual(['dynamic/cw-text']);
    // The route belongs to the gateway: it's named, tagged and kept payload-free like any call.
    expect(g.calls[0]!.options).toMatchObject({
      gateway: { id: 'commerceworker', metadata: { prompt: 'risk@1', orderId: 'ord_1' } },
      extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
      returnRawResponse: true,
    });
    expect(failovers('ai_fallback')).toBe(0);
  });

  it('count the fallback when the first model is down (or its budget spent) and the second serves', async () => {
    const g = gateway({ down: [FIRST] });
    const failovers = counted();
    const r = await ask(routed(g));
    // The answer is a model's, labelled with the one that gave it: not a heuristic.
    expect(r).toMatchObject({ source: 'model', model: SECOND, value: { ok: true } });
    expect(failovers('ai_fallback')).toBe(1);
    expect(failovers('ai_heuristic')).toBe(0);
    // One call: the gateway holds the second model, so the engine doesn't retry or list one.
    expect(g.calls).toHaveLength(1);
  });

  it('answer from the heuristic when both models fail, and report it as the model failing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failovers = counted();
    const g = gateway({ down: [FIRST, SECOND] });
    expect(await ask(routed(g))).toMatchObject({
      source: 'heuristic',
      fallback: 'the gateway route answered 500',
      value: { ok: false },
    });
    expect(failovers('ai_heuristic')).toBe(1);
    expect(failovers('ai_fallback')).toBe(0);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('retry in an order step while it has attempts left, then fall back on the last', async () => {
    const g = gateway({ down: [FIRST, SECOND] });
    await expect(ask(routed(g), { retry: true })).rejects.toThrow(
      /model call failed \(the gateway route answered 500\); trying again/,
    );
    expect(await ask(routed(g), { retry: false })).toMatchObject({ source: 'heuristic' });
  });

  it('treat a limit with nothing to fall back to as the model being down', async () => {
    const failovers = counted();
    const g = gateway({ status: 429 });
    expect(await ask(routed(g))).toMatchObject({
      source: 'heuristic',
      fallback: 'the gateway route answered 429',
    });
    expect(failovers('ai_heuristic')).toBe(1);
  });

  it('keep the risk and router nodes failing closed when both models are down', async () => {
    const order: Order = {
      id: 'ord_routes',
      createdAt: 0,
      model: 'b2b',
      channel: 'manual',
      customerId: 'cus_northwind',
      currency: 'USD',
      lines: [{ sku: 'WID-100', name: 'Widget', qty: 2, unitPrice: 50 }],
      subtotal: 100,
      shipping: 0,
      tax: 0,
      total: 100,
      meta: {},
    };
    const run = (type: string, e: Env, config: Record<string, unknown>) => {
      const node = { id: 'n', type, label: type, config, position: { x: 0, y: 0 } } as FlowNode;
      const ctx: RunContext = { order, nodes: {}, vars: {}, input: {}, now: 0, ref: 'R-1' };
      const i: ExecInput = { env: e, node, config, ctx, stepKey: 'n#1', retriesLeft: false };
      return EXECUTORS[type]!(i);
    };
    const down = () => routed(gateway({ down: [FIRST, SECOND] }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const risk = await run('ai.risk_score', down(), { threshold: 70 });
    expect(risk.branches).toEqual(['high']);
    expect(risk.output).toMatchObject({ unchecked: true, source: 'heuristic' });
    const router = await run('ai.router', down(), { routes: ['auto_approve', 'needs_approval'] });
    expect(router.branches).toEqual(['needs_approval']);
  });
});

describe('with the flag off', () => {
  it('call the fixed model, as before, whatever else is set', async () => {
    const g = gateway();
    const failovers = counted();
    const e = routed(g, { AI_ROUTE: '', ASSISTANT_ROUTE: '' });
    expect(textModel(e)).toBe(FIRST);
    expect(assistantModelId(e)).toBe(ASSISTANT_FIRST);
    expect(await ask(e)).toMatchObject({ source: 'model', model: FIRST });
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]!.model).toBe(FIRST);
    expect(g.calls[0]!.options).not.toHaveProperty('returnRawResponse');
    expect(failovers('ai_fallback')).toBe(0);
  });

  it('call the fixed model when there is no gateway to own a route', () => {
    const e = routed(gateway(), { AI_GATEWAY_ID: '' });
    expect(textModel(e)).toBe(FIRST);
    expect(assistantModelId(e)).toBe(ASSISTANT_FIRST);
  });

  it('fail as today: the heuristic, with no second model tried', async () => {
    const g = gateway({ down: [FIRST] });
    const e = routed(g, { AI_ROUTE: '' });
    expect(await ask(e)).toMatchObject({ source: 'heuristic' });
    expect(g.calls.map((c) => c.model)).toEqual([FIRST]);
  });
});

describe('the assistant through its route', () => {
  const turn: Turn = { surface: 'panel', principalId: 'usr_alice', conversation: 'usr_alice' };
  const prompt = 'What needs me?';
  const say = async (g: { AI: unknown }, used: ModelSource, text = prompt) =>
    (
      await generateText({
        model: await assistantModel(routed(g), { kind: 'workspace' }, used, turn),
        prompt: text,
      })
    ).text;

  it('calls the route with no fallback list of its own, and names the model that served', async () => {
    const g = gateway({ text: 'All clear.' });
    const failovers = counted();
    const used: ModelSource = { source: 'model' };
    expect(await say(g, used)).toBe('All clear.');
    expect(g.calls.map((c) => c.model)).toEqual(['dynamic/cw-assistant']);
    expect(used).toEqual({ source: 'model', model: ASSISTANT_FIRST });
    expect(failovers('ai_fallback')).toBe(0);
  });

  it('counts the fallback when the gateway reports its second model served', async () => {
    const g = gateway({ text: 'From GLM.', down: [ASSISTANT_FIRST] });
    const failovers = counted();
    const used: ModelSource = { source: 'model' };
    expect(await say(g, used)).toBe('From GLM.');
    expect(g.calls).toHaveLength(1);
    expect(used).toEqual({ source: 'model', model: ASSISTANT_SECOND });
    expect(failovers('ai_fallback')).toBe(1);
  });

  it('logs the turn with the model that served, and counts its tokens against the day', async () => {
    const g = gateway({ text: 'From GLM.', down: [ASSISTANT_FIRST] });
    const used: ModelSource = { source: 'model' };
    await say(g, used);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await finishTurn(routed(g), { id: 'usr_routes' } as never, used, 30, Date.now());
    const line = JSON.parse(
      String(log.mock.calls.find(([l]) => String(l).includes('ai_call'))?.[0]),
    );
    expect(line).toMatchObject({ source: 'model', model: ASSISTANT_SECOND, tokens: 30 });
  });

  it('lets the heuristic answer when the route fails entirely', async () => {
    const used: ModelSource = { source: 'model' };
    const g = gateway({ text: 'never', down: [ASSISTANT_FIRST, ASSISTANT_SECOND] });
    expect(await say(g, used, 'hello')).toContain('without the language model');
    expect(used.source).toBe('heuristic');
  });

  it('lets the heuristic answer when a limit leaves nothing to try', async () => {
    const used: ModelSource = { source: 'model' };
    const g = gateway({ text: 'never', status: 429 });
    expect(await say(g, used, 'hello')).toContain('without the language model');
    expect(used.source).toBe('heuristic');
  });
});
