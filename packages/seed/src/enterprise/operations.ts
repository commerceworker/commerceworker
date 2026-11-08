import {
  addComment,
  addEntryToRelease,
  createAgentReview,
  createAgentSchedule,
  createAIAction,
  createAppExtension,
  createFunction,
  createMenu,
  createRelease,
  createSavedView,
  createTask,
  createWebhook,
  importRedirects,
  listAgentReviews,
  listAgentSchedules,
  listAIActions,
  listAppExtensions,
  listAuditLog,
  listComments,
  listFunctions,
  listMenus,
  listReleases,
  listSavedViews,
  listScheduledActions,
  listWebhooks,
  resolveTask,
  scheduleAction,
} from '@commerceworker/application';
import { BRAND, BRAND_EMAIL, loc } from './brand';
import { dayOffset, keysOf, pickOf } from './entries';
import { TEAM } from './governance';
import { INDUSTRIES, SERVICES } from './offerings';
import type { EnterpriseRun } from './run';

/**
 * The work around the content: comment threads and tasks between the people of the team, agent
 * proposals waiting for review and agent schedules, launch releases with scheduled publishes and
 * an embargo, integrations (inactive webhooks and functions on the brand's reserved domain, admin
 * extensions, AI actions), menus per market, legacy redirects, shared saved views, and a month of
 * audit history.
 */

const who = (local: string) => BRAND_EMAIL(local);

export async function seedEnterpriseCollaboration(run: EnterpriseRun): Promise<void> {
  const { ctx, scope, space } = run;
  const insights = await keysOf(run, 'insight');
  const cases = await keysOf(run, 'caseStudy');
  const releases = await keysOf(run, 'pressRelease');
  const bulletins = await keysOf(run, 'technicalBulletin');

  const threads: {
    entry: string | undefined;
    messages: [string, string][];
    tasks?: [string, string?, boolean?][];
  }[] = [
    {
      entry: insights.get('ceo-outlook-2027'),
      messages: [
        [
          who('hannah.mercer'),
          'Can we lead with the scenario finding? The growth number is what everyone else will lead with.',
        ],
        [who('daniel.park'), 'Agreed. I’ve moved it up and tightened the standfirst.'],
        [
          who('robert.ashdown'),
          'The 67% needs the base size next to it on first mention. Otherwise fine from legal.',
        ],
        [
          who('lena.hoffmann'),
          'German version is ready for review once the English is locked. Is the title final?',
        ],
      ],
      tasks: [
        ['Add base size (n=1,200) next to the headline figure', who('daniel.park')],
        ['Confirm the embargo time with the newsroom', who('grace.whitaker')],
        ['Translate In brief into Japanese', who('yui.kobayashi')],
        ['Check chart alt text', who('theo.marsh'), true],
      ],
    },
    {
      entry: insights.get('measuring-ai-value'),
      messages: [
        [
          who('diego.alvarez'),
          'This was drafted with the assistant; the second chapter needs a real client example.',
        ],
        [who('hannah.mercer'), 'Use the insurer case study, it is cleared.'],
      ],
      tasks: [['Swap in the insurer example', who('diego.alvarez')]],
    },
    {
      entry: cases.get('bank-financial-crime-transformation'),
      messages: [
        [
          who('ines.okonkwo'),
          'Consent covers the 2025 figures only. We can’t publish the updated numbers yet.',
        ],
        [
          who('charlotte.brooks'),
          'I’ve asked the engagement partner to get a fresh letter signed.',
        ],
      ],
      tasks: [['Get the client to re-sign the consent letter', who('charlotte.brooks')]],
    },
    {
      entry: releases.get('ceo-outlook-2027-launch'),
      messages: [
        [
          who('grace.whitaker'),
          'Embargo lifts at 06:00 London. Releases are scheduled to publish together.',
        ],
        [who('sam.patel'), 'Japanese and German versions are queued with the same embargo.'],
      ],
      tasks: [
        ['Brief the three wire services under embargo', who('sam.patel')],
        ['Prepare the spokesperson Q&A', who('grace.whitaker'), true],
      ],
    },
    {
      entry: releases.get('global-revenues-fy2026'),
      messages: [
        [
          who('hannah.mercer'),
          'Corrected the regional split in paragraph three after the CFO’s review.',
        ],
      ],
    },
    {
      entry: [...bulletins.values()][4],
      messages: [
        [who('ana.ribeiro'), 'Guidance was updated this week; the effective date moved.'],
        [who('lena.hoffmann'), 'I’ll update the German title once you confirm the new date.'],
      ],
      tasks: [['Update the effective date and the summary', who('ana.ribeiro')]],
    },
  ];

  for (const t of threads) {
    if (!t.entry) continue;
    if ((await listComments(ctx, scope, t.entry)).length) continue;
    const [first, ...replies] = t.messages;
    if (!first) continue;
    const root = await addComment(ctx, scope, {
      entryId: t.entry,
      author: first[0],
      body: first[1],
    });
    for (const [author, body] of replies) {
      await addComment(ctx, scope, { entryId: t.entry, author, body, parentId: root.id });
    }
    for (const [body, assignee, done] of t.tasks ?? []) {
      const task = await createTask(ctx, scope, {
        entryId: t.entry,
        body,
        ...(assignee ? { assignee } : {}),
      });
      if (done) await resolveTask(ctx, scope, task.id);
    }
  }

  // Agent proposals waiting for a person, and the schedules that make more.
  if ((await listAgentReviews(ctx, scope, {})).length === 0) {
    const proposals: [string, string, Record<string, string>, string][] = [
      [
        'enrich',
        'what-boards-should-ask-about-ai',
        {
          standfirst:
            'Oversight starts with three things: which models you run, who owns each one and what it may decide on its own.',
        },
        'Tightened the standfirst and named the three things.',
      ],
      [
        'enrich',
        'the-cost-of-redundancy',
        {
          standfirst:
            'Dual sourcing adds 4–7% to the cost of goods; the companies paying it are winning back share.',
        },
        'Shorter standfirst with the figure first.',
      ],
      [
        'moderate',
        'ai-risk-appetite',
        {
          standfirst:
            'A risk appetite that only says “low” is not a decision; here is how to write one the business can use.',
        },
        'Softened an absolute claim in the standfirst.',
      ],
      [
        'repurpose',
        'cyber-resilience-index-2026',
        {
          standfirst:
            'Incidents are contained in nine days now. Recovery still takes a month, and that is where boards should look.',
        },
        'Proposed a social-length version of the standfirst.',
      ],
    ];
    for (const [workflow, slug, fields, note] of proposals) {
      const entryId = insights.get(slug);
      if (!entryId) continue;
      await createAgentReview(ctx, scope, {
        workflow: workflow as 'enrich',
        entryId,
        proposed: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, loc(v, space)])),
        notes: [note, 'Proposed by an agent: approve to apply it as a new draft.'],
      });
    }
  }
  if ((await listAgentSchedules(ctx, scope)).length === 0) {
    await createAgentSchedule(ctx, scope, {
      workflow: 'enrich',
      cron: '0 6 * * 1-5',
      contentTypeApiId: 'insight',
      enabled: true,
    });
    await createAgentSchedule(ctx, scope, {
      workflow: 'moderate',
      cron: '*/30 * * * *',
      contentTypeApiId: 'insight',
      enabled: false,
      autoApply: false,
    });
    await createAgentSchedule(ctx, scope, {
      workflow: 'curate',
      cron: '0 7 * * 1',
      contentTypeApiId: 'page',
      enabled: true,
    });
    await createAgentSchedule(ctx, scope, {
      workflow: 'repurpose',
      cron: '0 8 * * 2',
      contentTypeApiId: 'pressRelease',
      enabled: false,
    });
  }
}

export async function seedEnterprisePublishing(run: EnterpriseRun): Promise<void> {
  const { ctx, scope } = run;
  const now = ctx.clock.now();
  const insights = await keysOf(run, 'insight');
  const releases = await keysOf(run, 'pressRelease');
  const pages = await keysOf(run, 'page');
  const events = await keysOf(run, 'event');
  const bulletins = await keysOf(run, 'technicalBulletin');
  const careers = await keysOf(run, 'careerArea');

  const existing = await listReleases(ctx, scope);
  const plan: {
    title: string;
    description: string;
    members: (string | undefined)[];
    publishInDays?: number;
  }[] = [
    {
      title: 'CEO Outlook 2027 launch',
      description:
        'The report, its press release, the campaign page and the launch webcast, published together once legal and brand approve and the embargo lifts.',
      members: [
        insights.get('ceo-outlook-2027'),
        releases.get('ceo-outlook-2027-launch'),
        pages.get('ceo-outlook'),
        events.get('ceo-outlook-2027-launch-webcast'),
      ],
    },
    {
      title: 'Year-end tax briefing',
      description: 'The year-end release, waiting on legal sign-off before it can be scheduled.',
      members: [releases.get('q4-tax-update-embargo')],
    },
    {
      title: 'Year-end tax bulletins',
      description: 'The bulletins that go live with the year-end briefing.',
      members: [[...bulletins.values()][1], [...bulletins.values()][2]],
      publishInDays: 21,
    },
    {
      title: 'AI in the boardroom: final paper',
      description: 'The fourth paper in the series and its refreshed hub.',
      members: [insights.get('measuring-ai-value'), pages.get('ai')],
    },
    {
      title: 'Graduate campaign, spring intake',
      description: 'Careers pages for the spring graduate campaign.',
      members: [careers.get('graduates'), careers.get('life-at-aldermoor')],
      publishInDays: 30,
    },
  ];
  const releaseIds = new Map<string, string>();
  for (const r of plan) {
    const found = existing.find((x) => x.title === r.title);
    if (found) {
      releaseIds.set(r.title, found.id);
      continue;
    }
    const release = await createRelease(ctx, scope, { title: r.title, description: r.description });
    for (const entityId of r.members) {
      if (entityId) await addEntryToRelease(ctx, scope, release.id, { entityId });
    }
    releaseIds.set(r.title, release.id);
  }

  if ((await listScheduledActions(ctx, scope)).length === 0) {
    for (const r of plan) {
      const id = releaseIds.get(r.title);
      if (id && r.publishInDays) {
        await scheduleAction(ctx, scope, {
          action: 'publish',
          entityType: 'Release',
          entityId: id,
          scheduledFor: dayOffset(now, r.publishInDays, 6),
        });
      }
    }
    const oldBulletin = [...bulletins.values()].at(-1);
    const pastWebcast = events.get('board-matters-climate');
    if (oldBulletin)
      await scheduleAction(ctx, scope, {
        action: 'unpublish',
        entityType: 'Entry',
        entityId: oldBulletin,
        scheduledFor: dayOffset(now, 14),
      });
    if (pastWebcast)
      await scheduleAction(ctx, scope, {
        action: 'unpublish',
        entityType: 'Entry',
        entityId: pastWebcast,
        scheduledFor: dayOffset(now, 30),
      });
    // A new partner's profile, published once the photo is in. (Gated types publish through runs.)
    const article = (await keysOf(run, 'person')).get('ethan-cole');
    if (article)
      await scheduleAction(ctx, scope, {
        action: 'publish',
        entityType: 'Entry',
        entityId: article,
        scheduledFor: dayOffset(now, 2, 7),
      });
  }
}

export async function seedEnterpriseIntegrations(run: EnterpriseRun): Promise<void> {
  const { ctx, scope } = run;
  // Every endpoint is on the brand's reserved domain and starts inactive: nothing is ever sent.
  if ((await listWebhooks(ctx, scope)).length === 0) {
    const hooks: [string, string[], Record<string, string>?][] = [
      ['/search/reindex', ['entry.published', 'entry.unpublished', 'release.published']],
      ['/tms/source-changed', ['entry.published'], { 'x-tms-project': 'aldermoor-web' }],
      ['/newsroom/wire', ['release.published'], { 'x-team': 'newsroom' }],
      ['/warehouse/firehose', ['*']],
    ];
    for (const [path, topics, headers] of hooks) {
      await createWebhook(ctx, scope, {
        url: `${BRAND.hooks}${path}`,
        topics: topics as never,
        secret: ctx.ids.newId(),
        active: false,
        ...(headers ? { headers } : {}),
      });
    }
  }
  if ((await listFunctions(ctx, scope)).length === 0) {
    await createFunction(ctx, scope, {
      name: 'Warm market caches',
      eventPattern: 'release.published',
      url: `${BRAND.hooks}/functions/warm-cache`,
      active: false,
    });
    await createFunction(ctx, scope, {
      name: 'Sync people to the directory',
      eventPattern: 'entry.*',
      url: `${BRAND.hooks}/functions/people-directory`,
      active: false,
    });
    await createFunction(ctx, scope, {
      name: 'Expire bulletins',
      eventPattern: 'entry.published',
      url: `${BRAND.hooks}/functions/bulletin-expiry`,
      active: false,
    });
  }
  if ((await listAppExtensions(ctx, scope)).length === 0) {
    await createAppExtension(ctx, scope, {
      name: 'Translation memory',
      target: 'sidebar',
      entryUrl: `${BRAND.apps}/tms`,
      active: false,
    });
    await createAppExtension(ctx, scope, {
      name: 'Brand voice checker',
      target: 'sidebar',
      entryUrl: `${BRAND.apps}/brand-voice`,
      active: false,
    });
    await createAppExtension(ctx, scope, {
      name: 'Chart builder',
      target: 'field-editor',
      entryUrl: `${BRAND.apps}/charts`,
      fieldTypes: ['JSON'],
      active: false,
    });
  }
  if ((await listAIActions(ctx, scope)).length === 0) {
    await createAIAction(ctx, scope, {
      name: 'Write the In brief',
      description: 'Three scannable points from the body.',
      promptTemplate:
        'Write exactly three short "In brief" points, under 15 words each, from this article:\n\n{{body}}',
      targetField: 'inBrief',
      tier: 'balanced',
    });
    await createAIAction(ctx, scope, {
      name: 'Standfirst',
      description: 'One-sentence deck under the headline.',
      promptTemplate:
        'Write a one-sentence standfirst (under 30 words) for "{{headline}}":\n\n{{body}}',
      targetField: 'standfirst',
      tier: 'fast',
    });
    await createAIAction(ctx, scope, {
      name: 'Localize for a market',
      description: 'Adapt, not just translate: spelling, examples and regulation.',
      promptTemplate:
        'Adapt this for readers in {{market}}: local spelling, examples and regulators. Keep every figure.\n\n{{body}}',
      tier: 'flagship',
    });
    await createAIAction(ctx, scope, {
      name: 'Plain-language rewrite',
      description: 'Rewrite at a lower reading age without losing precision.',
      promptTemplate: 'Rewrite in plain language for a general business reader:\n\n{{body}}',
      tier: 'balanced',
    });
    await createAIAction(ctx, scope, {
      name: 'Press release highlights',
      description: 'Three highlight bullets for a release.',
      promptTemplate: 'Write three highlight bullets for this press release:\n\n{{body}}',
      targetField: 'highlights',
      tier: 'fast',
    });
  }
}

export async function seedEnterpriseNavigation(run: EnterpriseRun): Promise<void> {
  const { ctx, scope, principal } = run;
  const services = await keysOf(run, 'service');
  const industries = await keysOf(run, 'industry');
  const pages = await keysOf(run, 'page');
  const legal = await keysOf(run, 'legalPage');
  const careers = await keysOf(run, 'careerArea');
  const e = (id: string | undefined, label: string, children?: unknown[]) =>
    id
      ? [
          {
            label,
            link: { type: 'entry' as const, entryId: id },
            ...(children?.length ? { children } : {}),
          },
        ]
      : [];

  const lines = SERVICES.filter((s) => s.level === 'line');
  const groups = INDUSTRIES.filter((i) => i.level === 'group');
  const labels = (l: string) => ({
    services: { 'de-DE': 'Leistungen', 'ja-JP': 'サービス' }[l] ?? 'Services',
    industries: { 'de-DE': 'Branchen', 'ja-JP': 'インダストリー' }[l] ?? 'Industries',
    insights: { 'de-DE': 'Insights', 'ja-JP': 'インサイト' }[l] ?? 'Insights',
    about: { 'de-DE': 'Über uns', 'ja-JP': '私たちについて' }[l] ?? 'About us',
    careers: { 'de-DE': 'Karriere', 'ja-JP': '採用情報' }[l] ?? 'Careers',
  });
  const main = (l: string) => {
    const t = labels(l);
    const name = (s: { name: Record<string, string | undefined> & { en: string } }) =>
      s.name[l] ?? s.name.en;
    return [
      {
        label: t.services,
        link: { type: 'url' as const, url: `/${l}/services` },
        children: lines.flatMap((s) =>
          e(
            services.get(s.slug),
            name(s as never),
            SERVICES.filter((x) => x.parent === s.slug && x.level === 'sub-service').flatMap((x) =>
              e(services.get(x.slug), name(x as never)),
            ),
          ),
        ),
      },
      {
        label: t.industries,
        link: { type: 'url' as const, url: `/${l}/industries` },
        children: groups.flatMap((g) => e(industries.get(g.slug), name(g as never))),
      },
      {
        label: t.insights,
        link: { type: 'url' as const, url: `/${l}/insights` },
        children: [
          ...e(pages.get('ai'), 'AI'),
          ...e(pages.get('sustainability-hub'), 'Sustainability'),
          ...e(pages.get('geostrategy'), 'Geostrategy'),
          ...e(pages.get('ceo-outlook'), 'CEO Outlook 2027'),
          ...e(pages.get('events'), 'Events'),
        ],
      },
      {
        label: t.about,
        link: { type: 'url' as const, url: `/${l}/about-us` },
        children: [
          ...e(pages.get('about-us'), t.about),
          ...e(pages.get('impact-report-2026'), 'Impact Report 2026'),
          ...e(pages.get('newsroom'), 'Newsroom'),
          ...e(pages.get('contact'), 'Contact'),
        ],
      },
      {
        label: t.careers,
        link: { type: 'url' as const, url: `/${l}/careers` },
        children: [...careers.entries()].slice(0, 6).flatMap(([slug, id]) =>
          e(
            id,
            slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()),
          ),
        ),
      },
    ];
  };
  const footer = (extra: string[]) => [
    ...e(legal.get('privacy'), 'Privacy'),
    ...e(legal.get('cookies'), 'Cookies'),
    ...e(legal.get('terms'), 'Terms of use'),
    ...e(legal.get('accessibility'), 'Accessibility'),
    ...extra.flatMap((slug) =>
      e(
        legal.get(slug),
        slug === 'us-state-privacy'
          ? 'Do not sell or share my personal information'
          : slug === 'impressum'
            ? 'Impressum'
            : slug === 'member-firms-japan'
              ? 'メンバーファーム'
              : slug === 'whistleblowing'
                ? '内部通報窓口'
                : slug,
      ),
    ),
    {
      label: 'LinkedIn',
      link: { type: 'url' as const, url: 'https://www.linkedin.example/company/aldermoor' },
      target: '_blank' as const,
      attrs: { rel: 'noopener' },
    },
  ];

  const menus = await listMenus(ctx, scope);
  const want = [
    { handle: 'main-en', name: 'Main navigation (English)', items: main('en-US') },
    { handle: 'main-de', name: 'Hauptnavigation (Deutsch)', items: main('de-DE') },
    { handle: 'main-ja', name: 'メインナビゲーション（日本語）', items: main('ja-JP') },
    { handle: 'footer-us', name: 'Footer: United States', items: footer(['us-state-privacy']) },
    {
      handle: 'footer-de',
      name: 'Footer: Germany',
      items: footer(['impressum', 'transparency-report']),
    },
    {
      handle: 'footer-jp',
      name: 'Footer: Japan',
      items: footer(['member-firms-japan', 'whistleblowing']),
    },
    { handle: 'footer-global', name: 'Footer: global', items: footer(['modern-slavery']) },
  ];
  for (const m of want) {
    if (menus.some((x) => x.handle === m.handle)) continue;
    await createMenu(ctx, scope, { handle: m.handle, name: m.name, items: m.items as never });
  }

  // The old site's paths, so links in the wild keep working.
  await importRedirects(ctx, scope, {
    format: 'json',
    data: [
      { source: '/en-US/about', destination: '/en-US/about-us', status: 301, note: 'Old site map' },
      {
        source: '/en-US/services/advisory',
        destination: '/en-US/services/consulting',
        status: 301,
        note: 'Service line renamed',
      },
      {
        source: '/en-US/services/transactions',
        destination: '/en-US/services/strategy-and-transactions',
        status: 301,
      },
      {
        source: '/en-US/insights/ceo-survey-2026',
        destination: '/en-US/insights/ceo-outlook-2027',
        status: 302,
        note: 'Points at the latest edition',
      },
      { source: '/en-US/news/press', destination: '/en-US/newsroom', status: 301 },
      { source: '/en-US/jobs', destination: '/en-US/careers', status: 301 },
      { source: '/de-DE/karriere', destination: '/de-DE/careers', status: 301, locale: 'de-DE' },
      {
        source: '/en-US/tax-alerts/:slug',
        destination: '/en-US/technical/:slug',
        status: 301,
        note: 'Bulletins moved under /technical',
      },
      {
        source: '/en-US/campaign/impact',
        destination: '/en-US/impact-report-2026',
        status: 307,
        enabled: false,
        note: 'Paused while the report is refreshed',
      },
    ],
  });

  const views = await listSavedViews(ctx, scope, principal, {});
  const shared: Parameters<typeof createSavedView>[3][] = [
    {
      name: 'Embargoed press releases',
      contentTypeApiId: 'pressRelease',
      visibility: 'shared',
      query: {
        filters: [{ field: 'embargoed', op: 'eq', value: true }],
        order: [{ field: 'releaseDate', direction: 'asc' }],
      },
      columns: ['headline', 'releaseDate', 'embargoUntil', 'sys.status'],
    },
    {
      name: 'Tier 1 research',
      contentTypeApiId: 'insight',
      visibility: 'shared',
      query: {
        filters: [{ field: 'tier', op: 'eq', value: 'tier-1' }],
        order: [{ field: 'displayDate', direction: 'desc' }],
      },
      columns: ['headline', 'format', 'edition', 'sys.status', 'sys.updatedAt'],
    },
    {
      name: 'Vantage content',
      contentTypeApiId: 'insight',
      visibility: 'shared',
      query: { filters: [{ field: 'brand', op: 'eq', value: 'vantage' }] },
      columns: ['headline', 'area', 'sys.status'],
    },
    {
      name: 'Upcoming CPE webcasts',
      contentTypeApiId: 'event',
      visibility: 'shared',
      query: {
        filters: [{ field: 'cpeEligible', op: 'eq', value: true }],
        order: [{ field: 'startsAt', direction: 'asc' }],
      },
      columns: ['title', 'startsAt', 'cpeCredits', 'fieldOfStudy'],
    },
    {
      name: 'Bulletins by expiry',
      contentTypeApiId: 'technicalBulletin',
      visibility: 'shared',
      query: { order: [{ field: 'expiresOn', direction: 'asc' }] },
      columns: ['title', 'jurisdiction', 'expiresOn', 'sys.status'],
    },
    {
      name: 'People in Japan',
      contentTypeApiId: 'person',
      visibility: 'shared',
      query: { filters: [{ field: 'homeMarket', op: 'eq', value: 'ja-JP' }] },
      columns: ['displayName', 'jobTitle', 'office'],
    },
    {
      name: 'Named-client case studies',
      contentTypeApiId: 'caseStudy',
      visibility: 'shared',
      query: { filters: [{ field: 'clientNamed', op: 'eq', value: true }] },
      columns: ['title', 'clientName', 'sys.status'],
    },
  ];
  for (const v of shared) {
    if (views.some((x) => x.name === v.name)) continue;
    await createSavedView(ctx, scope, principal, v);
  }
}

/** A month of backdated audit history by the team's own people, against real entries. */
export async function seedEnterpriseHistory(run: EnterpriseRun): Promise<void> {
  const { ctx, scope } = run;
  if ((await listAuditLog(ctx, scope.spaceId, { limit: 1 })).items.length > 0) return;
  const now = ctx.clock.now();
  const targets = [
    ...[...(await keysOf(run, 'insight')).values()].slice(0, 6).map((id) => ['entry', id] as const),
    ...[...(await keysOf(run, 'pressRelease')).values()]
      .slice(0, 4)
      .map((id) => ['entry', id] as const),
    ...[...(await keysOf(run, 'legalPage')).values()]
      .slice(0, 2)
      .map((id) => ['entry', id] as const),
  ];
  const actions = [
    ['PUT /entries/:id', 200],
    ['POST /entries/:id/published', 200],
    ['PUT /entries/:id/metadata', 200],
    ['POST /entries', 201],
    ['POST /workflows/tasks/:id/decision', 200],
    ['DELETE /entries/:id/published', 403],
    ['POST /releases/:id/entries', 200],
    ['PUT /entries/:id', 409],
  ] as const;
  const actors = TEAM.filter((t) => !t.disabled).map((t) => t.email);
  let n = 0;
  for (let day = 29; day >= 0; day--) {
    const count = day % 7 === 5 || day % 7 === 6 ? 1 : 3;
    for (let k = 0; k < count; k++) {
      const [action, status] = pickOf(actions, n);
      const [targetType, targetId] = pickOf(targets, n * 3);
      const at = new Date(now);
      at.setUTCDate(at.getUTCDate() - day);
      at.setUTCHours(8 + ((k * 3 + n) % 10), (n * 7) % 60, 0, 0);
      await ctx.store.audit.append({
        id: ctx.ids.newId(),
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        actor: pickOf(actors, n * 5),
        action,
        targetType,
        targetId,
        status,
        at: at.toISOString(),
      });
      n++;
    }
  }
}
