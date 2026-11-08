import type { DecisionRequest } from '@commerceworker/ports';
import { describe, expect, it } from 'vitest';
import { createWorkersAIDecisionModel, WorkersAIError } from '../../src/ai-workers/index';

type Call = { model: string; input: Record<string, unknown>; opts?: unknown };

function fakeRun(answer: unknown) {
  const calls: Call[] = [];
  const run = async (model: string, input: Record<string, unknown>, opts?: unknown) => {
    calls.push({ model, input, opts });
    return answer;
  };
  return { run, calls };
}

const request: DecisionRequest = {
  state: 'Checkout has been failing for every customer for the last hour.',
  questions: {
    urgent: { type: 'noul', instructions: 'Is this urgent?' },
    team: {
      type: 'choice',
      instructions: 'Which team?',
      options: { billing: 'Payments', technical: 'Outages' },
    },
    severity: { type: 'score', instructions: 'How severe?', levels: ['None', 'Minor', 'Major'] },
  },
};

describe('the Workers AI decision model', () => {
  it('asks Clef in the System One shape, through the gateway, without logging payloads', async () => {
    const { run, calls } = fakeRun({
      answers: {
        urgent: { type: 'noul', noul: 0.97 },
        team: {
          type: 'choice',
          choice: 'technical',
          confidence: 0.9,
          probabilities: { billing: 0.1, technical: 0.9 },
        },
        severity: { type: 'score', score: 1.8, probabilities: [0.05, 0.1, 0.85] },
      },
      usage: { input_tokens: 120 },
    });
    const model = createWorkersAIDecisionModel({ run, gatewayId: 'gw' });
    const result = await model.decide({ ...request, tier: 'flagship' });

    expect(calls[0]?.model).toBe('@cf/cloudflare/clef');
    expect(calls[0]?.input).toEqual({
      model: 'clef',
      state: request.state,
      questions: {
        urgent: { type: 'noul', instructions: 'Is this urgent?' },
        team: {
          type: 'choice',
          instructions: 'Which team?',
          criteria: { billing: 'Payments', technical: 'Outages' },
        },
        severity: {
          type: 'score',
          instructions: 'How severe?',
          criteria: ['None', 'Minor', 'Major'],
        },
      },
    });
    expect(calls[0]?.opts).toMatchObject({
      gateway: { id: 'gw' },
      extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
    });
    expect(result).toEqual({
      model: '@cf/cloudflare/clef',
      usage: { inputTokens: 120 },
      answers: {
        urgent: { type: 'noul', probability: 0.97 },
        team: {
          type: 'choice',
          choice: 'technical',
          confidence: 0.9,
          probabilities: { billing: 0.1, technical: 0.9 },
        },
        severity: { type: 'score', score: 1.8, probabilities: [0.05, 0.1, 0.85] },
      },
    });
  });

  it('uses Clef-flash for the fast tier, and reads level probabilities keyed by label', async () => {
    const { run, calls } = fakeRun({
      answers: {
        urgent: { noul: 0.2 },
        team: { choice: 'billing', probabilities: { billing: 0.7, technical: 0.3 } },
        severity: { score: 0, probabilities: { None: 0.9, Minor: 0.1 } },
      },
    });
    const result = await createWorkersAIDecisionModel({ run }).decide(request);
    expect(calls[0]?.model).toBe('@cf/cloudflare/clef-flash');
    expect(calls[0]?.input.model).toBe('clef-flash');
    expect(calls[0]?.opts).toBeUndefined();
    // A missing confidence falls back to the chosen option's probability.
    expect(result.answers.team).toMatchObject({ choice: 'billing', confidence: 0.7 });
    expect(result.answers.severity).toEqual({
      type: 'score',
      score: 0,
      probabilities: [0.9, 0.1, 0],
    });
    expect(result.usage.inputTokens).toBe(0);
  });

  it('refuses an answer that is not one of the options, or is missing', async () => {
    const offMenu = fakeRun({
      answers: { urgent: { noul: 0.5 }, team: { choice: 'sales' }, severity: { score: 1 } },
    });
    await expect(
      createWorkersAIDecisionModel({ run: offMenu.run }).decide(request),
    ).rejects.toMatchObject({ name: 'WorkersAIError', reason: 'bad_response' });
    const missing = fakeRun({ answers: {} });
    await expect(
      createWorkersAIDecisionModel({ run: missing.run }).decide(request),
    ).rejects.toBeInstanceOf(WorkersAIError);
  });

  it('takes 1 to 64 questions', async () => {
    const { run, calls } = fakeRun({});
    const model = createWorkersAIDecisionModel({ run });
    await expect(model.decide({ state: 'x', questions: {} })).rejects.toMatchObject({
      reason: 'config',
    });
    const many = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`q${i}`, { type: 'noul' as const, instructions: 'x' }]),
    );
    await expect(model.decide({ state: 'x', questions: many })).rejects.toMatchObject({
      reason: 'config',
    });
    expect(calls).toEqual([]);
  });

  it('turns a transport failure into an upstream error', async () => {
    const run = async () => {
      throw new Error('boom');
    };
    await expect(createWorkersAIDecisionModel({ run }).decide(request)).rejects.toMatchObject({
      reason: 'upstream',
    });
  });

  it('keeps the model’s choice when its probabilities are missing, and refuses a contradiction', async () => {
    const sparse = fakeRun({
      answers: {
        urgent: { noul: 0.5 },
        team: { choice: 'technical', confidence: 0.95 },
        severity: { score: 2 },
      },
      usage: { prompt_tokens: 42 },
    });
    const r = await createWorkersAIDecisionModel({ run: sparse.run }).decide(request);
    expect(r.answers.team).toEqual({
      type: 'choice',
      choice: 'technical',
      confidence: 0.95,
      probabilities: { billing: 0, technical: 0.95 },
    });
    expect(r.answers.severity).toEqual({ type: 'score', score: 2, probabilities: [0, 0, 1] });
    // Usage reported the Workers AI way still meters.
    expect(r.usage.inputTokens).toBe(42);

    const contradiction = fakeRun({
      answers: {
        urgent: { noul: 0.5 },
        team: { choice: 'billing', probabilities: { billing: 0.2, technical: 0.8 } },
        severity: { score: 1 },
      },
    });
    await expect(
      createWorkersAIDecisionModel({ run: contradiction.run }).decide(request),
    ).rejects.toMatchObject({ reason: 'bad_response' });
  });

  it('refuses an inherited property name as a choice', async () => {
    const { run } = fakeRun({
      answers: { urgent: { noul: 0.5 }, team: { choice: 'toString' }, severity: { score: 1 } },
    });
    await expect(createWorkersAIDecisionModel({ run }).decide(request)).rejects.toMatchObject({
      reason: 'bad_response',
    });
  });
});
