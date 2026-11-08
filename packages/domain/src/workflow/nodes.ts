/**
 * The editorial node catalog. Specs only: the application pairs each type with an executor.
 *
 * - `trigger.manual`, `trigger.schedule` and the `control.*` specs drive the run (control.approval
 *   carries `requiredScope`, `separateDuties` and `instructions`);
 * - `ai.classify`, `ai.summarize`, `ai.router`, `ai.assess` and `ai.moderate` judge content;
 *   `ai.translate`, `ai.autofill`, `ai.suggest_tags` and `ai.enrich` call commerceworker's existing
 *   AI use-cases;
 * - the `content.*` specs each act on entries through an existing use-case.
 */

import { SCOPES } from '../auth/auth';
import { assertValidCron } from '../scheduling/cron';
import { assessConfigErrors, assessOutputs, assessQuestionsIssues } from './assess';
import {
  type ConfigField,
  type NodeSpec,
  specDefaults,
  specOutputs,
  stringList,
  validateFields,
} from './catalog';
import { logicIssues } from './logic';
import { parsePolicyRules } from './policy';

const OUT = ['out'];

const node = (spec: NodeSpec) => spec;

const SCOPE_VALUES: string[] = Object.values(SCOPES);

/** The optional event filter every event trigger carries. */
const whenField: ConfigField = {
  key: 'when',
  label: 'Only when',
  kind: 'logic',
  hint: 'JSON Logic over the event (input) and entry; empty starts a run for every matching entry. The workflow’s content types already narrow it.',
};

const cronCheck = (v: unknown): string[] => {
  if (typeof v !== 'string') return ['Expected a cron expression'];
  try {
    assertValidCron(v);
    return [];
  } catch (e) {
    return [e instanceof Error ? e.message : 'Invalid cron expression'];
  }
};

const policyCheck = (v: unknown): string[] => {
  const r = parsePolicyRules(v);
  if (!r.ok) return r.issues;
  return r.rules.length ? [] : ['Add at least one rule'];
};

const objectCheck = (v: unknown): string[] =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? [] : ['Expected an object'];

/** A probability strictly between 0 and 1 (at 1, nothing would ever flag). */
const probabilityCheck = (v: unknown): string[] =>
  v === undefined || (typeof v === 'number' && v > 0 && v < 1)
    ? []
    : ['Expected a probability between 0 and 1, such as 0.5 (not a percentage)'];

/** Router guards: an object of route → JSON Logic expression. */
const guardsCheck = (v: unknown): string[] => {
  const issues = objectCheck(v);
  if (issues.length) return issues;
  return Object.entries(v as Record<string, unknown>).flatMap(([route, expr]) =>
    logicIssues(expr).map((m) => `${route}: ${m}`),
  );
};

export const NODE_SPECS = [
  // ── Triggers ────────────────────────────────────────────────────────────────
  node({
    type: 'trigger.manual',
    category: 'trigger',
    label: 'Submit for review',
    description:
      'Started by a person from the entry editor, POST …/entries/:id/workflow-runs, or the MCP server.',
    icon: 'Play',
    fields: [],
    outputs: OUT,
  }),
  node({
    type: 'trigger.entry_created',
    category: 'trigger',
    label: 'Entry created',
    description: 'Started when an entry of the workflow’s content types is created.',
    icon: 'FilePlus2',
    fields: [whenField],
    outputs: OUT,
  }),
  node({
    type: 'trigger.entry_saved',
    category: 'trigger',
    label: 'Entry saved',
    description:
      'Started when a draft is saved. The event carries the new version and the changed fields (input.changedFields).',
    icon: 'Save',
    fields: [whenField],
    outputs: OUT,
  }),
  node({
    type: 'trigger.publish_requested',
    category: 'trigger',
    label: 'Publish requested',
    description:
      'Started when someone asks to publish an entry. The run decides whether, and when, it is published.',
    icon: 'Send',
    fields: [whenField],
    outputs: OUT,
  }),
  node({
    type: 'trigger.entry_published',
    category: 'trigger',
    label: 'Entry published',
    description: 'Started after an entry is published.',
    icon: 'Globe',
    fields: [whenField],
    outputs: OUT,
  }),
  node({
    type: 'trigger.entry_unpublished',
    category: 'trigger',
    label: 'Entry unpublished',
    description: 'Started after an entry is unpublished.',
    icon: 'EyeOff',
    fields: [whenField],
    outputs: OUT,
  }),
  node({
    type: 'trigger.release_published',
    category: 'trigger',
    label: 'Release published',
    description: 'Started once for each entry in a release when the release is published.',
    icon: 'Package',
    fields: [
      whenField,
      {
        key: 'maxEntries',
        label: 'At most',
        kind: 'number',
        default: 100,
        hint: 'Runs started per release; the rest are skipped and reported',
      },
    ],
    outputs: OUT,
  }),
  node({
    type: 'trigger.schedule',
    category: 'trigger',
    label: 'Schedule',
    description:
      'Started on a cadence for every entry the query matches (freshness reviews, periodic audits).',
    icon: 'CalendarClock',
    fields: [
      {
        key: 'cron',
        label: 'Cron',
        kind: 'text',
        required: true,
        default: '0 9 * * 1',
        hint: 'Five fields, UTC',
        check: cronCheck,
      },
      {
        key: 'contentType',
        label: 'Content type',
        kind: 'contentType',
        hint: 'Empty uses the workflow’s content types',
      },
      {
        key: 'filter',
        label: 'Filter',
        kind: 'json',
        default: {},
        hint: 'An entries query filter, e.g. { "fields.section": "news" }',
        check: objectCheck,
      },
      { key: 'maxEntries', label: 'At most', kind: 'number', default: 100 },
    ],
    outputs: OUT,
  }),

  // ── Content ─────────────────────────────────────────────────────────────────
  node({
    type: 'content.validate',
    category: 'content',
    label: 'Validate entry',
    description:
      'Runs the content type’s field validation, the same checks publishing applies. Failures are in the output.',
    icon: 'ListChecks',
    fields: [],
    outputs: ['valid', 'invalid'],
  }),
  node({
    type: 'content.policy',
    category: 'content',
    label: 'Policy check',
    description:
      'Checks editorial rules: required fields, word counts, forbidden terms, image alt text, references, publishing hours.',
    icon: 'Scale',
    fields: [
      {
        key: 'rules',
        label: 'Rules',
        kind: 'json',
        required: true,
        check: policyCheck,
        default: [{ rule: 'required_fields', fields: ['title'] }, { rule: 'has_alt_text' }],
        hint: 'required_fields, min_words, max_words, forbidden_terms, has_alt_text, min_references, business_hours',
      },
      {
        key: 'locale',
        label: 'Locale',
        kind: 'text',
        hint: 'Empty checks whichever locale has a value',
      },
    ],
    outputs: ['pass', 'fail'],
  }),
  node({
    type: 'content.publish',
    category: 'content',
    label: 'Publish',
    description:
      'Publishes the entry’s current version. Unpublished again if the run later fails, unless it has been republished since.',
    icon: 'Upload',
    fields: [],
    outputs: OUT,
    rollback: true,
  }),
  node({
    type: 'content.unpublish',
    category: 'content',
    label: 'Unpublish',
    description: 'Takes the entry off delivery. Not undone if the run later fails.',
    icon: 'EyeOff',
    fields: [],
    outputs: OUT,
  }),
  node({
    type: 'content.schedule',
    category: 'content',
    label: 'Schedule',
    description:
      'Schedules the entry to publish or unpublish later. The schedule is cancelled if the run fails.',
    icon: 'CalendarClock',
    fields: [
      {
        key: 'action',
        label: 'Action',
        kind: 'select',
        options: ['publish', 'unpublish'],
        default: 'publish',
      },
      { key: 'after', label: 'After', kind: 'duration', default: '1 day' },
      {
        key: 'at',
        label: 'At (expression)',
        kind: 'logic',
        hint: 'Epoch ms or an ISO date; overrides After',
      },
    ],
    outputs: OUT,
    rollback: true,
  }),
  node({
    type: 'content.add_to_release',
    category: 'content',
    label: 'Add to release',
    description: 'Adds the entry to a release. Removed again if the run fails.',
    icon: 'PackagePlus',
    fields: [{ key: 'releaseId', label: 'Release', kind: 'release', required: true }],
    outputs: OUT,
    rollback: true,
  }),
  node({
    type: 'content.publish_release',
    category: 'content',
    label: 'Publish release',
    description: 'Publishes every entry in a release together.',
    icon: 'PackageCheck',
    fields: [
      {
        key: 'releaseId',
        label: 'Release',
        kind: 'release',
        required: true,
        default: '{{vars.releaseId}}',
      },
    ],
    outputs: OUT,
  }),
  node({
    type: 'content.set_fields',
    category: 'content',
    label: 'Set fields',
    description:
      'Writes field values (text interpolates {{paths}}). The prior values are restored if the run fails and nobody has edited the entry since.',
    icon: 'PenLine',
    fields: [
      {
        key: 'values',
        label: 'Values',
        kind: 'json',
        required: true,
        default: {},
        hint: '{ fieldApiId: value }',
        check: objectCheck,
      },
      { key: 'locale', label: 'Locale', kind: 'text', hint: 'Empty uses the default locale' },
    ],
    outputs: OUT,
    rollback: true,
  }),
  node({
    type: 'content.set_tags',
    category: 'content',
    label: 'Set tags',
    description:
      'Adds, removes or replaces the entry’s tags. The prior tags return if the run fails.',
    icon: 'Tags',
    fields: [
      { key: 'tags', label: 'Tags', kind: 'list', required: true, default: ['reviewed'] },
      {
        key: 'mode',
        label: 'Mode',
        kind: 'select',
        options: ['add', 'remove', 'replace'],
        default: 'add',
      },
    ],
    outputs: OUT,
    rollback: true,
  }),
  node({
    type: 'content.stage',
    category: 'content',
    label: 'Set stage',
    description:
      'Records the entry’s workflow stage (shown in the editor and returned by GET …/entries/:id/workflow).',
    icon: 'Flag',
    fields: [
      { key: 'stepId', label: 'Stage id', kind: 'text', required: true, default: 'in_review' },
      { key: 'name', label: 'Stage name', kind: 'text', default: 'In review' },
      {
        key: 'requiredScope',
        label: 'Move here needs',
        kind: 'select',
        options: SCOPE_VALUES,
        default: SCOPES.contentWrite,
        hint: 'The scope the legacy transition API requires to move an entry into this stage',
      },
    ],
    outputs: OUT,
  }),
  node({
    type: 'content.assign',
    category: 'content',
    label: 'Assign task',
    description: 'Creates a task on the entry for a person. Resolved if the run fails.',
    icon: 'ClipboardList',
    fields: [
      { key: 'assignee', label: 'Assignee', kind: 'text', required: true, default: 'editor' },
      { key: 'title', label: 'Title', kind: 'text', default: 'Review “{{ref}}”' },
      { key: 'due', label: 'Due in', kind: 'duration' },
    ],
    outputs: OUT,
    rollback: true,
  }),
  node({
    type: 'content.comment',
    category: 'content',
    label: 'Comment',
    description: 'Adds a comment to the entry (text interpolates {{paths}}).',
    icon: 'MessageSquare',
    fields: [
      {
        key: 'body',
        label: 'Comment',
        kind: 'textarea',
        required: true,
        default: 'Please take a look at “{{ref}}”.',
      },
    ],
    outputs: OUT,
  }),
  node({
    type: 'content.notify',
    category: 'content',
    label: 'Notify',
    description:
      'Emails people about the entry. Subject and message interpolate {{paths}}; each step sends once.',
    icon: 'Bell',
    fields: [
      {
        key: 'to',
        label: 'To',
        kind: 'list',
        required: true,
        hint: 'Email addresses ({{paths}} allowed)',
      },
      { key: 'subject', label: 'Subject', kind: 'text', default: '“{{ref}}” needs attention' },
      {
        key: 'message',
        label: 'Message',
        kind: 'textarea',
        default: '“{{ref}}” needs attention.',
      },
    ],
    outputs: OUT,
  }),
  node({
    type: 'content.webhook',
    category: 'content',
    label: 'Webhook',
    description: 'Posts a JSON payload to a URL. String values interpolate {{paths}}.',
    icon: 'Webhook',
    fields: [
      { key: 'url', label: 'URL', kind: 'text', required: true },
      {
        key: 'payload',
        label: 'Payload',
        kind: 'json',
        default: { entryId: '{{entry.id}}', title: '{{ref}}' },
        check: objectCheck,
      },
    ],
    outputs: OUT,
  }),

  // ── Control ────────────────────────────────────────────────────────────────
  node({
    type: 'control.condition',
    category: 'control',
    label: 'Condition',
    description: 'Branches on a JSON Logic expression over the run context.',
    icon: 'Split',
    fields: [
      {
        key: 'expression',
        label: 'Expression',
        kind: 'logic',
        required: true,
        default: { in: ['legal', { var: 'entry.tags' }] },
      },
    ],
    outputs: ['true', 'false'],
  }),
  node({
    type: 'control.approval',
    category: 'control',
    label: 'Approval',
    description:
      'Waits for a person holding the required scope to approve or reject. Escalates when the timeout passes.',
    icon: 'UserCheck',
    fields: [
      { key: 'title', label: 'Title', kind: 'text', default: 'Review “{{ref}}”' },
      { key: 'assignee', label: 'Assignee', kind: 'text', default: 'editor' },
      { key: 'timeout', label: 'Escalate after', kind: 'duration', default: '2 days' },
      {
        key: 'requiredScope',
        label: 'Who may decide',
        kind: 'select',
        options: SCOPE_VALUES,
        default: SCOPES.workflowApprove,
        hint: 'workflow:approve lets Approvers and up decide; content:publish keeps it to publishers',
      },
      {
        key: 'separateDuties',
        label: 'Separate duties',
        kind: 'boolean',
        // No default: unset follows the space's separation-of-duties default.
        hint: 'Whoever started the run can’t decide. Unset follows the space default',
      },
      {
        key: 'instructions',
        label: 'Instructions',
        kind: 'textarea',
        default: '',
        hint: 'Shown in the approvals inbox',
      },
    ],
    outputs: ['approved', 'rejected', 'escalated'],
    waits: true,
  }),
  node({
    type: 'control.wait_event',
    category: 'control',
    label: 'Wait for event',
    description:
      'Waits for an event: one delivered through the API or MCP, or one CommerceWorker emits (entry.saved when the author revises).',
    icon: 'Hourglass',
    fields: [
      { key: 'event', label: 'Event', kind: 'text', required: true, default: 'entry.saved' },
      { key: 'timeout', label: 'Timeout', kind: 'duration', default: '7 days' },
    ],
    outputs: ['received', 'timeout'],
    waits: true,
  }),
  node({
    type: 'control.wait',
    category: 'control',
    label: 'Wait',
    description: 'Sleeps for a duration, or until a timestamp computed from the context.',
    icon: 'Timer',
    fields: [
      { key: 'duration', label: 'Duration', kind: 'duration', default: '1 day' },
      {
        key: 'until',
        label: 'Until (expression)',
        kind: 'logic',
        hint: 'Epoch ms; overrides duration',
      },
    ],
    outputs: OUT,
  }),
  node({
    type: 'control.set',
    category: 'control',
    label: 'Set variables',
    description: 'Assigns run variables from JSON Logic expressions.',
    icon: 'Variable',
    fields: [
      {
        key: 'assign',
        label: 'Assignments',
        kind: 'json',
        default: { cycle: { '+': [{ var: 'vars.cycle' }, 1] } },
        hint: '{ name: expression }',
        check: objectCheck,
      },
    ],
    outputs: OUT,
  }),
  node({
    type: 'control.loop',
    category: 'control',
    label: 'Loop',
    description:
      'Repeats its body while the condition holds, up to a limit. Connect the end of the body back to the “next” input.',
    icon: 'IterationCw',
    fields: [
      { key: 'while', label: 'While', kind: 'logic', default: true },
      { key: 'maxIterations', label: 'Max iterations', kind: 'number', default: 12 },
    ],
    outputs: ['body', 'done'],
    loop: true,
  }),
  node({
    type: 'control.continue_as_new',
    category: 'control',
    label: 'Continue as new',
    description:
      'Ends this run and starts a fresh one on the same workflow, carrying the variables forward.',
    icon: 'RotateCw',
    fields: [],
    outputs: [],
  }),
  node({
    type: 'control.end',
    category: 'control',
    label: 'End',
    description:
      'Finishes the run. “declined” is a policy or approval no; “failed” undoes every compensable step.',
    icon: 'CircleStop',
    fields: [
      {
        key: 'outcome',
        label: 'Outcome',
        kind: 'select',
        options: ['completed', 'declined', 'cancelled', 'failed'],
        default: 'completed',
      },
      { key: 'reason', label: 'Reason', kind: 'text', default: '' },
    ],
    outputs: [],
  }),

  // ── AI ─────────────────────────────────────────────────────────────────────
  node({
    type: 'ai.classify',
    category: 'ai',
    label: 'Classify',
    description: 'Assigns one label from a list (section, audience, intent) into a variable.',
    icon: 'Shapes',
    fields: [
      {
        key: 'labels',
        label: 'Labels',
        kind: 'list',
        default: ['news', 'opinion', 'feature', 'how_to'],
      },
      { key: 'into', label: 'Store as var', kind: 'text', default: 'category' },
    ],
    outputs: OUT,
  }),
  node({
    type: 'ai.router',
    category: 'ai',
    label: 'Agent router',
    description:
      'An LLM reads the entry and context, then chooses exactly one route. Each route is an output. Without a model answer it takes the last route.',
    icon: 'Signpost',
    fields: [
      {
        key: 'instructions',
        label: 'Instructions',
        kind: 'textarea',
        default: 'Decide how this entry should be reviewed.',
      },
      {
        key: 'routes',
        label: 'Routes',
        kind: 'list',
        default: ['publish', 'needs_review', 'ask_author'],
      },
      {
        key: 'guards',
        label: 'Guards',
        kind: 'json',
        default: {},
        hint: '{ route: JSON Logic } checked in code before the model’s choice is taken: a route whose guard fails can’t be chosen',
        check: guardsCheck,
      },
    ],
    outputs: (config) => stringList(config.routes, ['publish', 'needs_review']),
  }),
  node({
    type: 'ai.summarize',
    category: 'ai',
    label: 'Summarize',
    description: 'Writes a short summary of the entry into a variable.',
    icon: 'NotebookPen',
    fields: [{ key: 'into', label: 'Store as var', kind: 'text', default: 'summary' }],
    outputs: OUT,
  }),
  node({
    type: 'ai.assess',
    category: 'ai',
    label: 'Assess',
    description:
      'A decision model reads the entry and returns a probability for every option of every question. Branches on one question.',
    icon: 'Gauge',
    fields: [
      {
        key: 'questions',
        label: 'Questions',
        kind: 'json',
        hint: 'Question id → { type: noul | choice | score, instructions, criteria }. 1 to 64.',
        check: assessQuestionsIssues,
        default: {
          stale: {
            type: 'noul',
            instructions:
              'Is this entry out of date: facts, dates, prices or links that no longer hold?',
          },
          audience: {
            type: 'choice',
            instructions: 'Who is this entry written for?',
            criteria: {
              beginner: 'New to the subject',
              practitioner: 'Works with it day to day',
              expert: 'Deep specialist knowledge assumed',
            },
          },
        },
      },
      {
        key: 'branchOn',
        label: 'Branch on',
        kind: 'text',
        hint: 'A yes/no or choice question id. Empty: one output.',
        default: 'stale',
      },
      {
        key: 'minConfidence',
        label: 'Unsure below',
        kind: 'number',
        hint: 'Confidence 0–1. Above 0 adds an “unsure” output.',
        default: 0,
      },
      {
        key: 'state',
        label: 'State',
        kind: 'select',
        options: ['entry', 'entry_and_context'],
        default: 'entry_and_context',
      },
      { key: 'into', label: 'Store as var', kind: 'text', default: 'assessment' },
    ],
    outputs: (config) => assessOutputs(config.questions, config.branchOn, config.minConfidence),
    validate: assessConfigErrors,
  }),
  node({
    type: 'ai.translate',
    category: 'ai',
    label: 'Translate',
    description: 'Translates the entry’s localized fields into another locale and saves them.',
    icon: 'Languages',
    fields: [
      {
        key: 'targetLocale',
        label: 'Into locale',
        kind: 'text',
        required: true,
        default: '{{vars.locale}}',
      },
      {
        key: 'sourceLocale',
        label: 'From locale',
        kind: 'text',
        hint: 'Empty uses the default locale',
      },
    ],
    outputs: OUT,
  }),
  node({
    type: 'ai.autofill',
    category: 'ai',
    label: 'Autofill field',
    description: 'Drafts one field’s value from the rest of the entry (an excerpt, an SEO title).',
    icon: 'TextCursorInput',
    fields: [
      { key: 'field', label: 'Field', kind: 'field', required: true },
      { key: 'locale', label: 'Locale', kind: 'text', hint: 'Empty uses the default locale' },
      {
        key: 'overwrite',
        label: 'Overwrite',
        kind: 'boolean',
        default: false,
        hint: 'Off leaves a field that already has a value alone',
      },
    ],
    outputs: OUT,
  }),
  node({
    type: 'ai.suggest_tags',
    category: 'ai',
    label: 'Suggest tags',
    description:
      'Suggests tags from the space’s taxonomy, into a variable or applied to the entry.',
    icon: 'Tag',
    fields: [
      { key: 'into', label: 'Store as var', kind: 'text', default: 'suggestedTags' },
      { key: 'apply', label: 'Apply', kind: 'boolean', default: false },
    ],
    outputs: OUT,
  }),
  node({
    type: 'ai.enrich',
    category: 'ai',
    label: 'Enrich',
    description:
      'Runs the enrich agent (SEO fields, summaries, tags). With review, its proposal waits in the approvals inbox.',
    icon: 'LayersPlus',
    fields: [
      {
        key: 'awaitReview',
        label: 'Wait for review',
        kind: 'boolean',
        default: true,
        hint: 'Off applies the proposal at once',
      },
      { key: 'timeout', label: 'Review within', kind: 'duration', default: '7 days' },
    ],
    outputs: (config) =>
      config.awaitReview === false ? ['applied'] : ['approved', 'rejected', 'timeout'],
    waits: true,
  }),
  node({
    type: 'ai.moderate',
    category: 'ai',
    label: 'Moderate',
    description:
      'Runs the moderation agent. Anything it can’t check (no model answer) goes to “flagged”, never “clean”.',
    icon: 'ShieldAlert',
    fields: [
      {
        key: 'instructions',
        label: 'House rules',
        kind: 'textarea',
        default: '',
        hint: 'Added to the moderation prompt',
      },
      {
        key: 'threshold',
        label: 'Flag at',
        kind: 'number',
        default: 0.5,
        hint: 'With a decision model: the probability (between 0 and 1) at which a category flags the entry',
        check: probabilityCheck,
      },
      { key: 'into', label: 'Store as var', kind: 'text', default: 'moderation' },
    ],
    outputs: ['clean', 'flagged'],
  }),
] as const satisfies readonly NodeSpec[];

export type WorkflowNodeType = (typeof NODE_SPECS)[number]['type'];

const BY_TYPE = new Map<string, NodeSpec>(NODE_SPECS.map((s) => [s.type, s]));

export function nodeSpec(type: string): NodeSpec | undefined {
  return BY_TYPE.get(type);
}

export function nodeOutputs(type: string, config: Record<string, unknown> = {}): string[] {
  const spec = BY_TYPE.get(type);
  return spec ? specOutputs(spec, config) : [];
}

/** Config with every missing field filled from its default. */
export function withDefaults(
  type: string,
  config: Record<string, unknown> = {},
): Record<string, unknown> {
  return specDefaults(BY_TYPE.get(type), config);
}

/** Validates one node's config against its catalog fields. Returns error messages. */
export function validateConfig(type: string, config: Record<string, unknown>): string[] {
  const spec = BY_TYPE.get(type);
  if (!spec) return [`Unknown node type “${type}”`];
  return validateFields(spec, withDefaults(type, config));
}
