import { assetIdsByFile } from './assets';
import { BRAND, loc, locBuild, one, type Tr } from './brand';
import { asset, ensureEntries, entry, keysOf, loadTerms, type Spec } from './entries';
import { doc, p } from './rt';
import type { EnterpriseRun } from './run';
import { audience, topic } from './taxonomy';

/**
 * The pages people land on, built from blocks: the market home page (a singleton), the site
 * settings (a singleton: footer, social, disclaimers, analytics), campaign and program pages, topic
 * hubs, C-suite agendas, about and contact pages. Grids pick entries by hand or query by topic.
 */

type Section = Record<string, unknown>;
const hero = (
  headline: string,
  subhead: string,
  image?: string,
  variant = 'identity',
): Section => ({
  _type: 'hero',
  variant,
  headline,
  subhead,
  ...(image ? { image: asset(image) } : {}),
});
const grid = (heading: string, items: readonly string[], layout = 'grid'): Section => ({
  _type: 'cardGrid',
  heading,
  mode: 'manual',
  items: items.map(entry),
  layout,
});
const query = (heading: string, type: string, topicSlug: string, max = 6): Section => ({
  _type: 'cardGrid',
  heading,
  mode: 'query',
  queryType: type,
  queryTopic: topicSlug,
  maxItems: max,
  layout: 'carousel',
});
const stats = (heading: string, rows: readonly (readonly [string, string, string])[]): Section => ({
  _type: 'statBand',
  heading,
  stats: rows.map(([value, unit, label]) => ({
    value,
    unit,
    label,
    source: `${BRAND.name} Institute`,
  })),
});
const text = (heading: string, body: string): Section => ({
  _type: 'richText',
  heading,
  body: doc(p(body)),
});
const ctaBand = (id?: string): Section[] => (id ? [{ _type: 'ctaBand', cta: entry(id) }] : []);
const form = (id?: string): Section[] => (id ? [{ _type: 'form', form: entry(id) }] : []);
const team = (heading: string, ids: readonly string[]): Section => ({
  _type: 'team',
  heading,
  people: ids.map(entry),
});

interface PageDef {
  readonly slug: string;
  readonly title: Tr;
  readonly template: string;
  readonly summary: Tr;
  readonly parent?: string;
  readonly topics?: readonly string[];
  readonly audiences?: readonly string[];
  readonly tags?: readonly string[];
  readonly status?: Spec['status'];
  readonly brand?: 'vantage';
  readonly sections: (ids: Ids) => Section[];
}

interface Ids {
  readonly f: (file: string) => string | undefined;
  readonly insight: (slug: string) => string | undefined;
  readonly person: (slug: string) => string | undefined;
  readonly cta: (name: string) => string | undefined;
  readonly form: (name: string) => string | undefined;
  readonly all: (
    map: 'insight' | 'caseStudy' | 'pressRelease' | 'event' | 'service',
    slugs: readonly string[],
  ) => string[];
}

const PAGES: readonly PageDef[] = [
  {
    slug: 'about-us',
    title: {
      en: 'About us',
      'de-DE': 'Über uns',
      'fr-FR': 'À propos',
      'es-ES': 'Quiénes somos',
      'ja-JP': '私たちについて',
      'zh-CN': '关于我们',
      'pt-BR': 'Sobre nós',
      'ar-AE': 'من نحن',
    },
    template: 'about',
    summary: {
      en: `${BRAND.name} is 92,000 people in 64 countries, helping clients find clarity in what comes next.`,
      'de-DE': `${BRAND.name}: 92.000 Menschen in 64 Ländern.`,
    },
    sections: (x) => [
      hero(
        'Clarity for what comes next',
        `${BRAND.name} is 92,000 people in 64 countries.`,
        x.f('hero-horizon.png'),
      ),
      stats('At a glance', [
        ['92,000', '', 'people'],
        ['64', '', 'countries'],
        ['52.3', 'bn', 'US$ revenue, fiscal 2026'],
      ]),
      text(
        'Our purpose',
        'We help organizations make the decisions that matter with confidence, and see them through.',
      ),
      team(
        'Global leadership',
        [
          'amara-okafor',
          'henrik-lindqvist',
          'claire-dubois',
          'rafael-duarte',
          'mei-tanaka',
          'layla-haddad',
        ]
          .map(x.person)
          .filter((v): v is string => !!v),
      ),
      ...ctaBand(x.cta('Impact report promo')),
    ],
  },
  {
    slug: 'impact-report-2026',
    title: {
      en: 'Impact Report 2026',
      'de-DE': 'Impact Report 2026',
      'fr-FR': 'Rapport d’impact 2026',
    },
    template: 'campaign',
    parent: 'about-us',
    summary: { en: 'How we measure up on climate, people and governance.' },
    topics: ['climate', 'sustainability-reporting'],
    tags: ['campaign-impact-report'],
    sections: (x) => [
      hero(
        'Impact Report 2026',
        'Emissions down 41% against our 2019 baseline.',
        x.f('campaign-impact-report.png'),
      ),
      stats('Highlights', [
        ['41', '%', 'lower emissions than 2019'],
        ['46', '%', 'women among new partners'],
        ['1.1', 'm', 'volunteering hours'],
      ]),
      {
        _type: 'downloads',
        heading: 'Download the report',
        files: [x.f('impact-report-2026.pdf')].filter(Boolean).map((id) => asset(id as string)),
      },
      {
        _type: 'tabs',
        tabs: [
          { label: 'Climate', body: doc(p('Our science-based targets and progress.')) },
          { label: 'People', body: doc(p('Inclusion, wellbeing and learning.')) },
          { label: 'Governance', body: doc(p('How we are run and held to account.')) },
        ],
      },
    ],
  },
  {
    slug: 'ceo-outlook',
    title: {
      en: 'CEO Outlook 2027',
      'de-DE': 'CEO Outlook 2027',
      'ja-JP': 'CEOアウトルック2027',
      'fr-FR': 'CEO Outlook 2027',
    },
    template: 'campaign',
    summary: { en: 'Our survey of 1,200 chief executives on growth, risk and AI.' },
    topics: ['growth-strategy'],
    audiences: ['ceo', 'board'],
    tags: ['campaign-ceo-outlook', 'embargoed'],
    status: 'draft',
    sections: (x) => [
      hero('CEO Outlook 2027', 'Confidence returns, cautiously.', x.f('campaign-ceo-outlook.png')),
      stats('The headlines', [
        ['67', '%', 'expect growth'],
        ['18', '%', 'plan for a single scenario'],
      ]),
      grid('Read the findings', x.all('insight', ['ceo-outlook-2027'])),
      grid('In the news', x.all('pressRelease', ['ceo-outlook-2027-launch'])),
      { _type: 'eventList', heading: 'Join the launch briefing', window: 'upcoming', maxItems: 3 },
      ...form(x.form('CEO Outlook 2027 download')),
    ],
  },
  {
    slug: 'ai',
    title: {
      en: 'AI',
      'de-DE': 'KI',
      'fr-FR': 'IA',
      'es-ES': 'IA',
      'ja-JP': 'AI',
      'zh-CN': '人工智能',
      'pt-BR': 'IA',
      'ar-AE': 'الذكاء الاصطناعي',
    },
    template: 'topic-hub',
    summary: { en: 'Our thinking on AI strategy, governance and value.' },
    topics: ['ai-and-data'],
    tags: ['global-rollout'],
    sections: (x) => [
      hero(
        'Where AI meets the business',
        'Strategy, governance and measurable value.',
        x.f('hero-data-grid.png'),
      ),
      query('Latest on AI', 'insight', 'ai-and-data'),
      grid(
        'AI in the boardroom',
        x.all('insight', [
          'what-boards-should-ask-about-ai',
          'ai-risk-appetite',
          'ai-and-the-audit-committee',
        ]),
      ),
      {
        _type: 'faq',
        heading: 'Questions we hear',
        emitSchema: true,
        items: [
          {
            question: 'Where should we start?',
            answer: doc(p('With the decision you want to improve, not the model you want to use.')),
          },
          {
            question: 'Who should own AI?',
            answer: doc(
              p('A named executive per use case, with the board overseeing the portfolio.'),
            ),
          },
        ],
      },
      ...ctaBand(x.cta('Subscribe band')),
    ],
  },
  {
    slug: 'sustainability-hub',
    title: {
      en: 'Sustainability',
      'de-DE': 'Nachhaltigkeit',
      'fr-FR': 'Développement durable',
      'ar-AE': 'الاستدامة',
      'pt-BR': 'Sustentabilidade',
    },
    template: 'topic-hub',
    summary: { en: 'Decarbonization, nature and reporting, grounded in data.' },
    topics: ['climate', 'nature'],
    sections: (x) => [
      hero(
        'Sustainability that pays its way',
        'Plans that are financeable, reporting that is assurable.',
        x.f('hero-wind-farm.png'),
      ),
      query('Latest on climate', 'insight', 'climate'),
      query('Case studies', 'caseStudy', 'climate', 3),
    ],
  },
  {
    slug: 'geostrategy',
    title: { en: 'Geostrategy', 'de-DE': 'Geostrategie', 'ja-JP': '地政学戦略' },
    template: 'topic-hub',
    summary: { en: 'Navigating a fragmented world.' },
    topics: ['geostrategy'],
    sections: (x) => [
      hero(
        'Strategy for a fragmented world',
        'Scenarios, supply chains and the cost of uncertainty.',
        x.f('hero-horizon.png'),
      ),
      query('Latest', 'insight', 'geostrategy'),
    ],
  },
  {
    slug: 'cfo-agenda',
    title: { en: 'The CFO agenda', 'de-DE': 'Die CFO-Agenda' },
    template: 'program',
    summary: { en: 'What finance leaders are prioritizing this year.' },
    audiences: ['cfo'],
    topics: ['finance-function'],
    sections: (x) => [
      hero(
        'The CFO agenda',
        'Funding AI, the minimum tax and a faster close.',
        x.f('hero-trading-floor.png'),
      ),
      query('For finance leaders', 'insight', 'finance-function'),
      ...ctaBand(x.cta('Minimum tax tool')),
    ],
  },
  {
    slug: 'ciso-agenda',
    title: { en: 'The CISO agenda' },
    template: 'program',
    summary: { en: 'Resilience, identity and recovery.' },
    audiences: ['ciso'],
    topics: ['cybersecurity'],
    sections: (x) => [
      hero('The CISO agenda', 'From detection to recovery.', x.f('hero-data-grid.png')),
      grid('Read the index', x.all('insight', ['cyber-resilience-index-2026'])),
      ...ctaBand(x.cta('Cyber readiness check')),
    ],
  },
  {
    slug: 'deals-hub',
    title: { en: 'Deals and transactions' },
    template: 'program',
    brand: 'vantage',
    summary: { en: 'Aldermoor Vantage on value creation through deals.' },
    topics: ['m-and-a'],
    tags: ['sub-brand-vantage'],
    sections: (x) => [
      hero(
        'Value, created and protected',
        'Aldermoor Vantage',
        x.f('hero-boardroom.png'),
        'product',
      ),
      query('Deals insight', 'insight', 'm-and-a'),
    ],
  },
  {
    slug: 'newsroom',
    title: {
      en: 'Newsroom',
      'de-DE': 'Presse',
      'fr-FR': 'Salle de presse',
      'es-ES': 'Sala de prensa',
      'ja-JP': 'ニュースルーム',
      'zh-CN': '新闻中心',
      'pt-BR': 'Sala de imprensa',
      'ar-AE': 'غرفة الأخبار',
    },
    template: 'generic',
    summary: { en: 'News, releases and media contacts.' },
    sections: (x) => [
      hero('Newsroom', 'The latest from Aldermoor.', x.f('press-headshots.png'), 'banner'),
      query('Latest releases', 'pressRelease', '', 12),
    ],
  },
  {
    slug: 'events',
    title: {
      en: 'Events and webcasts',
      'de-DE': 'Veranstaltungen',
      'ja-JP': 'イベント・ウェビナー',
    },
    template: 'generic',
    summary: { en: 'Upcoming webcasts, conferences and roundtables, and recordings on demand.' },
    sections: () => [
      { _type: 'eventList', heading: 'Upcoming', window: 'upcoming', maxItems: 12 },
      { _type: 'eventList', heading: 'On demand', window: 'on-demand', maxItems: 12 },
    ],
  },
  {
    slug: 'contact',
    title: {
      en: 'Contact us',
      'de-DE': 'Kontakt',
      'fr-FR': 'Nous contacter',
      'es-ES': 'Contacto',
      'ja-JP': 'お問い合わせ',
      'zh-CN': '联系我们',
      'pt-BR': 'Fale conosco',
      'ar-AE': 'اتصل بنا',
    },
    template: 'generic',
    summary: { en: 'Tell us how we can help.' },
    sections: (x) => [
      ...form(x.form('Contact us')),
      text(
        'Media enquiries',
        'Journalists can reach our media relations teams in every region through the newsroom.',
      ),
    ],
  },
  {
    slug: 'careers',
    title: {
      en: 'Careers',
      'de-DE': 'Karriere',
      'fr-FR': 'Carrières',
      'es-ES': 'Empleo',
      'ja-JP': '採用情報',
      'zh-CN': '职业发展',
      'pt-BR': 'Carreiras',
      'ar-AE': 'الوظائف',
    },
    template: 'generic',
    summary: { en: 'Build a career with purpose.' },
    topics: ['skills-and-talent'],
    sections: (x) => [
      hero(
        'The better your career, the better the world works for you',
        'Join 14,000 graduates this year.',
        x.f('hero-classroom.png'),
      ),
      ...ctaBand(x.cta('Careers: graduates')),
    ],
  },
];

export async function seedEnterpriseSite(run: EnterpriseRun): Promise<void> {
  const { space } = run;
  const terms = await loadTerms(run);
  const files = await assetIdsByFile(run);
  const maps = {
    insight: await keysOf(run, 'insight'),
    caseStudy: await keysOf(run, 'caseStudy'),
    pressRelease: await keysOf(run, 'pressRelease'),
    event: await keysOf(run, 'event'),
    service: await keysOf(run, 'service'),
  };
  const people = await keysOf(run, 'person');
  const ctas = await keysOf(run, 'cta', 'internalName');
  const forms = await keysOf(run, 'form', 'name');
  const disclaimers = await keysOf(run, 'disclaimer', 'internalName');
  const ids: Ids = {
    f: (file) => files.get(file),
    insight: (s) => maps.insight.get(s),
    person: (s) => people.get(s),
    cta: (n) => ctas.get(n),
    form: (n) => forms.get(n),
    all: (map, slugs) => slugs.map((s) => maps[map].get(s)).filter((x): x is string => !!x),
  };

  // Parents first, so children can link to them.
  const pages = await keysOf(run, 'page');
  for (const round of [PAGES.filter((pg) => !pg.parent), PAGES.filter((pg) => pg.parent)]) {
    const specs: Spec[] = round.map((pg, n) => ({
      key: pg.slug,
      status: pg.status ?? (n === 3 ? 'changed' : 'published'),
      tags: pg.tags ?? [],
      concepts: [...(pg.topics ?? []).map(topic), ...(pg.audiences ?? []).map(audience)],
      patch: { summary: loc({ en: `${pg.summary.en} Refreshed for the new year.` }, space) },
      fields: {
        title: loc(pg.title, space),
        slug: one(pg.slug, space),
        template: one(pg.template, space),
        summary: loc(pg.summary, space),
        sections: { [space.defaultLocale]: pg.sections(ids) },
        ...(pg.parent && pages.get(pg.parent)
          ? { parent: one(entry(pages.get(pg.parent) as string), space) }
          : {}),
        area: one('global', space),
        brand: one(pg.brand ?? 'aldermoor', space),
        seo: locBuild(pg.title, space, (title, l) => ({
          title: `${title} | ${pg.brand ? BRAND.subBrand : BRAND.name}`,
          description: (loc(pg.summary, space)[l] ?? pg.summary.en).slice(0, 158),
          canonicalUrl: `/${l}/${pg.slug}`,
        })),
      },
    }));
    for (const [k, v] of await ensureEntries(run, 'page', specs, terms)) pages.set(k, v);
  }

  // The home page: a market's own hero and spotlight, the rest shared.
  const spotlight = [
    ...ids.all('insight', ['global-tax-policy-index-wave-6', 'cyber-resilience-index-2026']),
    ...ids.all('caseStudy', ['insurer-ai-claims-triage']),
    ...ids.all('pressRelease', ['global-revenues-fy2026']),
  ];
  const headline: Tr = {
    en: 'Clarity for what comes next',
    'de-DE': 'Klarheit für das, was kommt',
    'fr-FR': 'Voir clair dans ce qui vient',
    'es-ES': 'Claridad para lo que viene',
    'ja-JP': 'これからを、明確に。',
    'zh-CN': '洞见未来，清晰前行',
    'pt-BR': 'Clareza para o que vem a seguir',
    'ar-AE': 'وضوح لما هو قادم',
  };
  await ensureEntries(
    run,
    'homePage',
    [
      {
        key: `${BRAND.name} home`,
        tags: ['global-rollout'],
        fields: {
          title: loc({ en: `${BRAND.name} home` }, space),
          sections: locBuild(headline, space, (h) => [
            hero(h, BRAND.tagline, files.get('hero-horizon.png')),
            grid(
              'On the agenda',
              ids.all('insight', [
                'global-tax-policy-index-wave-6',
                'climate-transition-barometer',
                'the-cost-of-redundancy',
              ]),
              'carousel',
            ),
            stats('By the numbers', [
              ['92,000', '', 'people'],
              ['64', '', 'countries'],
              ['150', '+', 'years'],
            ]),
            grid(
              'Case studies',
              ids.all('caseStudy', [
                'regional-bank-close-in-three-days',
                'utility-grid-decarbonization-plan',
                'ministry-digital-services',
              ]),
            ),
            { _type: 'eventList', heading: 'Upcoming events', window: 'upcoming', maxItems: 3 },
            ...ctaBand(ids.cta('Subscribe band')),
          ]),
          spotlight: one(spotlight.map(entry), space),
          seo: locBuild(headline, space, (h) => ({
            title: `${BRAND.name} | ${h}`,
            description: `${BRAND.name}: audit, consulting, tax, strategy and transactions.`,
          })),
        },
      },
    ],
    terms,
    'title',
  );

  const network = disclaimers.get('Network statement');
  const vantage = disclaimers.get('Vantage statement');
  await ensureEntries(
    run,
    'siteSettings',
    [
      {
        key: BRAND.name,
        fields: {
          siteName: one(BRAND.name, space),
          footerStatement: loc(
            {
              en: `© ${run.ctx.clock.now().getUTCFullYear()} ${BRAND.legalName}. All rights reserved.`,
              'de-DE': `© ${run.ctx.clock.now().getUTCFullYear()} ${BRAND.legalName}. Alle Rechte vorbehalten.`,
              'fr-FR': `© ${run.ctx.clock.now().getUTCFullYear()} ${BRAND.legalName}. Tous droits réservés.`,
              'ja-JP': `© ${run.ctx.clock.now().getUTCFullYear()} ${BRAND.legalName}. 無断複写・転載を禁じます。`,
            },
            space,
          ),
          ...(network ? { networkDisclaimer: one(entry(network), space) } : {}),
          ...(vantage ? { subBrandDisclaimer: one(entry(vantage), space) } : {}),
          social: one(
            [
              { network: 'linkedin', url: 'https://www.linkedin.example/company/aldermoor' },
              { network: 'x', url: 'https://x.example/aldermoor' },
              { network: 'youtube', url: 'https://www.youtube.example/@aldermoor' },
            ],
            space,
          ),
          cookieBanner: loc(
            {
              en: 'We use cookies to run this site and, with your consent, to understand how it is used.',
              'de-DE':
                'Wir verwenden Cookies für den Betrieb dieser Website und, mit Ihrer Einwilligung, für Analysen.',
            },
            space,
          ),
          analytics: one(
            {
              containers: {
                'en-US': 'GTM-ALD-US',
                'en-GB': 'GTM-ALD-UK',
                'de-DE': 'GTM-ALD-DE',
                'ja-JP': 'GTM-ALD-JP',
              },
              consentMode: 'basic',
            },
            space,
          ),
        },
      },
    ],
    terms,
    'siteName',
  );
}
