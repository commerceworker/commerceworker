import {
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
  StubAIProvider,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentRunner,
  type AgentRunOutcome,
  type AppContext,
  auditEntry,
  createContentType,
  createEntry,
  createSpace,
  getEntry,
  listAgentRuns,
  listTasks,
  moderateEntry,
  publishEntry,
  runPublishAgents,
  SYSTEM_CALLER,
} from '../src/index';

const scope = { spaceId: 'blog', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  return { ctx };
}

const FINDINGS = {
  findings: [
    {
      field: 'title',
      severity: 'error',
      message: 'Title is empty',
      suggestedAction: 'Add a title',
    },
    { severity: 'warning', message: 'Body is thin', suggestedAction: 'Expand the body' },
    { severity: 'info', message: 'Consider a CTA', suggestedAction: 'Add a call to action' },
  ],
};

describe('auditEntry', () => {
  let ctx: AppContext;
  let entryId: string;
  beforeEach(async () => {
    ({ ctx } = setup());
    await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'post',
      name: 'Post',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
        {
          apiId: 'body',
          name: 'Body',
          type: 'Text',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    });
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Hi' }, body: { 'en-US': 'Short.' } },
    });
    entryId = entry.id;
  });

  it('returns structured findings without creating tasks by default', async () => {
    const ai = new StubAIProvider(() => FINDINGS);
    const result = await auditEntry(ctx, ai, scope, entryId);
    expect(result.findings).toHaveLength(3);
    expect(result.taskIds).toEqual([]);
    expect(await listTasks(ctx, scope, entryId)).toHaveLength(0);
  });

  it('emits a work-package task per finding at/above the severity threshold', async () => {
    const ai = new StubAIProvider(() => FINDINGS);
    const result = await auditEntry(ctx, ai, scope, entryId, {
      createTasks: true,
      taskSeverity: 'warning',
      assignee: 'editor@example.com',
    });
    // error + warning qualify; info does not.
    expect(result.taskIds).toHaveLength(2);
    const tasks = await listTasks(ctx, scope, entryId);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.assignee).toBe('editor@example.com');
    expect(tasks.some((t) => t.body.includes('Add a title'))).toBe(true);
  });

  it('only creates tasks for errors when taskSeverity=error', async () => {
    const ai = new StubAIProvider(() => FINDINGS);
    const result = await auditEntry(ctx, ai, scope, entryId, {
      createTasks: true,
      taskSeverity: 'error',
    });
    expect(result.taskIds).toHaveLength(1);
  });

  it('leaves out findings without the shape asked for, never a TypeError', async () => {
    const ai = new StubAIProvider(() => ({
      findings: [
        null,
        'Add a title',
        { severity: 'critical', message: 'Unknown severity', suggestedAction: 'Ranked as none' },
        { severity: 'warning', message: 'Too short', suggestedAction: 'Expand it', extra: 1 },
      ],
    }));
    const result = await auditEntry(ctx, ai, scope, entryId, { createTasks: true });
    // Only the well-formed warning is a finding, and only it becomes a task.
    expect(result.findings.map((f) => f.message)).toEqual(['Too short']);
    expect(result.taskIds).toHaveLength(1);
  });
});

/** AgentRunner double: canned outcome per workflow, records every invocation. */
function fakeRunner(outcomes: Partial<Record<string, AgentRunOutcome>> = {}) {
  const calls: { workflow: string; entryId: string; autoApply?: boolean }[] = [];
  const clean: AgentRunOutcome = {
    status: 'completed',
    decisions: ['clean'],
    usage: { inputTokens: 10, outputTokens: 5 },
  };
  const runner: AgentRunner = {
    run: async (workflow, input) => {
      calls.push({ workflow, entryId: input.entryId, autoApply: input.autoApply });
      return outcomes[workflow] ?? clean;
    },
  };
  return { runner, calls };
}

describe('moderateEntry', () => {
  let ctx: AppContext;
  let entryId: string;
  beforeEach(async () => {
    ({ ctx } = setup());
    await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'post',
      name: 'Post',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
      ],
    });
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Hello' } },
    });
    entryId = entry.id;
  });

  it('reports a clean entry and records the run in the ledger', async () => {
    const { runner, calls } = fakeRunner();
    const result = await moderateEntry(ctx, runner, scope, entryId);
    expect(result).toMatchObject({ entryId, status: 'completed', flagged: false });
    expect(calls).toEqual([{ workflow: 'moderate', entryId, autoApply: undefined }]);
    const runs = await listAgentRuns(ctx, scope);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ workflow: 'moderate', entryId, status: 'completed' });
  });

  it('surfaces a held run as flagged', async () => {
    const { runner } = fakeRunner({
      moderate: {
        status: 'held',
        decisions: ['flagged: violence'],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    });
    const result = await moderateEntry(ctx, runner, scope, entryId);
    expect(result.flagged).toBe(true);
    expect(result.decisions).toEqual(['flagged: violence']);
  });

  it('rejects an unknown entry without invoking the runner', async () => {
    const { runner, calls } = fakeRunner();
    await expect(moderateEntry(ctx, runner, scope, 'missing')).rejects.toThrow(/not found/i);
    expect(calls).toEqual([]);
  });
});

describe('runPublishAgents', () => {
  let ctx: AppContext;
  let entryId: string;
  beforeEach(async () => {
    ({ ctx } = setup());
    await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'post',
      name: 'Post',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
      ],
    });
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Hello' } },
    });
    entryId = entry.id;
  });

  it('runs enrich before moderate and records both in the ledger', async () => {
    const { runner, calls } = fakeRunner();
    const runs = await runPublishAgents(ctx, runner, scope, entryId, {
      enrich: true,
      moderate: true,
      autoApply: true,
    });
    expect(calls.map((c) => c.workflow)).toEqual(['enrich', 'moderate']);
    expect(calls.every((c) => c.autoApply)).toBe(true);
    expect(runs.map((r) => r.workflow)).toEqual(['enrich', 'moderate']);
    const recorded = await listAgentRuns(ctx, scope);
    expect(recorded.map((r) => r.workflow).sort()).toEqual(['enrich', 'moderate']);
  });

  it('runs only the enabled workflows', async () => {
    const { runner, calls } = fakeRunner();
    const runs = await runPublishAgents(ctx, runner, scope, entryId, {
      enrich: false,
      moderate: true,
      autoApply: false,
    });
    expect(calls.map((c) => c.workflow)).toEqual(['moderate']);
    expect(runs).toHaveLength(1);
  });

  it('retracts a published entry that moderation flags (held)', async () => {
    await publishEntry(ctx, scope, entryId);
    expect((await getEntry(ctx, scope, entryId)).entry.publishedVersion).not.toBeNull();

    const { runner } = fakeRunner({
      moderate: {
        status: 'held',
        decisions: ['flagged'],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    });
    await runPublishAgents(ctx, runner, scope, entryId, { moderate: true });

    // Flagged content is pulled from the delivery read model.
    expect((await getEntry(ctx, scope, entryId)).entry.publishedVersion).toBeNull();
    const recorded = await listAgentRuns(ctx, scope);
    expect(recorded.some((r) => r.decisions.some((d) => /retracted/.test(d)))).toBe(true);
  });
});
