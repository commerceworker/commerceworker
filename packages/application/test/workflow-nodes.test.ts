import {
  NODE_SPECS,
  nodeSpec,
  type Principal,
  type RunContext,
  SCOPES,
  withDefaults,
} from '@commerceworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  RecordingEmailSender,
  RecordingWebhookSender,
  SequenceIdGenerator,
  StubDecisionModel,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  addEntryToRelease,
  createContentType,
  createEntry,
  createRelease,
  createSpace,
  createTag,
  executeWorkflowNode,
  INTERPRETED_NODE_TYPES,
  loadRunEntry,
  type NodeResult,
  resumeWorkflowNode,
  SYSTEM_CALLER,
  setEntryMetadata,
  WORKFLOW_COMPENSATIONS,
  WORKFLOW_EXECUTORS,
  type WorkflowNodeDeps,
} from '../src/index';

const scope = { spaceId: 'blog', environmentId: 'main' };
const editor: Principal = {
  spaceId: 'blog',
  kind: 'user',
  subject: 'editor@example.com',
  scopes: [SCOPES.contentWrite, SCOPES.contentPublish, SCOPES.previewRead],
};
const reader: Principal = { ...editor, subject: 'r@example.com', scopes: [SCOPES.previewRead] };
const noSummary: Principal = {
  ...editor,
  subject: 'ro@example.com',
  contentGrants: [
    {
      contentTypeApiId: 'post',
      actions: ['read', 'write', 'publish'],
      readOnlyFields: ['summary'],
    },
  ],
};

describe('workflow node executors', () => {
  let ctx: AppContext;
  let entryId: string;
  let email: RecordingEmailSender;
  let webhooks: RecordingWebhookSender;
  let deps: WorkflowNodeDeps;

  beforeEach(async () => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(new Date('2026-03-04T10:00:00.000Z')),
      ids: new SequenceIdGenerator('id'),
      ai: { mode: 'mock', timeoutMs: 1000 },
    };
    email = new RecordingEmailSender();
    webhooks = new RecordingWebhookSender();
    deps = { email, webhooks };
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
          apiId: 'summary',
          name: 'Summary',
          type: 'Text',
          localized: false,
          required: false,
          position: 1,
        },
        {
          apiId: 'body',
          name: 'Body',
          type: 'Text',
          localized: false,
          required: false,
          position: 2,
        },
      ],
    });
    entryId = (
      await createEntry(ctx, scope, {
        contentTypeApiId: 'post',
        fields: { title: { 'en-US': 'Spring news' }, body: { 'en-US': 'A short news story.' } },
      })
    ).entry.id;
  });

  const exec = async (
    type: string,
    config: Record<string, unknown> = {},
    principal: Principal = editor,
    vars: Record<string, unknown> = {},
  ): Promise<NodeResult> => {
    const entry = await loadRunEntry(ctx, scope, entryId);
    const run: RunContext = { entry, nodes: {}, vars, input: {}, now: 0, ref: entry.title ?? '' };
    return executeWorkflowNode(ctx, deps, {
      scope,
      runId: 'run-1',
      workflowId: 'wf-1',
      entryId,
      actor: { id: principal.subject ?? principal.kind, principal },
      node: { id: 'n', type, label: 'Node', config, position: { x: 0, y: 0 } },
      run,
      effectKey: 'n#1',
      retriesLeft: false,
    });
  };

  it('covers the catalog: every node has an executor or runs in the interpreter', () => {
    for (const spec of NODE_SPECS) {
      const handled = spec.type in WORKFLOW_EXECUTORS || INTERPRETED_NODE_TYPES.includes(spec.type);
      expect(handled, spec.type).toBe(true);
      if ('rollback' in spec && spec.rollback) {
        expect(spec.type in WORKFLOW_COMPENSATIONS, spec.type).toBe(true);
      }
    }
  });

  it('triggers pass through', async () => {
    expect(await exec('trigger.manual')).toEqual({ summary: 'Started' });
  });

  it('content.validate and content.policy branch on the entry', async () => {
    expect((await exec('content.validate')).branches).toEqual(['valid']);
    const policy = await exec('content.policy', {
      rules: [
        { rule: 'required_fields', fields: ['title', 'summary'] },
        { rule: 'forbidden_terms', terms: ['news'] },
      ],
    });
    expect(policy.branches).toEqual(['fail']);
    expect(policy.summary).toMatch(/Missing required fields: summary.*forbidden terms: news/);
    expect((await exec('content.policy', { rules: 'nope' })).failed).toMatch(/not valid/);
  });

  it('content.publish / unpublish call the publish use-cases and are idempotent', async () => {
    const r = await exec('content.publish');
    expect(r.output).toEqual({ version: 1, previousVersion: null, publishedByRun: true });
    expect(r.entry?.publishedVersion).toBe(1);
    // Retried after its publish committed: no second publish.
    expect((await exec('content.publish')).output).toMatchObject({ publishedByRun: false });
    expect(
      (await ctx.store.outbox.readPending(50)).filter((e) => e.type === 'entry.published'),
    ).toHaveLength(1);
    expect((await exec('content.unpublish')).output).toEqual({ unpublished: true, version: 1 });
    expect((await exec('content.unpublish')).summary).toBe('Not published');
  });

  it('writes as the workflow, not as the person whose grants it acts with', async () => {
    await exec('content.set_fields', { values: { summary: 'From the run' } });
    await exec('content.publish');
    const entry = (await ctx.store.entries.get(scope, entryId))?.entry;
    expect(entry?.updatedBy).toBe('workflow:wf-1');
    expect(entry?.firstPublishedAt).toBe('2026-03-04T10:00:00.000Z');
    const [latest] = await ctx.store.entries.listVersions(scope, entryId);
    expect(latest?.createdBy).toBe('workflow:wf-1');
  });

  it('refuses effects the run’s principal lacks, as the API would', async () => {
    expect((await exec('content.publish', {}, reader)).failed).toMatch(/content:publish/);
    expect(
      (await exec('content.set_fields', { values: { summary: 'x' } }, noSummary)).failed,
    ).toMatch(/content:write:post.summary/);
    expect((await ctx.store.entries.get(scope, entryId))?.entry.publishedVersion).toBeNull();
  });

  it('refuses unpublishing to a role that publishes but withholds unpublish', async () => {
    const keepsLive: Principal = {
      ...editor,
      subject: 'pub@example.com',
      contentGrants: [
        {
          contentTypeApiId: 'post',
          actions: ['read', 'write', 'publish'],
          deniedActions: ['unpublish'],
        },
      ],
    };
    expect((await exec('content.publish', {}, keepsLive)).output).toMatchObject({ version: 1 });
    expect((await exec('content.unpublish', {}, keepsLive)).failed).toMatch(
      /content:unpublish:post/,
    );
    expect(
      (await exec('content.schedule', { action: 'unpublish', after: '1 day' }, keepsLive)).failed,
    ).toMatch(/content:unpublish:post/);
    expect(
      (await exec('content.schedule', { action: 'publish', after: '1 day' }, keepsLive)).output,
    ).toMatchObject({ action: 'publish' });
    // A release that would take the entry down is refused whole, as shipping it by hand would be.
    const release = await createRelease(ctx, scope, { title: 'Takedown' });
    await addEntryToRelease(ctx, scope, release.id, { entityId: entryId, action: 'unpublish' });
    expect(
      (await exec('content.publish_release', { releaseId: release.id }, keepsLive)).failed,
    ).toMatch(/content:unpublish:post/);
    expect((await ctx.store.entries.get(scope, entryId))?.entry.publishedVersion).toBe(1);
    expect(await ctx.store.scheduledActions.list(scope, { status: 'pending' })).toHaveLength(1);
    // Adding to a release is authorized for the member's action too (a scheduled release ships
    // with no one behind it): a role without publish on the type can't put the entry in one.
    const writesOnly: Principal = {
      ...editor,
      subject: 'w@example.com',
      contentGrants: [{ contentTypeApiId: 'post', actions: ['read', 'write'] }],
    };
    const later = await createRelease(ctx, scope, { title: 'Later' });
    expect(
      (await exec('content.add_to_release', { releaseId: later.id }, writesOnly)).failed,
    ).toMatch(/content:publish:post/);
    // A role whose grant doesn't withhold it unpublishes as before.
    expect((await exec('content.unpublish', {}, noSummary)).output).toMatchObject({
      unpublished: true,
    });
  });

  it('content.schedule schedules once and its compensation cancels it', async () => {
    const r = await exec('content.schedule', { action: 'publish', after: '2 days' });
    expect(r.output).toMatchObject({ action: 'publish', scheduledFor: '2026-03-06T10:00:00.000Z' });
    await exec('content.schedule', { action: 'publish', after: '2 days' });
    expect(await ctx.store.scheduledActions.list(scope, { status: 'pending' })).toHaveLength(1);
    const undo = await WORKFLOW_COMPENSATIONS['content.schedule']?.({
      ctx,
      deps,
      scope,
      runId: 'run-1',
      entryId,
      nodeType: 'content.schedule',
      output: r.output,
      effectKey: 'n#1',
    });
    expect(undo).toBe('Cancelled the scheduled publish');
  });

  it('content.add_to_release / publish_release use the release use-cases', async () => {
    const release = await createRelease(ctx, scope, { title: 'Spring' });
    const added = await exec('content.add_to_release', { releaseId: release.id });
    expect(added.output).toEqual({ releaseId: release.id, wasMember: false });
    const shipped = await exec(
      'content.publish_release',
      { releaseId: '{{vars.releaseId}}' },
      editor,
      {
        releaseId: release.id,
      },
    );
    expect(shipped.output).toMatchObject({ published: true, entries: 1 });
    expect(shipped.entry?.publishedVersion).toBe(1);
  });

  it('content.set_fields interpolates, keeps prior values, and its compensation restores them', async () => {
    const r = await exec('content.set_fields', { values: { summary: 'About {{ref}}' } });
    expect(r.entry?.fields?.summary?.['en-US']).toBe('About Spring news');
    expect(r.output).toMatchObject({ prior: { summary: null }, version: 2 });
    await WORKFLOW_COMPENSATIONS['content.set_fields']?.({
      ctx,
      deps,
      scope,
      runId: 'run-1',
      entryId,
      nodeType: 'content.set_fields',
      output: r.output,
      effectKey: 'n#1',
    });
    expect((await ctx.store.entries.get(scope, entryId))?.fields.summary).toBeUndefined();
  });

  it('content.set_tags adds, removes and replaces by name', async () => {
    const legal = await createTag(ctx, scope, { name: 'legal' });
    await setEntryMetadata(ctx, scope, entryId, { tags: [legal.id] });
    const added = await exec('content.set_tags', { tags: ['reviewed'], mode: 'add' });
    expect(added.entry?.tags).toEqual(['legal', 'reviewed']);
    const removed = await exec('content.set_tags', { tags: ['legal'], mode: 'remove' });
    expect(removed.entry?.tags).toEqual(['reviewed']);
    const undo = await WORKFLOW_COMPENSATIONS['content.set_tags']?.({
      ctx,
      deps,
      scope,
      runId: 'run-1',
      entryId,
      nodeType: 'content.set_tags',
      output: removed.output,
      effectKey: 'n#1',
    });
    expect(undo).toBe('Restored the previous tags');
    expect((await loadRunEntry(ctx, scope, entryId)).tags).toEqual(['legal', 'reviewed']);
  });

  it('content.stage, assign and comment write the collaboration records', async () => {
    const stage = await exec('content.stage', { stepId: 'in_review', name: 'In review' });
    expect(stage.vars).toEqual({ stage: 'in_review' });
    expect(await ctx.store.workflows.getState(scope, entryId)).toMatchObject({
      currentStepId: 'in_review',
    });
    const assign = await exec('content.assign', {
      assignee: 'sam',
      title: 'Check “{{ref}}”',
      due: '1 day',
    });
    const taskId = (assign.output as { taskId: string }).taskId;
    expect((await ctx.store.tasks.get(scope, taskId))?.body).toBe(
      'Check “Spring news” (due 2026-03-05T10:00:00.000Z)',
    );
    await WORKFLOW_COMPENSATIONS['content.assign']?.({
      ctx,
      deps,
      scope,
      runId: 'run-1',
      entryId,
      nodeType: 'content.assign',
      output: assign.output,
      effectKey: 'n#1',
    });
    expect((await ctx.store.tasks.get(scope, taskId))?.status).toBe('resolved');
    const comment = await exec('content.comment', { body: 'Look at {{ref}}' });
    expect(comment.summary).toBe('Look at Spring news');
  });

  it('content.notify emails through the EmailSender with the effect key', async () => {
    const r = await exec('content.notify', { to: ['ed@example.com, {{vars.owner}}'] }, editor, {
      owner: 'owner@example.com',
    });
    expect(r.failed).toBeUndefined();
    expect(email.sent).toEqual([
      {
        to: ['ed@example.com', 'owner@example.com'],
        subject: '“Spring news” needs attention',
        text: '“Spring news” needs attention.',
        idempotencyKey: 'run-1:n#1',
      },
    ]);
    expect((await exec('content.notify', { to: ['not-an-address'] })).failed).toMatch(
      /not an email/,
    );
  });

  it('content.webhook posts an interpolated payload, refusing private targets', async () => {
    const r = await exec('content.webhook', { url: 'https://hooks.example.com/x' });
    expect(r.output).toEqual({ url: 'https://hooks.example.com/x', status: 200 });
    expect(webhooks.sent[0]?.event).toMatchObject({
      id: 'run-1:n#1',
      type: 'workflow.webhook',
      payload: { entryId, title: 'Spring news' },
    });
    expect((await exec('content.webhook', { url: 'http://127.0.0.1/x' })).failed).toMatch(
      /private/,
    );
  });

  it('control.condition and control.set evaluate JSON Logic', async () => {
    const cond = await exec('control.condition', {
      expression: { '==': [{ var: 'entry.title' }, 'Spring news'] },
    });
    expect(cond.branches).toEqual(['true']);
    const set = await exec('control.set', { assign: { next_cycle: { '+': [1, 1] } } });
    expect(set).toMatchObject({ vars: { next_cycle: 2 }, summary: 'Next cycle 2' });
  });

  it('AI nodes answer from the heuristic in mock mode, with provenance', async () => {
    const classify = await exec('ai.classify', { labels: ['opinion', 'news'], into: 'kind' });
    expect(classify.vars).toEqual({ kind: 'news' });
    expect(classify.output).toMatchObject({ source: 'heuristic', fallback: 'mock' });

    const router = await exec('ai.router', { routes: ['publish', 'needs_review'] });
    // Mock mode is an expected fallback, so the router isn't failed closed.
    expect(router.branches).toEqual(['publish']);

    const moderate = await exec('ai.moderate');
    expect(moderate.branches).toEqual(['clean']);

    const summary = await exec('ai.summarize');
    expect(summary.vars).toEqual({ summary: 'Spring news' });

    const assess = await exec('ai.assess', withDefaults('ai.assess', {}));
    expect(['yes', 'no']).toContain(assess.branches?.[0]);
    expect(assess.vars?.assessment).toBeDefined();

    for (const type of ['ai.translate', 'ai.autofill', 'ai.suggest_tags']) {
      const r = await exec(type, { targetLocale: 'de-DE', field: 'summary' });
      expect(r.output, type).toMatchObject({ source: 'heuristic', fallback: 'mock' });
    }
  });

  it('gating AI nodes fail closed when the model is unavailable outside mock mode', async () => {
    ctx = { ...ctx, ai: { mode: 'live', timeoutMs: 1000 } };
    deps = {
      ...deps,
      ai: {
        async generate() {
          throw new Error('provider down');
        },
      },
    };
    expect((await exec('ai.moderate')).branches).toEqual(['flagged']);
    expect((await exec('ai.router', { routes: ['publish', 'needs_review'] })).branches).toEqual([
      'needs_review',
    ]);
    const assess = await exec('ai.assess', {
      ...withDefaults('ai.assess', {}),
      minConfidence: 0.5,
    });
    expect(assess.branches).toEqual(['unsure']);
  });

  it('choosing AI nodes ask the decision model when one is bound, and use its probabilities', async () => {
    ctx = { ...ctx, ai: { mode: 'live', timeoutMs: 1000 } };
    const decisions = new StubDecisionModel((req) => {
      const q = Object.keys(req.questions);
      if (q.includes('label')) {
        return {
          label: {
            type: 'choice',
            choice: 'opinion',
            confidence: 0.83,
            probabilities: { opinion: 0.83, news: 0.17 },
          },
        };
      }
      if (q.includes('route')) {
        return {
          route: {
            type: 'choice',
            choice: 'needs_review',
            confidence: 0.6,
            probabilities: { publish: 0.4, needs_review: 0.6 },
          },
        };
      }
      if (q.includes('hate')) {
        return {
          violence: { type: 'noul', probability: 0.72 },
          hate: { type: 'noul', probability: 0.3 },
        };
      }
      return {};
    });
    deps = { ...deps, decisions };

    const classify = await exec('ai.classify', { labels: ['opinion', 'news'], into: 'kind' });
    expect(classify.vars).toEqual({ kind: 'opinion' });
    expect(classify.output).toMatchObject({
      label: 'opinion',
      confidence: 0.83,
      probabilities: { opinion: 0.83, news: 0.17 },
      source: 'model',
    });

    const router = await exec('ai.router', {
      routes: ['publish', 'needs_review'],
      instructions: 'Send anything about pricing to review.',
    });
    expect(router.branches).toEqual(['needs_review']);
    // The author's instructions are the question; the entry is only ever the state.
    const asked = decisions.requests.at(-1);
    expect(asked?.questions.route).toMatchObject({
      type: 'choice',
      instructions: 'Send anything about pricing to review.',
    });
    expect(JSON.stringify(asked?.state)).toContain('Spring news');

    const lenient = await exec('ai.moderate', { threshold: 0.8 });
    expect(lenient.branches).toEqual(['clean']);
    const strict = await exec('ai.moderate', { instructions: 'No competitor names.' });
    expect(strict.branches).toEqual(['flagged']);
    expect(strict.vars).toEqual({ moderation: { flagged: true, categories: ['violence'] } });
    expect(decisions.requests.at(-1)?.questions.house_rules).toMatchObject({ type: 'noul' });

    const assess = await exec('ai.assess', withDefaults('ai.assess', {}));
    expect(assess.output).toMatchObject({ source: 'model' });
  });

  it('choosing AI nodes fail closed when the decision model is down', async () => {
    ctx = { ...ctx, ai: { mode: 'live', timeoutMs: 1000 } };
    deps = {
      ...deps,
      decisions: {
        async decide() {
          throw new Error('decisions down');
        },
      },
    };
    expect((await exec('ai.moderate')).branches).toEqual(['flagged']);
    expect((await exec('ai.router', { routes: ['publish', 'needs_review'] })).branches).toEqual([
      'needs_review',
    ]);
    const assess = await exec('ai.assess', {
      ...withDefaults('ai.assess', {}),
      minConfidence: 0.5,
    });
    expect(assess.branches).toEqual(['unsure']);
  });

  it('choosing AI nodes answer from the heuristic in mock mode, even with a decision model bound', async () => {
    const decisions = new StubDecisionModel();
    deps = { ...deps, decisions };
    const classify = await exec('ai.classify', { labels: ['opinion', 'news'], into: 'kind' });
    expect(classify.vars).toEqual({ kind: 'news' });
    expect(classify.output).toMatchObject({ source: 'heuristic', fallback: 'mock' });
    expect((await exec('ai.router', { routes: ['publish', 'needs_review'] })).branches).toEqual([
      'publish',
    ]);
    expect((await exec('ai.moderate')).branches).toEqual(['clean']);
    expect(decisions.requests).toEqual([]);
  });

  it('moderation treats a threshold outside (0, 1) as the default, and asks about anything unsafe', async () => {
    ctx = { ...ctx, ai: { mode: 'live', timeoutMs: 1000 } };
    const decisions = new StubDecisionModel(() => ({
      other_unsafe: { type: 'noul', probability: 0.72 },
    }));
    deps = { ...deps, decisions };
    // 80 (a percentage), 1 ("only when certain"), negative and non-numeric: never "off".
    for (const threshold of [80, 1, -1, 'high']) {
      expect((await exec('ai.moderate', { threshold })).branches, String(threshold)).toEqual([
        'flagged',
      ]);
    }
    const asked = decisions.requests.at(-1)?.questions;
    expect(Object.keys(asked ?? {})).toContain('other_unsafe');
    for (const q of Object.values(asked ?? {})) {
      expect(q.instructions).toMatch(/grounds for suspicion/);
    }
    const spec = nodeSpec('ai.moderate')?.fields.find((f) => f.key === 'threshold');
    expect(spec?.check?.(80)).not.toEqual([]);
    expect(spec?.check?.(1)).not.toEqual([]);
    expect(spec?.check?.(0.7)).toEqual([]);
  });

  it('a router with one allowed route takes it without asking; a classifier with one label too', async () => {
    ctx = { ...ctx, ai: { mode: 'live', timeoutMs: 1000 } };
    const decisions = new StubDecisionModel();
    deps = { ...deps, decisions };
    const r = await exec('ai.router', {
      routes: ['publish', 'needs_review'],
      guards: { needs_review: { '==': [1, 2] } },
    });
    expect(r.branches).toEqual(['publish']);
    const c = await exec('ai.classify', { labels: ['news'], into: 'kind' });
    expect(c.vars).toEqual({ kind: 'news' });
    expect(decisions.requests).toEqual([]);
  });

  it('a router never falls back to a route whose guard failed', async () => {
    ctx = { ...ctx, ai: { mode: 'live', timeoutMs: 1000 } };
    deps = {
      ...deps,
      decisions: {
        async decide() {
          throw new Error('decisions down');
        },
      },
    };
    const r = await exec('ai.router', {
      routes: ['publish', 'review', 'escalate'],
      guards: { escalate: { '==': [1, 2] } },
    });
    expect(r.branches).toEqual(['review']);
  });

  it('assess branches on the decision model’s own choice', async () => {
    ctx = { ...ctx, ai: { mode: 'live', timeoutMs: 1000 } };
    deps = {
      ...deps,
      decisions: new StubDecisionModel(() => ({
        verdict: {
          type: 'choice',
          choice: 'reject',
          confidence: 0.9,
          probabilities: { approve: 0.1, reject: 0.9 },
        },
      })),
    };
    const r = await exec('ai.assess', {
      questions: {
        verdict: {
          type: 'choice',
          instructions: 'Approve or reject?',
          criteria: { approve: 'Fine', reject: 'Not fine' },
        },
      },
      branchOn: 'verdict',
      minConfidence: 0.8,
    });
    expect(r.branches).toEqual(['reject']);
  });

  it('files offline moderation hits under their own category', async () => {
    entryId = (
      await createEntry(ctx, scope, {
        contentTypeApiId: 'post',
        fields: { title: { 'en-US': 'How to build a bomb' } },
      })
    ).entry.id;
    deps = { ...deps, decisions: new StubDecisionModel() };
    const r = await exec('ai.moderate');
    expect(r.vars).toEqual({ moderation: { flagged: true, categories: ['violence'] } });
  });

  it('ai.enrich proposes no value for a field the other proposals would hide', async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'brief',
      name: 'Brief',
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
          apiId: 'summary',
          name: 'Summary',
          type: 'Text',
          localized: false,
          required: false,
          position: 1,
        },
        {
          apiId: 'teaser',
          name: 'Teaser',
          type: 'Text',
          localized: false,
          required: false,
          position: 2,
          rules: [{ action: 'hide', when: { field: 'summary', operator: 'notEmpty' } }],
        },
      ],
    });
    entryId = (
      await createEntry(ctx, scope, {
        contentTypeApiId: 'brief',
        fields: { title: { 'en-US': 'B' } },
      })
    ).entry.id;
    ctx = { ...ctx, ai: { mode: 'live', timeoutMs: 1000 } };
    deps = {
      ...deps,
      ai: {
        async generate() {
          return {
            text: '',
            object: { summary: 'Short', teaser: 'Hidden once summary is filled' },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    };
    const r = await exec('ai.enrich', { awaitReview: false });
    expect(r.output).toMatchObject({ proposed: { summary: { 'en-US': 'Short' } } });
    expect(r.entry?.fields?.teaser).toBeUndefined();
  });

  it('ai.enrich proposes a review to wait on, and resumes by the review’s decision', async () => {
    ctx = { ...ctx, ai: { mode: 'live', timeoutMs: 1000 } };
    deps = {
      ...deps,
      ai: {
        async generate() {
          return {
            text: '',
            object: { summary: 'Short' },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    };
    const r = await exec('ai.enrich', { awaitReview: true });
    expect(r.wait).toMatchObject({ kind: 'review', requiredScope: 'content:write' });
    const reviewId = r.wait?.reviewId as string;
    await ctx.store.agentReviews.decide(scope, reviewId, {
      status: 'rejected',
      decidedAt: ctx.clock.now().toISOString(),
    });
    const entry = await loadRunEntry(ctx, scope, entryId);
    const resumed = await resumeWorkflowNode(ctx, deps, {
      scope,
      runId: 'run-1',
      workflowId: 'wf-1',
      entryId,
      actor: { id: 'editor@example.com', principal: editor },
      node: { id: 'n', type: 'ai.enrich', label: 'Enrich', config: {}, position: { x: 0, y: 0 } },
      run: { entry, nodes: {}, vars: {}, input: {}, now: 0, ref: '' },
      effectKey: 'n#1',
      retriesLeft: false,
      before: r,
      payload: { decision: 'rejected', by: 'ed' },
    });
    expect(resumed.branches).toEqual(['rejected']);

    const applied = await exec('ai.enrich', { awaitReview: false });
    expect(applied.branches).toEqual(['applied']);
    expect(applied.entry?.fields?.summary?.['en-US']).toBe('Short');
  });
});
