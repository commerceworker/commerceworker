/**
 * Editorial workflow templates. Each is a normal editable workflow built with the `Builder`.
 */

import { SCOPES } from '../auth/auth';
import type {
  WorkflowEdge,
  WorkflowGraph,
  WorkflowGraphDefinition,
  WorkflowNode,
} from './graph-types';
import { autoLayout } from './layout';
import { withDefaults } from './nodes';
import { LOOP_INPUT } from './planner';

export class WorkflowBuilder {
  nodes: WorkflowNode[] = [];
  edges: WorkflowEdge[] = [];
  n(id: string, type: string, label: string, config: Record<string, unknown> = {}) {
    this.nodes.push({
      id,
      type,
      label,
      config: withDefaults(type, config),
      position: { x: 0, y: 0 },
    });
    return this;
  }
  /** `from` may be "node" or "node.branch". */
  e(from: string, to: string, targetHandle?: string) {
    const [source, sourceHandle] = from.split('.') as [string, string | undefined];
    this.edges.push({
      id: `${source}${sourceHandle ? `.${sourceHandle}` : ''}-${to}${targetHandle ? `.${targetHandle}` : ''}`,
      source,
      target: to,
      sourceHandle: sourceHandle ?? null,
      targetHandle: targetHandle ?? null,
    });
    return this;
  }
  /** The graph, laid out. */
  graph(): WorkflowGraph {
    return autoLayout({ nodes: this.nodes, edges: this.edges });
  }
  build(meta: Omit<WorkflowGraphDefinition, 'graph'>): WorkflowGraphDefinition {
    return { ...meta, graph: this.graph() };
  }
}

/** Approval → write review (content:write) → legal (content:publish) when tagged → publish. */
export function editorialReviewWorkflow(): WorkflowGraphDefinition {
  return new WorkflowBuilder()
    .n('requested', 'trigger.publish_requested', 'Publish requested')
    .n('validate', 'content.validate', 'Validate entry')
    .n('fix', 'content.comment', 'Ask for fixes', {
      body: 'This entry has validation errors and was not published: {{nodes.validate.issues}}',
    })
    .n('invalid', 'control.end', 'Invalid', { outcome: 'declined', reason: 'Validation failed' })
    .n('editor', 'control.approval', 'Editor review', {
      title: 'Review “{{ref}}”',
      assignee: 'editor',
      requiredScope: SCOPES.contentWrite,
      timeout: '2 days',
    })
    .n('legal_tag', 'control.condition', 'Tagged legal?', {
      expression: { in: ['legal', { var: 'entry.tags' }] },
    })
    .n('legal', 'control.approval', 'Legal sign-off', {
      title: 'Legal sign-off for “{{ref}}”',
      assignee: 'legal',
      requiredScope: SCOPES.contentPublish,
      timeout: '3 days',
      separateDuties: true,
    })
    .n('publish', 'content.publish', 'Publish')
    .n('done', 'control.end', 'Published', { outcome: 'completed' })
    .n('rejected', 'control.end', 'Not approved', { outcome: 'declined', reason: 'Not approved' })
    .n('expired', 'control.end', 'No decision', {
      outcome: 'declined',
      reason: 'No review decision in time',
    })
    .e('requested', 'validate')
    .e('validate.valid', 'editor')
    .e('validate.invalid', 'fix')
    .e('fix', 'invalid')
    .e('editor.approved', 'legal_tag')
    .e('editor.rejected', 'rejected')
    .e('editor.escalated', 'expired')
    .e('legal_tag.true', 'legal')
    .e('legal_tag.false', 'publish')
    .e('legal.approved', 'publish')
    .e('legal.rejected', 'rejected')
    .e('legal.escalated', 'expired')
    .e('publish', 'done')
    .build({
      id: 'tpl-editorial-review',
      name: 'Editorial review',
      description:
        'Publish requests are validated, reviewed by an editor and, when tagged legal, signed off by legal before they publish.',
      contentTypes: [],
      // Not gated: nothing starts a run from trigger.publish_requested yet, so a gate here would
      // lock every entry (and publishing a gated version that no run can publish is refused).
      gatesPublish: false,
    });
}

/** Clean entries publish at once; flagged ones wait for a person. */
export function moderateThenPublishWorkflow(): WorkflowGraphDefinition {
  return new WorkflowBuilder()
    .n('requested', 'trigger.publish_requested', 'Publish requested')
    .n('moderate', 'ai.moderate', 'Moderate')
    .n('review', 'control.approval', 'Review flagged entry', {
      title: 'Moderation flagged “{{ref}}”',
      assignee: 'editor',
      requiredScope: SCOPES.contentPublish,
      timeout: '2 days',
      instructions: 'The moderation agent flagged this entry: {{vars.moderation.reasons}}',
    })
    .n('publish', 'content.publish', 'Publish')
    .n('done', 'control.end', 'Published', { outcome: 'completed' })
    .n('tell_author', 'content.comment', 'Tell the author', {
      body: 'Not published after moderation review.',
    })
    .n('rejected', 'control.end', 'Not approved', { outcome: 'declined', reason: 'Not approved' })
    .n('expired', 'control.end', 'No decision', {
      outcome: 'declined',
      reason: 'No moderation decision in time',
    })
    .e('requested', 'moderate')
    .e('moderate.clean', 'publish')
    .e('moderate.flagged', 'review')
    .e('review.approved', 'publish')
    .e('review.rejected', 'tell_author')
    .e('review.escalated', 'expired')
    .e('tell_author', 'rejected')
    .e('publish', 'done')
    .build({
      id: 'tpl-moderate-then-publish',
      name: 'Moderate then publish',
      description:
        'The moderation agent checks every publish request; clean entries publish, flagged ones wait for a reviewer.',
      contentTypes: [],
      // Not gated: nothing starts a run from trigger.publish_requested yet, so a gate here would
      // lock every entry (and publishing a gated version that no run can publish is refused).
      gatesPublish: false,
    });
}

/** New entries get an enrich proposal an editor approves from the inbox. */
export function enrichWithReviewWorkflow(): WorkflowGraphDefinition {
  return new WorkflowBuilder()
    .n('created', 'trigger.entry_created', 'Entry created')
    .n('enrich', 'ai.enrich', 'Enrich', { awaitReview: true, timeout: '7 days' })
    .n('stage', 'content.stage', 'Mark enriched', { stepId: 'enriched', name: 'Enriched' })
    .n('done', 'control.end', 'Enriched', { outcome: 'completed' })
    .n('skipped', 'control.end', 'Not enriched', {
      outcome: 'completed',
      reason: 'Enrichment not applied',
    })
    .e('created', 'enrich')
    .e('enrich.approved', 'stage')
    .e('enrich.rejected', 'skipped')
    .e('enrich.timeout', 'skipped')
    .e('stage', 'done')
    .build({
      id: 'tpl-enrich-with-review',
      name: 'Enrich with review',
      description:
        'The enrich agent proposes SEO fields, a summary and tags for each new entry; an editor approves or rejects the proposal.',
      contentTypes: [],
    });
}

/** One translation per configured locale, in a loop. */
export function translateOnPublishWorkflow(locales: string[] = ['de-DE', 'fr-FR']) {
  const current = { var: { cat: ['vars.locales.', { var: 'vars.i' }] } };
  return new WorkflowBuilder()
    .n('published', 'trigger.entry_published', 'Entry published')
    .n('init', 'control.set', 'Locales to translate', { assign: { locales, i: 0 } })
    .n('each', 'control.loop', 'Each locale', {
      while: { '<': [{ var: 'vars.i' }, { len: [{ var: 'vars.locales' }] }] },
      maxIterations: 20,
    })
    .n('pick', 'control.set', 'Pick locale', { assign: { locale: current } })
    .n('translate', 'ai.translate', 'Translate', { targetLocale: '{{vars.locale}}' })
    .n('advance', 'control.set', 'Next locale', {
      assign: { i: { '+': [{ var: 'vars.i' }, 1] } },
    })
    .n('done', 'control.end', 'Translated', { outcome: 'completed' })
    .e('published', 'init')
    .e('init', 'each')
    .e('each.body', 'pick')
    .e('pick', 'translate')
    .e('translate', 'advance')
    .e('advance', 'each', LOOP_INPUT)
    .e('each.done', 'done')
    .build({
      id: 'tpl-translate-on-publish',
      name: 'Translate on publish',
      description:
        'Each time an entry publishes, its localized fields are translated into every listed locale.',
      contentTypes: [],
    });
}

/** Every quarter, stale entries get a refresh task. */
export function quarterlyFreshnessReviewWorkflow(): WorkflowGraphDefinition {
  return new WorkflowBuilder()
    .n('quarterly', 'trigger.schedule', 'Quarterly', { cron: '0 9 1 1,4,7,10 *' })
    .n('assess', 'ai.assess', 'Still accurate?', {
      questions: {
        stale: {
          type: 'noul',
          instructions:
            'Is this entry out of date: facts, dates, prices or links that no longer hold?',
        },
      },
      branchOn: 'stale',
      minConfidence: 0,
    })
    .n('assign', 'content.assign', 'Refresh task', {
      assignee: 'editor',
      title: 'Refresh “{{ref}}”',
      due: '14 days',
    })
    .n('done', 'control.end', 'Assigned', { outcome: 'completed' })
    .n('fresh', 'control.end', 'Still fresh', { outcome: 'completed' })
    .e('quarterly', 'assess')
    .e('assess.yes', 'assign')
    .e('assess.no', 'fresh')
    .e('assign', 'done')
    .build({
      id: 'tpl-quarterly-freshness',
      name: 'Quarterly freshness review',
      description:
        'Each quarter an assessment reads every published entry and assigns a refresh task for the ones that are out of date.',
      contentTypes: [],
    });
}

export const WORKFLOW_TEMPLATES = {
  'tpl-editorial-review': editorialReviewWorkflow,
  'tpl-moderate-then-publish': moderateThenPublishWorkflow,
  'tpl-enrich-with-review': enrichWithReviewWorkflow,
  'tpl-translate-on-publish': () => translateOnPublishWorkflow(),
  'tpl-quarterly-freshness': quarterlyFreshnessReviewWorkflow,
} satisfies Record<string, () => WorkflowGraphDefinition>;
export type WorkflowTemplateId = keyof typeof WORKFLOW_TEMPLATES;
