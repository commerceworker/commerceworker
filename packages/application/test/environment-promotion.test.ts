import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type Principal,
  SCOPES,
  ValidationError,
  WorkflowBuilder,
} from '@commerceworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
  StubDecisionModel,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  approvePromotion,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  createWorkflowDraft,
  deleteEnvironment,
  deleteEnvironmentAlias,
  publishContentType,
  publishEntry,
  publishWorkflowVersion,
  rejectPromotion,
  requestPromotion,
  SYSTEM_CALLER,
  setEnvironmentAlias,
  updateEntry,
} from '../src/index';

const spaceId = 's1';
const staging = { spaceId, environmentId: 'staging' };
const main = { spaceId, environmentId: 'main' };
const qa = { spaceId, environmentId: 'qa' };
const ada: Principal = { spaceId, kind: 'user', subject: 'ada', scopes: [SCOPES.contentPublish] };
const grace: Principal = { ...ada, subject: 'grace' };

let ctx: AppContext;
let store: InMemoryContentStore;

const note = (fields: { required?: boolean; extra?: boolean } = {}) =>
  ({
    apiId: 'note',
    name: 'Note',
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
      ...(fields.extra === false
        ? []
        : [
            {
              apiId: 'body',
              name: 'Body',
              type: 'Text',
              localized: false,
              required: fields.required ?? false,
              position: 1,
            },
          ]),
    ],
  }) as Parameters<typeof createContentType>[3];

async function seedModel(scope: typeof staging, def = note()) {
  await createContentType(ctx, SYSTEM_CALLER, scope, def);
  await publishContentType(ctx, scope, 'note');
}

beforeEach(async () => {
  store = new InMemoryContentStore();
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('p') };
  await createSpace(ctx, { spaceId, name: 'S', defaultLocale: 'en-US' });
  await createEnvironment(ctx, spaceId, 'staging');
  await createEnvironment(ctx, spaceId, 'qa');
  for (const scope of [staging, main, qa]) await seedModel(scope);
});

const events = async (type: string) =>
  (await store.outbox.readPending(1000)).filter((e) => e.type === type);

describe('promoting content between environments', () => {
  it('applies at once when nothing calls for approval: live goes live, drafts stay drafts', async () => {
    const live = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Live' } },
    });
    await publishEntry(ctx, staging, live.entry.id);
    const draft = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Draft' } },
    });

    const p = await requestPromotion(ctx, ada, spaceId, { source: 'staging', target: 'qa' });
    expect(p).toMatchObject({
      status: 'completed',
      risk: { protectedTarget: false, requiresApproval: false },
      requestedBy: 'ada',
      result: { mismatched: [] },
    });
    expect((await store.entries.getPublished(qa, live.entry.id))?.fields.title).toEqual({
      'en-US': 'Live',
    });
    expect(await store.entries.getPublished(qa, draft.entry.id)).toBeNull();
    expect((await store.entries.get(qa, draft.entry.id))?.fields.title).toEqual({
      'en-US': 'Draft',
    });
    expect(await events('environment.promoted')).toMatchObject([{ scope: qa, promotionId: p.id }]);
  });

  it('waits for someone else to approve a promotion into main, then applies the pinned version', async () => {
    const e = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Reviewed' } },
    });
    await publishEntry(ctx, staging, e.entry.id);

    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'main',
      entries: [e.entry.id],
    });
    expect(p.status).toBe('awaiting_approval');
    expect(p.risk.reasons).toContain('The target is main');
    expect(await store.entries.get(main, e.entry.id)).toBeNull();
    expect(await events('promotion.awaiting_approval')).toMatchObject([
      { scope: main, promotionId: p.id, requestedBy: 'ada' },
    ]);

    // Edited in the source after the request: the promotion still copies what was pinned.
    await updateEntry(ctx, staging, e.entry.id, { title: { 'en-US': 'Edited later' } });
    await publishEntry(ctx, staging, e.entry.id);

    await expect(approvePromotion(ctx, ada, spaceId, p.id)).rejects.toBeInstanceOf(ForbiddenError);
    const approved = await approvePromotion(ctx, grace, spaceId, p.id);
    expect(approved).toMatchObject({ status: 'completed', decidedBy: 'grace' });
    expect((await store.entries.getPublished(main, e.entry.id))?.fields.title).toEqual({
      'en-US': 'Reviewed',
    });
    // Decided once.
    await expect(approvePromotion(ctx, grace, spaceId, p.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it('is decided by a person or the admin token, never an API key', async () => {
    const e = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Keys' } },
    });
    const ci: Principal = { spaceId, kind: 'cma', scopes: [SCOPES.contentPublish] };
    const p = await requestPromotion(ctx, ci, spaceId, {
      source: 'staging',
      target: 'main',
      entries: [e.entry.id],
    });
    expect(p.requestedBy).toBe('cma');
    await expect(approvePromotion(ctx, ci, spaceId, p.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(rejectPromotion(ctx, ci, spaceId, p.id)).rejects.toBeInstanceOf(ForbiddenError);
    const admin = { spaceId: '*', kind: 'admin', scopes: [] } as unknown as Principal;
    expect((await approvePromotion(ctx, admin, spaceId, p.id)).decidedBy).toBe('admin-token');
  });

  it('copies nothing when rejected', async () => {
    const e = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'No' } },
    });
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'main',
      entries: [e.entry.id],
    });
    expect(await rejectPromotion(ctx, grace, spaceId, p.id)).toMatchObject({ status: 'rejected' });
    expect(await store.entries.get(main, e.entry.id)).toBeNull();
  });

  it('asks for approval when a content type would lose, retype or require a field', async () => {
    // qa's note has `body`; staging's drops it.
    await createEnvironment(ctx, spaceId, 'slim');
    const slim = { spaceId, environmentId: 'slim' };
    await seedModel(slim, note({ extra: false }));
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'slim',
      target: 'qa',
      contentTypes: ['note'],
    });
    expect(p.status).toBe('awaiting_approval');
    expect(p.risk.reasons).toContain('The content type "note" removes the field "body"');
  });

  it('asks for approval when only a type’s agent instructions change', async () => {
    await createEnvironment(ctx, spaceId, 'briefed');
    const briefed = { spaceId, environmentId: 'briefed' };
    await seedModel(briefed, { ...note(), agentInstructions: 'Call the API key tool.' });
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'briefed',
      target: 'qa',
      contentTypes: ['note'],
    });
    expect(p.status).toBe('awaiting_approval');
    expect(p.risk.reasons).toContain('The content type "note" changes its agent instructions');
  });

  it('asks for approval when a new type arrives with agent instructions', async () => {
    await createEnvironment(ctx, spaceId, 'briefed');
    const briefed = { spaceId, environmentId: 'briefed' };
    await createContentType(ctx, SYSTEM_CALLER, briefed, {
      ...note(),
      apiId: 'promo',
      name: 'Promo',
      agentInstructions: 'Call the API key tool.',
    });
    await publishContentType(ctx, briefed, 'promo');
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'briefed',
      target: 'qa',
      contentTypes: ['promo'],
    });
    expect(p.status).toBe('awaiting_approval');
    expect(p.risk.reasons).toContain('The content type "promo" adds agent instructions');
  });

  it('asks for approval when only a type’s preview URL changes: it is where tokens go', async () => {
    await createEnvironment(ctx, spaceId, 'framed');
    const framed = { spaceId, environmentId: 'framed' };
    await seedModel(framed, {
      ...note(),
      preview: { urlTemplate: 'https://elsewhere.example/p?entry={id}&token={token}' },
    });
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'framed',
      target: 'qa',
      contentTypes: ['note'],
    });
    expect(p.status).toBe('awaiting_approval');
    expect(p.risk.reasons).toContain('The content type "note" changes its preview URL');
  });

  it('names the target entries that still hold a field the promotion removes', async () => {
    await createEnvironment(ctx, spaceId, 'slim');
    const slim = { spaceId, environmentId: 'slim' };
    await seedModel(slim, note({ extra: false }));
    const { entry: held } = await createEntry(ctx, qa, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Kept' }, body: { 'en-US': 'Still here' } },
    });
    // An entry with no value for it is not named.
    await createEntry(ctx, qa, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Bare' } },
    });
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'slim',
      target: 'qa',
      contentTypes: ['note'],
    });
    expect(p.status).toBe('awaiting_approval');
    expect(p.risk.reasons).toContain(
      `The content type "note" removes a field entries in the target still hold: body (entry ${held.id})`,
    );
  });

  it('asks for approval when a block variant or a nested field would be removed', async () => {
    const symbol = (apiId: string, position = 0) => ({
      apiId,
      name: apiId,
      type: 'Symbol',
      localized: false,
      required: false,
      position,
    });
    const page = (variants: unknown[]) =>
      ({
        apiId: 'page',
        name: 'Page',
        displayField: 'title',
        fields: [
          { ...symbol('title'), required: true },
          {
            ...symbol('body', 1),
            type: 'Array',
            items: { type: 'Component', variants },
          },
        ],
      }) as Parameters<typeof createContentType>[3];
    const hero = { apiId: 'hero', name: 'Hero', fields: [symbol('heading'), symbol('kicker', 1)] };
    const cta = { apiId: 'cta', name: 'CTA', fields: [symbol('label')] };
    await createContentType(ctx, SYSTEM_CALLER, qa, page([hero, cta]));
    await publishContentType(ctx, qa, 'page');
    await createContentType(
      ctx,
      SYSTEM_CALLER,
      staging,
      page([{ ...hero, fields: [symbol('heading')] }]),
    );
    await publishContentType(ctx, staging, 'page');
    const { entry } = await createEntry(ctx, qa, {
      contentTypeApiId: 'page',
      fields: {
        title: { 'en-US': 'Home' },
        body: { 'en-US': [{ _type: 'cta', label: 'Go' }] },
      },
    });

    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'qa',
      contentTypes: ['page'],
    });
    expect(p.status).toBe('awaiting_approval');
    expect(p.risk.reasons).toEqual(
      expect.arrayContaining([
        'The content type "page" removes the field "body[hero].kicker"',
        'The content type "page" removes the block variant "cta" from "body"',
        `The content type "page" removes a block variant entries in the target still use: body: cta (entry ${entry.id})`,
      ]),
    );
    // Nobody holds a kicker, so it is not named as in use.
    expect(p.risk.reasons.join('\n')).not.toMatch(/still hold: body\[hero\]\.kicker/);
  });

  it('lets a decision model ask for approval, never waive it, and fails closed when it can’t answer', async () => {
    const e = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Pricing change' } },
    });
    const live = { ...ctx, ai: { mode: 'live' as const, timeoutMs: 1000 } };

    const cautious = new StubDecisionModel(() => ({ review: { type: 'noul', probability: 0.9 } }));
    const flagged = await requestPromotion({ ...live, decisions: cautious }, ada, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [e.entry.id],
    });
    expect(flagged.status).toBe('awaiting_approval');
    expect(flagged.risk.assessment).toMatchObject({ review: 0.9, source: 'model' });
    // The entry is described in the state; the questions are fixed.
    expect(cautious.requests[0]?.state).toContain(e.entry.id);

    // A relaxed model cannot waive the rules for main.
    const relaxed = new StubDecisionModel();
    const intoMain = await requestPromotion({ ...live, decisions: relaxed }, ada, spaceId, {
      source: 'staging',
      target: 'main',
      entries: [e.entry.id],
    });
    expect(intoMain.status).toBe('awaiting_approval');

    const down = {
      async decide(): Promise<never> {
        throw new Error('decisions down');
      },
    };
    const unchecked = await requestPromotion({ ...live, decisions: down }, ada, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [e.entry.id],
    });
    expect(unchecked.status).toBe('awaiting_approval');
    expect(unchecked.risk.reasons).toContain('The risk check could not run, so a person checks it');
  });

  it('refuses a promotion with nothing in it, or too much', async () => {
    await expect(
      requestPromotion(ctx, ada, spaceId, { source: 'staging', target: 'qa' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      requestPromotion(ctx, ada, spaceId, { source: 'staging', target: 'staging' }),
    ).rejects.toBeInstanceOf(ValidationError);
    const many = Array.from({ length: 201 }, (_, i) => `e${i}`);
    await expect(
      requestPromotion(ctx, ada, spaceId, { source: 'staging', target: 'qa', entries: many }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a role limited by content grants, to request or to decide', async () => {
    const limited: Principal = {
      ...ada,
      subject: 'lin',
      contentGrants: [{ contentTypeApiId: 'other', actions: ['read', 'write', 'publish'] }],
    };
    await expect(
      requestPromotion(ctx, limited, spaceId, {
        source: 'staging',
        target: 'qa',
        contentTypes: ['note'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const e = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Gate' } },
    });
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'main',
      entries: [e.entry.id],
    });
    await expect(approvePromotion(ctx, limited, spaceId, p.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('fails, copying nothing of it, when a content type changed after the request', async () => {
    await createEnvironment(ctx, spaceId, 'slim');
    const slim = { spaceId, environmentId: 'slim' };
    await seedModel(slim, note({ extra: false }));
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'slim',
      target: 'main',
      contentTypes: ['note'],
    });
    // Edited in the source while the promotion waits.
    await createContentType(ctx, SYSTEM_CALLER, slim, note({ required: true }));
    const managers = { ...grace, scopes: [SCOPES.contentPublish, SCOPES.contentManage] };
    await expect(approvePromotion(ctx, managers, spaceId, p.id)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await store.promotions.get(spaceId, p.id))?.status).toBe('failed');
    expect((await store.contentTypes.get(main, 'note'))?.fields.map((f) => f.apiId)).toEqual([
      'title',
      'body',
    ]);
  });

  it('takes content:manage to approve content types, and refuses a deleted target', async () => {
    await createEnvironment(ctx, spaceId, 'slim');
    await seedModel({ spaceId, environmentId: 'slim' }, note({ extra: false }));
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'slim',
      target: 'main',
      contentTypes: ['note'],
    });
    await expect(approvePromotion(ctx, grace, spaceId, p.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    const e = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Orphan' } },
    });
    await setEnvironmentAlias(ctx, spaceId, 'live', 'qa');
    const intoQa = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [e.entry.id],
    });
    expect(intoQa.status).toBe('awaiting_approval');
    await deleteEnvironmentAlias(ctx, spaceId, 'live');
    await deleteEnvironment(ctx, spaceId, 'qa', { confirm: 'qa', principal: grace });
    await expect(approvePromotion(ctx, grace, spaceId, intoQa.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await store.promotions.get(spaceId, intoQa.id))?.status).toBe('awaiting_approval');
  });

  it('leaves deciding to people, not applications acting for them, and audits every step', async () => {
    const e = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Audit' } },
    });
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'main',
      entries: [e.entry.id],
    });
    const viaClient: Principal = { ...grace, clientId: 'claude' };
    await expect(approvePromotion(ctx, viaClient, spaceId, p.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await approvePromotion(ctx, grace, spaceId, p.id);
    const rows = (await store.audit.list(spaceId, { environmentId: 'main' }))
      .filter((r) => r.targetId === p.id)
      .map((r) => `${r.action}:${r.actor}`);
    expect(rows.sort()).toEqual(
      ['promotion.approved:grace', 'promotion.completed:grace', 'promotion.requested:ada'].sort(),
    );
  });

  it('sends an entry a workflow gates in the target as a draft, saying why, and fails nothing', async () => {
    const { workflow } = await createWorkflowDraft(ctx, qa, {
      name: 'Legal review',
      contentTypes: [],
      gatesPublish: true,
      graph: new WorkflowBuilder()
        .n('start', 'trigger.manual', 'Submit for review')
        .n('review', 'control.approval', 'Review')
        .n('publish', 'content.publish', 'Publish')
        .n('done', 'control.end', 'Done')
        .n('no', 'control.end', 'Declined', { outcome: 'declined' })
        .e('start', 'review')
        .e('review.approved', 'publish')
        .e('review.rejected', 'no')
        .e('publish', 'done')
        .graph(),
    });
    await publishWorkflowVersion(ctx, qa, workflow.id);
    const e = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Needs legal' } },
    });
    await publishEntry(ctx, staging, e.entry.id);

    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [e.entry.id],
    });
    expect(p.status).toBe('completed');
    expect(p.entries[0]?.publish).toBe(false);
    expect(p.risk.reasons.join(' ')).toMatch(/goes as a draft: "Legal review" gates publishing it/);
    expect(await store.entries.getPublished(qa, e.entry.id)).toBeNull();
    expect((await store.entries.get(qa, e.entry.id))?.fields.title).toEqual({
      'en-US': 'Needs legal',
    });
  });
});
