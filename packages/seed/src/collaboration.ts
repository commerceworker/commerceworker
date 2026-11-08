import {
  addComment,
  createTask,
  defineWorkflow,
  listWorkflows,
  resolveTask,
  transitionEntry,
} from '@commerceworker/application';
import { scopesForKind } from '@commerceworker/domain';
import { pick, WORDS } from './helpers';
import type { SeedRun } from './types';

const AUTHORS = [
  'jordan@example.com',
  'alex@example.com',
  'sam@example.com',
  'riley@example.com',
  'casey@example.com',
] as const;

const COMMENT_OPENERS = [
  'Can we tighten the intro on this one?',
  'The summary oversells the benchmark section — soften it?',
  'Legal asked us to name the source for the second claim.',
  'This reads great. One nit: the closing paragraph repeats the lede.',
  'Should this link to the pricing page instead of the docs?',
  'The German translation is missing for the summary field.',
  'Hero image feels off-brand — swap for the architecture diagram?',
  'Numbers in paragraph two need a date reference.',
] as const;

const COMMENT_REPLIES = [
  'Agreed — drafting a shorter opening now.',
  'Good catch, fixed in the latest draft.',
  'Ship it once the summary matches.',
  'I asked marketing; holding until they confirm.',
  'Done. Re-review when you get a chance?',
] as const;

const TASK_BODIES = [
  'Fact-check the benchmark numbers',
  'Add alt text to the hero image',
  'Confirm the release date with marketing',
  'Translate summary to German',
  'Link the related product entries',
  'Review SEO description length',
  'Verify the code sample compiles',
  'Update the author bio link',
  'Check category assignment',
  'Schedule the social posts',
  'Add the event to the newsletter',
  'Archive the superseded guide',
] as const;

/**
 * Editorial collaboration: two scope-gated workflows with entries spread
 * across their steps, threaded comment discussions, and a mix of
 * open/assigned/resolved tasks. Guarded by workflow existence (one list query
 * when already seeded).
 */
export async function seedCollaboration(
  run: SeedRun,
  articleIds: readonly string[],
): Promise<void> {
  const { ctx, scope } = run;
  if (articleIds.length < 12) return;

  const workflows = await listWorkflows(ctx, scope);
  if (workflows.some((w) => w.name === 'Editorial review')) return;

  const editorial = await defineWorkflow(ctx, scope, {
    name: 'Editorial review',
    steps: [
      { id: 'draft', name: 'Draft', requiredScope: 'content:write' },
      { id: 'review', name: 'In review', requiredScope: 'content:write' },
      { id: 'approved', name: 'Approved', requiredScope: 'content:publish' },
    ],
  });
  const legal = await defineWorkflow(ctx, scope, {
    name: 'Legal sign-off',
    steps: [
      { id: 'submitted', name: 'Submitted', requiredScope: 'content:write' },
      { id: 'cleared', name: 'Cleared', requiredScope: 'content:manage' },
    ],
  });

  // Seeding acts as a management principal; transition enforcement stays live.
  const callerScopes = scopesForKind('cma');
  const editorialSteps = ['draft', 'review', 'approved'] as const;
  for (let i = 0; i < 9; i++) {
    await transitionEntry(
      ctx,
      scope,
      { entryId: articleIds[i]!, workflowId: editorial.id, toStepId: pick(editorialSteps, i) },
      callerScopes,
    );
  }
  const legalSteps = ['submitted', 'cleared'] as const;
  for (let i = 9; i < 12; i++) {
    await transitionEntry(
      ctx,
      scope,
      { entryId: articleIds[i]!, workflowId: legal.id, toStepId: pick(legalSteps, i) },
      callerScopes,
    );
  }

  // Comment threads on the first 10 in-flow entries; every other one gets a
  // short reply thread so the panel shows real discussions.
  for (let i = 0; i < 10; i++) {
    const entryId = articleIds[i]!;
    const root = await addComment(ctx, scope, {
      entryId,
      author: pick(AUTHORS, i),
      body: pick(COMMENT_OPENERS, i),
    });
    if (i % 2 === 0) {
      await addComment(ctx, scope, {
        entryId,
        author: pick(AUTHORS, i + 1),
        parentId: root.id,
        body: pick(COMMENT_REPLIES, i),
      });
      await addComment(ctx, scope, {
        entryId,
        author: pick(AUTHORS, i + 2),
        parentId: root.id,
        body: pick(COMMENT_REPLIES, i + 3),
      });
    }
    if (i % 3 === 0) {
      await addComment(ctx, scope, {
        entryId,
        author: pick(AUTHORS, i + 3),
        body: `Separate thread: ${pick(WORDS.topics, i)} angle is worth its own follow-up piece.`,
      });
    }
  }

  // Tasks across the same entries: open, assigned, and resolved states.
  for (let i = 0; i < TASK_BODIES.length; i++) {
    const task = await createTask(ctx, scope, {
      entryId: pick([...articleIds.slice(0, 12)], i),
      body: TASK_BODIES[i]!,
      assignee: i % 3 === 0 ? pick(AUTHORS, i) : undefined,
    });
    if (i % 4 === 3) await resolveTask(ctx, scope, task.id);
  }
}
