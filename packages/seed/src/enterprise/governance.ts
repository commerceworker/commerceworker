import {
  addMember,
  closeWorkflowTask,
  createEnvironment,
  createRole,
  createWorkflowDraft,
  defineWorkflow,
  listEnvironmentAliases,
  listEnvironments,
  listRoles,
  listWorkflowRuns,
  listWorkflows,
  openWorkflowTask,
  publishWorkflowVersion,
  reportRun,
  setEnvironmentAlias,
  setLocaleSettings,
  setTrashRetention,
  setWorkflowSeparationDefault,
  startWorkflowRun,
  transitionEntry,
  updateMember,
} from '@commerceworker/application';
import {
  moderateThenPublishWorkflow,
  type Principal,
  quarterlyFreshnessReviewWorkflow,
  SCOPES,
  scopesForKind,
  WorkflowBuilder,
  type WorkflowGraphDefinition,
} from '@commerceworker/domain';
import type { WorkflowEngine } from '@commerceworker/ports';
import { BRAND_EMAIL, RTL_LOCALES, UNDELIVERED_LOCALES } from './brand';
import { keysOf, pickOf } from './entries';
import type { EnterpriseRun } from './run';

/**
 * How the firm runs its content: the space's locale and workflow settings, environments with
 * blue/green aliases, roles per team (regional editors, translators, legal and risk, newsroom,
 * tax, careers, people data, an outside agency, brand), the people in them, and the approval
 * workflows they work through, with real tasks waiting in the inbox.
 */

const S = SCOPES;

const ROLES: readonly Parameters<typeof createRole>[2][] = [
  {
    name: 'Regional editor',
    description:
      'Writes and previews market content; approves translations. Publishing goes through workflow.',
    scopes: [S.contentWrite, S.previewRead, S.searchRead, S.workflowApprove],
    contentGrants: ['insight', 'caseStudy', 'event', 'page', 'podcastEpisode', 'cta'].map((t) => ({
      contentTypeApiId: t,
      actions: ['read', 'write'] as const,
      deniedActions: ['delete'] as const,
    })),
  },
  {
    name: 'Translator',
    description: 'Edits localized fields only; structure, links and ownership are read-only.',
    scopes: [S.contentWrite, S.previewRead],
    contentGrants: [
      {
        contentTypeApiId: '*',
        actions: ['read', 'write'],
        deniedActions: ['delete', 'unpublish'],
        readOnlyFields: [
          'slug',
          'authors',
          'series',
          'industry',
          'services',
          'area',
          'brand',
          'tier',
          'parent',
        ],
        deniedFields: ['email', 'phone'],
      },
    ],
  },
  {
    name: 'Legal and risk reviewer',
    description: 'Signs off claims, client names, embargoes and every legal notice.',
    scopes: [S.workflowApprove, S.previewRead, S.searchRead, S.contentWrite, S.contentPublish],
    contentGrants: [
      { contentTypeApiId: 'legalPage', actions: ['read', 'write', 'publish'] },
      { contentTypeApiId: 'disclaimer', actions: ['read', 'write', 'publish'] },
      { contentTypeApiId: '*', actions: ['read'] },
    ],
  },
  {
    name: 'Brand reviewer',
    description: 'Approves imagery, sub-brand use and campaign pages.',
    scopes: [S.workflowApprove, S.previewRead, S.searchRead],
    contentGrants: [{ contentTypeApiId: '*', actions: ['read'] }],
  },
  {
    name: 'Newsroom publisher',
    description: 'Writes and publishes press releases, media contacts and notes to editors.',
    scopes: [S.contentWrite, S.contentPublish, S.previewRead, S.searchRead],
    contentGrants: [
      ...['pressRelease', 'mediaContact'].map((t) => ({
        contentTypeApiId: t,
        actions: ['read', 'write', 'publish'] as const,
      })),
      { contentTypeApiId: 'disclaimer', actions: ['read'] },
      { contentTypeApiId: 'insight', actions: ['read'] },
      { contentTypeApiId: 'person', actions: ['read'] },
    ],
  },
  {
    name: 'Tax content author',
    description: 'Writes technical bulletins; the jurisdiction is fixed once set.',
    scopes: [S.contentWrite, S.previewRead],
    contentGrants: [
      {
        contentTypeApiId: 'technicalBulletin',
        actions: ['read', 'write'],
        deniedActions: ['delete'],
      },
      { contentTypeApiId: 'disclaimer', actions: ['read'] },
    ],
  },
  {
    name: 'Careers editor',
    description: 'Owns career areas and the careers pages.',
    scopes: [S.contentWrite, S.contentPublish, S.previewRead],
    contentGrants: [
      { contentTypeApiId: 'careerArea', actions: ['read', 'write', 'publish'] },
      { contentTypeApiId: 'page', actions: ['read', 'write'] },
    ],
  },
  {
    name: 'People data steward',
    description: 'Keeps people and offices current. Email addresses are read-only.',
    scopes: [S.contentWrite, S.contentPublish, S.previewRead],
    contentGrants: [
      {
        contentTypeApiId: 'person',
        actions: ['read', 'write', 'publish'],
        readOnlyFields: ['email'],
      },
      { contentTypeApiId: 'office', actions: ['read', 'write', 'publish'] },
    ],
  },
  {
    name: 'Agency contributor',
    description:
      'An outside agency drafting insights and case studies. Cannot publish, delete or set the tier.',
    scopes: [S.contentWrite, S.previewRead],
    contentGrants: ['insight', 'caseStudy'].map((t) => ({
      contentTypeApiId: t,
      actions: ['read', 'write'] as const,
      deniedActions: ['delete', 'unpublish'] as const,
      readOnlyFields: ['slug', 'authors'],
      deniedFields: ['tier'],
    })),
  },
];

/** The people in the space and the role each holds (a custom role by name, or a preset). */
export const TEAM: readonly { email: string; name: string; role: string; disabled?: boolean }[] = [
  {
    email: BRAND_EMAIL('avery.collins'),
    name: 'Avery Collins (Digital platform lead)',
    role: 'admin',
  },
  {
    email: BRAND_EMAIL('hannah.mercer'),
    name: 'Hannah Mercer (Global editor-in-chief)',
    role: 'manager',
  },
  {
    email: BRAND_EMAIL('diego.alvarez'),
    name: 'Diego Alvarez (Americas editor)',
    role: 'Regional editor',
  },
  {
    email: BRAND_EMAIL('charlotte.brooks'),
    name: 'Charlotte Brooks (EMEIA editor)',
    role: 'Regional editor',
  },
  {
    email: BRAND_EMAIL('kenta.mori'),
    name: 'Kenta Mori (Asia-Pacific editor)',
    role: 'Regional editor',
  },
  {
    email: BRAND_EMAIL('lena.hoffmann'),
    name: 'Lena Hoffmann (German translation)',
    role: 'Translator',
  },
  {
    email: BRAND_EMAIL('camille.laurent'),
    name: 'Camille Laurent (French translation)',
    role: 'Translator',
  },
  {
    email: BRAND_EMAIL('yui.kobayashi'),
    name: 'Yui Kobayashi (Japanese translation)',
    role: 'Translator',
  },
  {
    email: BRAND_EMAIL('rania.saleh'),
    name: 'Rania Saleh (Arabic translation)',
    role: 'Translator',
  },
  {
    email: BRAND_EMAIL('mariana.costa'),
    name: 'Mariana Costa (Portuguese translation)',
    role: 'Translator',
  },
  {
    email: BRAND_EMAIL('robert.ashdown'),
    name: 'Robert Ashdown (Legal and risk)',
    role: 'Legal and risk reviewer',
  },
  {
    email: BRAND_EMAIL('ines.okonkwo'),
    name: 'Ines Okonkwo (Independence and risk)',
    role: 'Legal and risk reviewer',
  },
  { email: BRAND_EMAIL('theo.marsh'), name: 'Theo Marsh (Brand)', role: 'Brand reviewer' },
  {
    email: BRAND_EMAIL('grace.whitaker'),
    name: 'Grace Whitaker (Newsroom lead)',
    role: 'Newsroom publisher',
  },
  {
    email: BRAND_EMAIL('sam.patel'),
    name: 'Sam Patel (Press officer)',
    role: 'Newsroom publisher',
  },
  {
    email: BRAND_EMAIL('ana.ribeiro'),
    name: 'Ana Ribeiro (Tax content)',
    role: 'Tax content author',
  },
  {
    email: BRAND_EMAIL('jamie.fox'),
    name: 'Jamie Fox (Careers marketing)',
    role: 'Careers editor',
  },
  {
    email: BRAND_EMAIL('olu.adeyemi'),
    name: 'Olu Adeyemi (People data)',
    role: 'People data steward',
  },
  {
    email: 'maya@northbeam-agency.example',
    name: 'Maya Lund (Northbeam agency)',
    role: 'Agency contributor',
  },
  { email: BRAND_EMAIL('leo.hart'), name: 'Leo Hart (Analytics)', role: 'viewer' },
  { email: BRAND_EMAIL('board.office'), name: 'Board office (approvals)', role: 'approver' },
  {
    email: BRAND_EMAIL('martin.keane'),
    name: 'Martin Keane (left the firm)',
    role: 'Regional editor',
    disabled: true,
  },
];

/** A person's principal, for the use-cases that record who did what. */
export function personPrincipal(run: EnterpriseRun, email: string): Principal {
  return {
    spaceId: run.scope.spaceId,
    kind: 'user',
    scopes: Object.values(SCOPES),
    subject: email,
  };
}

export async function seedEnterpriseGovernance(run: EnterpriseRun): Promise<void> {
  const { ctx, scope, principal, locales } = run;
  const spaceId = scope.spaceId;

  // Locale behaviour: Arabic right-to-left, Italian in preparation (written, never delivered).
  const settings: Record<string, unknown> = {};
  for (const l of RTL_LOCALES) if (locales.includes(l)) settings[l] = { direction: 'rtl' };
  for (const l of UNDELIVERED_LOCALES) if (locales.includes(l)) settings[l] = { delivered: false };
  if (Object.keys(settings).length) await setLocaleSettings(ctx, principal, scope, settings);
  await setWorkflowSeparationDefault(ctx, principal, scope, true);
  await setTrashRetention(ctx, principal, scope, 30);

  // Environments: staging for model changes, uat for the market teams; aliases point at them.
  const envs = await listEnvironments(ctx, spaceId);
  for (const [id, name] of [
    ['staging', 'Staging'],
    ['uat', 'Market acceptance'],
  ] as const) {
    if (!envs.some((e) => e.id === id)) await createEnvironment(ctx, spaceId, id, name);
  }
  const aliases = await listEnvironmentAliases(ctx, spaceId);
  if (!aliases.some((a) => a.alias === 'live')) {
    await setEnvironmentAlias(ctx, spaceId, 'live', scope.environmentId);
  }
  if (!aliases.some((a) => a.alias === 'next'))
    await setEnvironmentAlias(ctx, spaceId, 'next', 'staging');

  // Roles, then people in them.
  const roles = await listRoles(ctx, spaceId);
  const roleId = new Map(roles.map((r) => [r.name, r.id]));
  for (const role of ROLES) {
    if (!roleId.has(role.name)) roleId.set(role.name, (await createRole(ctx, spaceId, role)).id);
  }
  for (const person of TEAM) {
    if (await ctx.store.members.getByEmail(spaceId, person.email)) continue;
    const member = await addMember(ctx, spaceId, {
      email: person.email,
      name: person.name,
      role: roleId.get(person.role) ?? person.role,
    });
    if (person.disabled) {
      await updateMember(ctx, spaceId, member.id, { disabled: true }, { sso: false });
    }
  }
}

// ---- Workflows ----------------------------------------------------------------------------

const DAY = 86_400_000;

function thoughtLeadershipReview(): WorkflowGraphDefinition {
  return new WorkflowBuilder()
    .n('requested', 'trigger.manual', 'Submit for review')
    .n('validate', 'content.validate', 'Validate')
    .n('policy', 'content.policy', 'House style and claims', {
      rules: [
        { rule: 'has_alt_text' },
        {
          rule: 'forbidden_terms',
          terms: ['guarantee', 'risk-free', 'best in class', 'world-leading'],
        },
      ],
    })
    .n('fix', 'content.comment', 'Ask for fixes', {
      body: 'Not published: {{nodes.validate.issues}}{{nodes.policy.failures}}',
    })
    .n('sme', 'control.approval', 'Subject-matter expert sign-off', {
      title: 'SME sign-off: “{{ref}}”',
      assignee: 'author',
      requiredScope: S.contentWrite,
      timeout: '3 days',
      instructions: 'Check every figure against its source and the methodology note.',
    })
    .n('legal_tag', 'control.condition', 'Needs legal?', {
      expression: { in: ['legal', { var: 'entry.tags' }] },
    })
    .n('legal', 'control.approval', 'Legal and risk review', {
      title: 'Legal and risk: “{{ref}}”',
      assignee: 'legal',
      requiredScope: S.workflowApprove,
      timeout: '3 days',
      separateDuties: true,
      instructions: 'Check client names, forward-looking statements and independence.',
    })
    .n('brand', 'control.approval', 'Brand review', {
      title: 'Brand review: “{{ref}}”',
      assignee: 'brand',
      requiredScope: S.workflowApprove,
      timeout: '2 days',
    })
    .n('tag', 'content.set_tags', 'Mark reviewed', { tags: ['sme-reviewed'], mode: 'add' })
    .n('publish', 'content.publish', 'Publish')
    .n('done', 'control.end', 'Published', { outcome: 'completed' })
    .n('declined', 'control.end', 'Declined', { outcome: 'declined', reason: 'Not approved' })
    .n('invalid', 'control.end', 'Needs fixes', {
      outcome: 'declined',
      reason: 'Validation or policy failed',
    })
    .e('requested', 'validate')
    .e('validate.valid', 'policy')
    .e('validate.invalid', 'fix')
    .e('policy.pass', 'sme')
    .e('policy.fail', 'fix')
    .e('fix', 'invalid')
    .e('sme.approved', 'legal_tag')
    .e('sme.rejected', 'declined')
    .e('sme.escalated', 'declined')
    .e('legal_tag.true', 'legal')
    .e('legal_tag.false', 'brand')
    .e('legal.approved', 'brand')
    .e('legal.rejected', 'declined')
    .e('legal.escalated', 'declined')
    .e('brand.approved', 'tag')
    .e('brand.rejected', 'declined')
    .e('brand.escalated', 'declined')
    .e('tag', 'publish')
    .e('publish', 'done')
    .build({
      id: 'tl-review',
      name: 'Thought leadership review',
      description:
        'SME, legal (when tagged) and brand sign-off before an insight, case study or page publishes.',
      contentTypes: ['insight', 'caseStudy', 'page'],
      gatesPublish: true,
    });
}

function clientClearance(): WorkflowGraphDefinition {
  return new WorkflowBuilder()
    .n('requested', 'trigger.manual', 'Submit for review')
    .n('named', 'control.condition', 'Client named?', {
      expression: { in: ['client-named', { var: 'entry.tags' }] },
    })
    .n('clearance', 'control.approval', 'Client clearance', {
      title: 'Client clearance: “{{ref}}”',
      assignee: 'client-partner',
      requiredScope: S.workflowApprove,
      timeout: '10 days',
      instructions: 'Attach the client’s signed consent to name them before approving.',
    })
    .n('independence', 'control.approval', 'Independence check', {
      title: 'Independence check: “{{ref}}”',
      assignee: 'legal',
      requiredScope: S.workflowApprove,
      timeout: '3 days',
      separateDuties: true,
    })
    .n('publish', 'content.publish', 'Publish')
    .n('done', 'control.end', 'Published', { outcome: 'completed' })
    .n('declined', 'control.end', 'Declined', { outcome: 'declined', reason: 'Clearance refused' })
    .e('requested', 'named')
    .e('named.true', 'clearance')
    .e('named.false', 'independence')
    .e('clearance.approved', 'independence')
    .e('clearance.rejected', 'declined')
    .e('clearance.escalated', 'declined')
    .e('independence.approved', 'publish')
    .e('independence.rejected', 'declined')
    .e('independence.escalated', 'declined')
    .e('publish', 'done')
    .build({
      id: 'client-clearance',
      name: 'Case study client clearance',
      description:
        'A named client needs signed consent; every case study gets an independence check.',
      contentTypes: ['caseStudy'],
      gatesPublish: true,
    });
}

function pressRelease(): WorkflowGraphDefinition {
  return new WorkflowBuilder()
    .n('requested', 'trigger.manual', 'Submit for review')
    .n('legal', 'control.approval', 'Legal sign-off', {
      title: 'Release sign-off: “{{ref}}”',
      assignee: 'legal',
      requiredScope: S.workflowApprove,
      timeout: '1 day',
      separateDuties: true,
    })
    .n('embargo', 'control.condition', 'Embargoed?', {
      expression: { in: ['embargoed', { var: 'entry.tags' }] },
    })
    .n('hold', 'content.notify', 'Tell the newsroom', {
      to: [BRAND_EMAIL('press')],
      subject: 'Embargoed release approved: {{ref}}',
      message:
        'Approved. It publishes with its release when the embargo lifts; do not publish by hand.',
    })
    .n('publish', 'content.publish', 'Publish')
    .n('announce', 'content.notify', 'Tell the newsroom', {
      to: [BRAND_EMAIL('press')],
      subject: 'Published: {{ref}}',
      message: 'The release is live.',
    })
    .n('held', 'control.end', 'Held for embargo', { outcome: 'completed' })
    .n('done', 'control.end', 'Published', { outcome: 'completed' })
    .n('declined', 'control.end', 'Declined', { outcome: 'declined', reason: 'Not approved' })
    .e('requested', 'legal')
    .e('legal.approved', 'embargo')
    .e('legal.rejected', 'declined')
    .e('legal.escalated', 'declined')
    .e('embargo.true', 'hold')
    .e('embargo.false', 'publish')
    .e('hold', 'held')
    .e('publish', 'announce')
    .e('announce', 'done')
    .build({
      id: 'press-release',
      name: 'Press release sign-off',
      description: 'Legal signs off every release; embargoed ones wait for their launch release.',
      contentTypes: ['pressRelease'],
      gatesPublish: true,
    });
}

function localizationRollout(locales: readonly string[]): WorkflowGraphDefinition {
  const targets = ['de-DE', 'fr-FR', 'ja-JP'].filter((l) => locales.includes(l));
  const b = new WorkflowBuilder()
    .n('published', 'trigger.entry_published', 'Master published')
    .n('global', 'control.condition', 'Global rollout?', {
      expression: { in: ['global-rollout', { var: 'entry.tags' }] },
    })
    .n('pending', 'content.set_tags', 'Mark translation pending', {
      tags: ['translation-pending', 'ai-assisted'],
      mode: 'add',
    });
  for (const [k, l] of targets.entries())
    b.n(`tr${k}`, 'ai.translate', `Draft ${l}`, { targetLocale: l });
  b.n('assign', 'content.assign', 'Assign translators', {
    assignee: 'translator',
    title: 'Review the machine translation',
    due: '3 days',
  })
    .n('market', 'control.approval', 'Market sign-off', {
      title: 'Market sign-off: “{{ref}}”',
      assignee: 'regional-editor',
      requiredScope: S.workflowApprove,
      timeout: '5 days',
    })
    .n('clear', 'content.set_tags', 'Clear translation pending', {
      tags: ['translation-pending'],
      mode: 'remove',
    })
    .n('done', 'control.end', 'Rolled out', { outcome: 'completed' })
    .n('skip', 'control.end', 'Local only', { outcome: 'completed' })
    .n('declined', 'control.end', 'Held back', { outcome: 'declined' })
    .e('published', 'global')
    .e('global.true', 'pending')
    .e('global.false', 'skip');
  let prev = 'pending';
  for (const k of targets.keys()) {
    b.e(prev, `tr${k}`);
    prev = `tr${k}`;
  }
  return b
    .e(prev, 'assign')
    .e('assign', 'market')
    .e('market.approved', 'clear')
    .e('market.rejected', 'declined')
    .e('market.escalated', 'declined')
    .e('clear', 'done')
    .build({
      id: 'localization',
      name: 'Localization rollout',
      description:
        'When a global master publishes, draft translations, assign translators and get market sign-off.',
      contentTypes: ['insight', 'pressRelease', 'service'],
    });
}

function legalNoticeReview(): WorkflowGraphDefinition {
  return new WorkflowBuilder()
    .n('start', 'trigger.manual', 'Start review')
    .n('legal', 'control.approval', 'Legal review', {
      title: 'Annual review: “{{ref}}”',
      assignee: 'legal',
      requiredScope: S.workflowApprove,
      timeout: '14 days',
      separateDuties: true,
    })
    .n('publish', 'content.publish', 'Publish')
    .n('done', 'control.end', 'Reviewed', { outcome: 'completed' })
    .n('declined', 'control.end', 'Changes needed', { outcome: 'declined' })
    .e('start', 'legal')
    .e('legal.approved', 'publish')
    .e('legal.rejected', 'declined')
    .e('legal.escalated', 'declined')
    .e('publish', 'done')
    .build({
      id: 'legal-review',
      name: 'Legal notice annual review',
      description: 'Started by hand for each notice when its review date comes round.',
      contentTypes: ['legalPage'],
    });
}

const withMeta = (
  def: WorkflowGraphDefinition,
  name: string,
  description: string,
  contentTypes: string[],
): WorkflowGraphDefinition => ({ ...def, name, description, contentTypes });

/** A WorkflowEngine that starts nothing: runs are placed at a step and their tasks opened here. */
const PARKED: WorkflowEngine = {
  start: async () => undefined,
  sendEvent: async () => undefined,
  cancel: async () => undefined,
} as unknown as WorkflowEngine;

export async function seedEnterpriseWorkflows(run: EnterpriseRun): Promise<void> {
  const { ctx, scope } = run;
  const existing = await listWorkflows(ctx, scope);
  const ids = new Map(existing.map((w) => [w.name, w.id]));
  const defs = [
    thoughtLeadershipReview(),
    clientClearance(),
    pressRelease(),
    localizationRollout(run.locales),
    legalNoticeReview(),
    withMeta(
      quarterlyFreshnessReviewWorkflow(),
      'Bulletin freshness review',
      'Every quarter, bulletins past their review date go back to their author.',
      ['technicalBulletin'],
    ),
    withMeta(
      moderateThenPublishWorkflow(),
      'Agency submission moderation',
      'Agency drafts are moderated before an editor sees them.',
      ['insight'],
    ),
  ];
  for (const def of defs) {
    if (ids.has(def.name)) continue;
    const { workflow } = await createWorkflowDraft(ctx, scope, {
      name: def.name,
      description: def.description,
      contentTypes: def.contentTypes,
      ...(def.gatesPublish ? { gatesPublish: true } : {}),
      graph: def.graph,
    });
    await publishWorkflowVersion(ctx, scope, workflow.id, {
      publishedBy: BRAND_EMAIL('avery.collins'),
    });
    ids.set(def.name, workflow.id);
  }

  // A legacy step board for the newsroom desk: entries placed on its columns.
  if (!ids.has('Newsroom desk')) {
    const desk = await defineWorkflow(ctx, scope, {
      name: 'Newsroom desk',
      steps: [
        { id: 'pitched', name: 'Pitched', requiredScope: S.contentWrite },
        { id: 'drafting', name: 'Drafting', requiredScope: S.contentWrite },
        { id: 'legal', name: 'With legal', requiredScope: S.contentWrite },
        { id: 'ready', name: 'Ready to go', requiredScope: S.contentPublish },
      ],
    });
    const releases = [...(await keysOf(run, 'pressRelease')).values()].slice(0, 8);
    for (const [n, entryId] of releases.entries()) {
      await transitionEntry(
        ctx,
        scope,
        {
          entryId,
          workflowId: desk.id,
          toStepId: pickOf(['pitched', 'drafting', 'legal', 'ready'], n),
        },
        scopesForKind('cma'),
      );
    }
  }

  await seedApprovals(run, ids);
}

/**
 * Runs parked at their approval steps, so the approvals inbox, each entry's workflow panel and the
 * run timeline have real work in them: some waiting on a decision, some already decided.
 */
async function seedApprovals(run: EnterpriseRun, workflows: Map<string, string>): Promise<void> {
  const { ctx, scope } = run;
  const now = ctx.clock.now().getTime();
  const insights = await keysOf(run, 'insight');
  const cases = await keysOf(run, 'caseStudy');
  const releases = await keysOf(run, 'pressRelease');
  const legal = await keysOf(run, 'legalPage');

  const queue: {
    workflow: string;
    entry: string | undefined;
    at: string;
    by: string;
    title: string;
    assignee: string;
    decided?: {
      outcome: 'approved' | 'rejected';
      by: string;
      note: string;
      next?: { at: string; title: string; assignee: string };
    };
  }[] = [
    {
      workflow: 'Thought leadership review',
      entry: insights.get('ceo-outlook-2027'),
      at: 'legal',
      by: BRAND_EMAIL('hannah.mercer'),
      title: 'Legal and risk: “CEO Outlook 2027”',
      assignee: 'legal',
      decided: undefined,
    },
    {
      workflow: 'Thought leadership review',
      entry: insights.get('measuring-ai-value'),
      at: 'sme',
      by: BRAND_EMAIL('diego.alvarez'),
      title: 'SME sign-off: “Measuring the value of AI, honestly”',
      assignee: 'author',
    },
    {
      workflow: 'Thought leadership review',
      entry: [...insights.entries()].find(
        ([k]) => k.startsWith('the-ai-agents') || k.includes('ai-agents'),
      )?.[1],
      at: 'sme',
      by: 'maya@northbeam-agency.example',
      title: 'SME sign-off: agency draft',
      assignee: 'author',
      decided: {
        outcome: 'approved',
        by: BRAND_EMAIL('hannah.mercer'),
        note: 'Figures check out against the Institute data.',
        next: { at: 'brand', title: 'Brand review: agency draft', assignee: 'brand' },
      },
    },
    {
      workflow: 'Case study client clearance',
      entry: cases.get('manufacturer-internal-audit-analytics'),
      at: 'independence',
      by: BRAND_EMAIL('charlotte.brooks'),
      title: 'Independence check: “Continuous auditing at an industrial group”',
      assignee: 'legal',
    },
    {
      workflow: 'Case study client clearance',
      entry: cases.get('bank-financial-crime-transformation'),
      at: 'clearance',
      by: BRAND_EMAIL('charlotte.brooks'),
      title: 'Client clearance: “Fewer false alarms, more real cases”',
      assignee: 'client-partner',
      decided: {
        outcome: 'rejected',
        by: BRAND_EMAIL('ines.okonkwo'),
        note: 'Consent letter covers the 2025 figures only. Ask the client to re-sign.',
      },
    },
    {
      workflow: 'Press release sign-off',
      entry: releases.get('ceo-outlook-2027-launch'),
      at: 'legal',
      by: BRAND_EMAIL('grace.whitaker'),
      title: 'Release sign-off: “CEO Outlook 2027 launch”',
      assignee: 'legal',
    },
    {
      workflow: 'Press release sign-off',
      entry: releases.get('q4-tax-update-embargo'),
      at: 'legal',
      by: BRAND_EMAIL('sam.patel'),
      title: 'Release sign-off: “Year-end policy briefing”',
      assignee: 'legal',
    },
    {
      workflow: 'Legal notice annual review',
      entry: legal.get('privacy'),
      at: 'legal',
      by: BRAND_EMAIL('avery.collins'),
      title: 'Annual review: “Privacy statement”',
      assignee: 'legal',
    },
    {
      workflow: 'Legal notice annual review',
      entry: legal.get('cookies'),
      at: 'legal',
      by: BRAND_EMAIL('avery.collins'),
      title: 'Annual review: “Cookie policy”',
      assignee: 'legal',
      decided: {
        outcome: 'approved',
        by: BRAND_EMAIL('robert.ashdown'),
        note: 'No changes needed this year.',
      },
    },
  ];

  for (const [n, item] of queue.entries()) {
    const workflowId = workflows.get(item.workflow);
    if (!workflowId || !item.entry) continue;
    if ((await listWorkflowRuns(ctx, scope, { entryId: item.entry, workflowId })).length) continue;
    const runRow = await startWorkflowRun(ctx, PARKED, personPrincipal(run, item.by), scope, {
      entryId: item.entry,
      workflowId,
      startAt: item.at,
    });
    const since = now - (n + 1) * DAY * 0.6;
    const open = async (nodeId: string, title: string, assignee: string, at: number) =>
      openWorkflowTask(ctx, scope, runRow.id, {
        nodeId,
        eventType: `approval:${nodeId}`,
        kind: 'approval',
        title,
        assignee,
        requiredScope: S.workflowApprove,
        deadline: at + 3 * DAY,
        since: at,
      });
    await open(item.at, item.title, item.assignee, since);
    await reportRun(ctx, scope, runRow.id, { status: 'waiting' });
    if (item.decided) {
      await closeWorkflowTask(ctx, scope, runRow.id, `approval:${item.at}`, item.decided.outcome, {
        by: item.decided.by,
        note: item.decided.note,
      });
      if (item.decided.next) {
        await open(
          item.decided.next.at,
          item.decided.next.title,
          item.decided.next.assignee,
          since + DAY / 2,
        );
      } else {
        await reportRun(ctx, scope, runRow.id, {
          status: item.decided.outcome === 'approved' ? 'completed' : 'declined',
          reason: item.decided.note,
        });
      }
    }
  }
}
