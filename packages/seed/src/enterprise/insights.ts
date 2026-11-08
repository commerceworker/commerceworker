import { assetIdsByFile } from './assets';
import { BRAND, loc, locBuild, one, type Tr } from './brand';
import {
  asset,
  dayOnly,
  ensureEntries,
  entry,
  keysOf,
  loadTerms,
  need,
  pickOf,
  type Spec,
} from './entries';
import { expertsOn } from './people';
import { a, b, doc, embedAsset, h2, i, ol, p, paras, quote, table, ul } from './rt';
import type { EnterpriseRun } from './run';
import { audience, region, topic } from './taxonomy';

/**
 * Thought leadership: series, four flagship reports (with editions, key figures, methodology,
 * gated PDFs and translations into most markets) and the long tail of articles across every
 * topic, a quarter of them chaptered. Statuses mix published, changed (an edit waiting to go out)
 * and draft, and the CEO Outlook stays a draft until its launch release.
 */

export const SERIES = [
  {
    slug: 'ai-in-the-boardroom',
    kind: 'whitepaper',
    name: {
      en: 'AI in the boardroom',
      'de-DE': 'KI im Aufsichtsrat',
      'fr-FR': 'L’IA au conseil d’administration',
      'ja-JP': '取締役会とAI',
    },
    description: {
      en: 'Four papers on what directors need to ask, decide and oversee as AI moves into the core of the business.',
    },
  },
  {
    slug: 'the-new-tax-map',
    kind: 'whitepaper',
    name: { en: 'The new tax map', 'de-DE': 'Die neue Steuerlandkarte' },
    description: {
      en: 'How the global minimum tax, digital taxes and incentives are redrawing where companies invest.',
    },
  },
  {
    slug: 'supply-chain-reset',
    kind: 'whitepaper',
    name: {
      en: 'Supply chain reset',
      'es-ES': 'El reinicio de la cadena de suministro',
      'zh-CN': '供应链重塑',
    },
    description: { en: 'Resilience, regionalization and the real cost of redundancy.' },
  },
  {
    slug: 'ceo-outlook',
    kind: 'index',
    name: { en: 'CEO Outlook', 'de-DE': 'CEO Outlook', 'ja-JP': 'CEOアウトルック' },
    description: { en: 'Our annual survey of 1,200 chief executives in 30 countries.' },
  },
  {
    slug: 'clarity-podcast',
    kind: 'podcast',
    name: { en: 'The Clarity Podcast', 'de-DE': 'Der Clarity-Podcast' },
    description: { en: 'Conversations with the people deciding what comes next.' },
    hosts: ['daniel-park', 'sophie-hartley'],
  },
  {
    slug: 'tax-talks',
    kind: 'podcast',
    name: { en: 'Tax Talks', 'pt-BR': 'Conversas sobre Tributos' },
    description: { en: 'Twenty minutes on the tax policy story of the month.' },
    hosts: ['rafael-duarte', 'marcus-reid'],
  },
] as const;

interface InsightDef {
  readonly slug: string;
  readonly headline: Tr;
  readonly standfirst: Tr;
  readonly inBrief?: readonly Tr[];
  readonly format: 'article' | 'chaptered' | 'report' | 'survey' | 'index';
  readonly topics: readonly string[];
  readonly hero: string;
  readonly series?: string;
  readonly position?: number;
  readonly tier?: 'tier-1' | 'tier-2';
  readonly edition?: number;
  readonly pdf?: string;
  readonly gated?: boolean;
  readonly daysAgo: number;
  readonly status?: Spec['status'];
  readonly tags?: readonly string[];
  readonly audiences?: readonly string[];
  readonly regions?: readonly string[];
  readonly area?: string;
  readonly brand?: 'vantage';
  readonly stats?: readonly (readonly [string, string, string])[];
  /** Translated body paragraphs, per locale: the market's own copy of the master. */
  readonly translatedBody?: Partial<Record<string, readonly string[]>>;
}

const tr = (en: string, more: Omit<Tr, 'en'> = {}): Tr => ({ en, ...more });

const FLAGSHIP: readonly InsightDef[] = [
  {
    slug: 'ceo-outlook-2027',
    format: 'survey',
    series: 'ceo-outlook',
    edition: 9,
    tier: 'tier-1',
    headline: tr('CEO Outlook 2027: confidence returns, cautiously', {
      'en-GB': 'CEO Outlook 2027: confidence returns, cautiously',
      'de-DE': 'CEO Outlook 2027: Die Zuversicht kehrt zurück – mit Vorsicht',
      'fr-FR': 'CEO Outlook 2027 : la confiance revient, prudemment',
      'es-ES': 'CEO Outlook 2027: la confianza vuelve, con cautela',
      'ja-JP': 'CEOアウトルック2027：慎重ながら戻る自信',
      'zh-CN': '2027年CEO展望：信心审慎回归',
      'pt-BR': 'CEO Outlook 2027: a confiança volta, com cautela',
      'ar-AE': 'توقعات الرؤساء التنفيذيين 2027: عودة الثقة بحذر',
    }),
    standfirst: tr(
      'Two-thirds of chief executives expect to grow next year, but fewer than one in five will bet on a single scenario to get there.',
      {
        'de-DE':
          'Zwei Drittel der CEOs erwarten Wachstum im kommenden Jahr – doch weniger als jeder Fünfte setzt dabei auf ein einziges Szenario.',
        'fr-FR':
          'Deux dirigeants sur trois prévoient une croissance l’an prochain, mais moins d’un sur cinq misera sur un scénario unique.',
        'es-ES':
          'Dos tercios de los consejeros delegados esperan crecer el próximo año, pero menos de uno de cada cinco apostará por un único escenario.',
        'ja-JP':
          'CEOの3分の2が来年の成長を見込む一方、単一のシナリオに賭けるのは5人に1人にも満たない。',
        'zh-CN': '三分之二的首席执行官预计明年实现增长，但押注单一情景的不到五分之一。',
        'pt-BR':
          'Dois terços dos CEOs esperam crescer no próximo ano, mas menos de um em cada cinco apostará em um único cenário.',
        'ar-AE':
          'يتوقع ثلثا الرؤساء التنفيذيين النمو في العام المقبل، لكن أقل من واحد من كل خمسة سيراهن على سيناريو واحد.',
      },
    ),
    inBrief: [
      tr('67% of CEOs expect revenue growth in 2027, up from 54%.', {
        'de-DE': '67 % der CEOs erwarten 2027 Umsatzwachstum, nach 54 %.',
        'ja-JP': '2027年の増収を見込むCEOは67%（前回54%）。',
      }),
      tr('Geopolitics overtakes inflation as the top risk to growth.', {
        'de-DE': 'Geopolitik löst Inflation als größtes Wachstumsrisiko ab.',
        'ja-JP': '成長への最大のリスクは、インフレから地政学へ。',
      }),
      tr('AI investment is now funded from cost savings, not new budget.', {
        'de-DE': 'KI-Investitionen werden aus Einsparungen finanziert, nicht aus neuem Budget.',
        'ja-JP': 'AI投資の原資は新規予算ではなくコスト削減に。',
      }),
    ],
    topics: ['growth-strategy', 'geostrategy', 'ai-and-data'],
    audiences: ['ceo', 'board'],
    hero: 'campaign-ceo-outlook.png',
    pdf: 'ceo-outlook-2027.pdf',
    gated: true,
    daysAgo: 0,
    status: 'draft',
    tags: [
      'tier-1',
      'featured',
      'embargoed',
      'campaign-ceo-outlook',
      'global-rollout',
      'sme-reviewed',
    ],
    stats: [
      ['67', '%', 'expect revenue growth in 2027'],
      ['18', '%', 'plan around a single scenario'],
      ['1,200', '', 'CEOs surveyed in 30 countries'],
    ],
    translatedBody: {
      'de-DE': [
        'Nach zwei Jahren der Zurückhaltung blicken CEOs wieder zuversichtlicher auf das Wachstum. Doch die Zuversicht ist an Bedingungen geknüpft.',
        'Die meisten Unternehmen planen mit drei oder mehr Szenarien und halten Investitionen flexibel.',
      ],
      'fr-FR': [
        'Après deux années de prudence, les dirigeants abordent la croissance avec davantage de confiance, mais sous conditions.',
        'La plupart des entreprises raisonnent en trois scénarios ou plus et gardent leurs investissements réversibles.',
      ],
      'ja-JP': [
        '2年間の慎重姿勢を経て、CEOは再び成長に自信を見せ始めている。ただし、その自信には条件が付く。',
        '多くの企業が3つ以上のシナリオを前提に計画し、投資の柔軟性を確保している。',
      ],
      'es-ES': [
        'Tras dos años de prudencia, los consejeros delegados vuelven a mirar al crecimiento con confianza, aunque con condiciones.',
      ],
      'zh-CN': ['经过两年的谨慎之后，首席执行官们重新对增长抱有信心，但这种信心是有条件的。'],
      'pt-BR': [
        'Depois de dois anos de cautela, os CEOs voltam a olhar para o crescimento com confiança, mas com condições.',
      ],
      'ar-AE': [
        'بعد عامين من الحذر، يعود الرؤساء التنفيذيون إلى النظر إلى النمو بثقة، ولكن بشروط.',
      ],
    },
  },
  {
    slug: 'global-tax-policy-index-wave-6',
    format: 'index',
    series: 'the-new-tax-map',
    position: 1,
    edition: 6,
    tier: 'tier-1',
    headline: tr('Global Tax Policy Index, wave 6: the minimum tax goes mainstream', {
      'de-DE': 'Global Tax Policy Index, Welle 6: Die Mindeststeuer wird zum Standard',
      'fr-FR': 'Indice mondial des politiques fiscales, vague 6 : l’impôt minimum se généralise',
      'pt-BR': 'Índice Global de Política Tributária, onda 6: o imposto mínimo se consolida',
      'ja-JP': 'グローバル税務政策インデックス第6回：ミニマム課税が主流に',
    }),
    standfirst: tr(
      'Fifty-eight jurisdictions now apply a global minimum tax. The next question is how they will compete without rates.',
      {
        'de-DE':
          'Achtundfünfzig Jurisdiktionen wenden inzwischen eine globale Mindeststeuer an. Die nächste Frage: Wie konkurrieren sie ohne Steuersätze?',
        'pt-BR':
          'Cinquenta e oito jurisdições já aplicam um imposto mínimo global. A próxima pergunta é como vão competir sem alíquotas.',
      },
    ),
    inBrief: [
      tr('58 jurisdictions apply a qualified minimum tax.'),
      tr('Incentive design is shifting to refundable credits.'),
      tr('Data, not rates, is the new compliance bottleneck.'),
    ],
    topics: ['global-minimum-tax', 'tax-technology'],
    audiences: ['cfo'],
    hero: 'chart-minimum-tax.png',
    pdf: 'global-tax-policy-index-w6.pdf',
    daysAgo: 21,
    tags: ['tier-1', 'global-rollout', 'sme-reviewed'],
    stats: [
      ['58', '', 'jurisdictions applying a minimum tax'],
      ['41', '%', 'of groups still lack the data they need'],
    ],
    translatedBody: {
      'de-DE': [
        'Die globale Mindeststeuer ist kein Projekt mehr, sondern Alltag. Für Steuerabteilungen verschiebt sich die Arbeit von der Planung zur Datenbeschaffung.',
      ],
    },
  },
  {
    slug: 'cyber-resilience-index-2026',
    format: 'index',
    edition: 3,
    tier: 'tier-1',
    headline: tr('Cyber Resilience Index 2026: faster to contain, slower to recover', {
      'ja-JP': 'サイバーレジリエンス・インデックス2026：封じ込めは速く、復旧は遅く',
      'de-DE': 'Cyber Resilience Index 2026: schneller eingedämmt, langsamer erholt',
    }),
    standfirst: tr(
      'Organizations now contain incidents in nine days on average. Getting back to normal still takes a month.',
      {
        'ja-JP':
          'インシデントの封じ込めは平均9日に短縮。しかし平常業務への復帰には依然1カ月を要する。',
      },
    ),
    inBrief: [
      tr('Median time to contain fell from 21 to 9 days.'),
      tr('Recovery, not detection, is now the weakest link.'),
      tr('Boards that rehearse recover twice as fast.'),
    ],
    topics: ['cybersecurity'],
    audiences: ['ciso', 'board'],
    hero: 'chart-cyber-incidents.png',
    pdf: 'cyber-resilience-index-2026.pdf',
    daysAgo: 64,
    tags: ['tier-1', 'global-rollout'],
    stats: [
      ['9', 'days', 'median time to contain'],
      ['31', 'days', 'median time to recover'],
      ['2', 'x', 'faster recovery for boards that rehearse'],
    ],
  },
  {
    slug: 'climate-transition-barometer',
    format: 'report',
    edition: 4,
    tier: 'tier-1',
    headline: tr('Climate Transition Barometer: plans are credible, financing is not', {
      'fr-FR':
        'Baromètre de la transition climatique : des plans crédibles, un financement qui ne suit pas',
      'ar-AE': 'مؤشر التحول المناخي: الخطط ذات مصداقية والتمويل ليس كذلك',
      'pt-BR': 'Barômetro da Transição Climática: planos críveis, financiamento não',
    }),
    standfirst: tr(
      'Most large companies now have a transition plan an auditor could test. Fewer than a third have the capital lined up to deliver it.',
      {
        'fr-FR':
          'La plupart des grandes entreprises disposent d’un plan de transition vérifiable. Moins d’un tiers ont sécurisé le financement.',
      },
    ),
    inBrief: [
      tr('72% publish a transition plan with interim targets.'),
      tr('Only 29% have the capital expenditure committed.'),
      tr('Nature risk is entering credit decisions.'),
    ],
    topics: ['climate', 'sustainability-reporting', 'nature'],
    audiences: ['cso', 'cfo'],
    hero: 'hero-wind-farm.png',
    pdf: 'climate-transition-barometer.pdf',
    daysAgo: 102,
    tags: ['tier-1', 'campaign-impact-report', 'global-rollout'],
    stats: [
      ['72', '%', 'publish a transition plan'],
      ['29', '%', 'have the capital committed'],
    ],
    translatedBody: {
      'fr-FR': [
        'Les plans de transition sont devenus plus solides, mais leur financement reste le maillon faible.',
      ],
    },
  },
];

const SERIES_ARTICLES: readonly InsightDef[] = [
  {
    slug: 'what-boards-should-ask-about-ai',
    series: 'ai-in-the-boardroom',
    position: 1,
    format: 'chaptered',
    headline: tr('Ten questions every board should ask about AI', {
      'de-DE': 'Zehn Fragen, die jeder Aufsichtsrat zu KI stellen sollte',
      'fr-FR': 'Dix questions que tout conseil devrait poser sur l’IA',
      'ja-JP': '取締役会がAIについて問うべき10の質問',
    }),
    standfirst: tr(
      'Oversight starts with knowing which models you run, who owns them and what they are allowed to decide.',
    ),
    topics: ['ai-and-data'],
    audiences: ['board'],
    hero: 'hero-boardroom.png',
    daysAgo: 140,
    tier: 'tier-1',
    tags: ['tier-1', 'evergreen'],
  },
  {
    slug: 'ai-risk-appetite',
    series: 'ai-in-the-boardroom',
    position: 2,
    format: 'article',
    headline: tr('Setting an AI risk appetite the business can use'),
    standfirst: tr(
      'A risk appetite that says “low” is not a decision. Here is how to write one that is.',
    ),
    topics: ['ai-and-data', 'regulatory-change'],
    audiences: ['board', 'general-counsel'],
    hero: 'hero-data-grid.png',
    daysAgo: 112,
  },
  {
    slug: 'ai-and-the-audit-committee',
    series: 'ai-in-the-boardroom',
    position: 3,
    format: 'article',
    headline: tr('AI and the audit committee'),
    standfirst: tr(
      'When models touch financial reporting, the audit committee owns the question of whether to trust them.',
    ),
    topics: ['ai-and-data', 'internal-audit'],
    audiences: ['board', 'cfo'],
    hero: 'hero-trading-floor.png',
    daysAgo: 85,
  },
  {
    slug: 'measuring-ai-value',
    series: 'ai-in-the-boardroom',
    position: 4,
    format: 'chaptered',
    headline: tr('Measuring the value of AI, honestly'),
    standfirst: tr(
      'Most AI business cases count time saved. The ones that survive count decisions improved.',
    ),
    topics: ['ai-and-data', 'finance-function'],
    audiences: ['cfo', 'ceo'],
    hero: 'hero-data-grid.png',
    daysAgo: 12,
    status: 'draft',
    tags: ['ai-assisted'],
  },
  {
    slug: 'incentives-after-the-minimum-tax',
    series: 'the-new-tax-map',
    position: 2,
    format: 'article',
    headline: tr('Incentives after the minimum tax', {
      'de-DE': 'Förderprogramme nach der Mindeststeuer',
    }),
    standfirst: tr(
      'Refundable credits and grants are replacing rate cuts. Here is where that changes the investment case.',
    ),
    topics: ['global-minimum-tax'],
    audiences: ['cfo'],
    hero: 'hero-port.png',
    daysAgo: 48,
    regions: ['emeia'],
  },
  {
    slug: 'digital-services-taxes-what-next',
    series: 'the-new-tax-map',
    position: 3,
    format: 'article',
    headline: tr('Digital services taxes: what happens next'),
    standfirst: tr('As the multilateral deal stalls, unilateral measures are back on the table.'),
    topics: ['indirect-tax', 'geostrategy'],
    audiences: ['cfo', 'general-counsel'],
    hero: 'hero-port.png',
    daysAgo: 30,
    status: 'changed',
  },
  {
    slug: 'the-cost-of-redundancy',
    series: 'supply-chain-reset',
    position: 1,
    format: 'chaptered',
    headline: tr('The real cost of redundancy', {
      'es-ES': 'El coste real de la redundancia',
      'zh-CN': '冗余的真实成本',
    }),
    standfirst: tr(
      'Dual sourcing adds 4–7% to cost of goods. The companies that pay it are recovering market share.',
    ),
    topics: ['supply-chain'],
    audiences: ['ceo', 'cfo'],
    hero: 'hero-port.png',
    daysAgo: 160,
    tags: ['evergreen'],
  },
  {
    slug: 'regionalization-in-practice',
    series: 'supply-chain-reset',
    position: 2,
    format: 'article',
    headline: tr('Regionalization in practice'),
    standfirst: tr(
      'Three manufacturers, three regions, one lesson: move the planning before the plants.',
    ),
    topics: ['supply-chain', 'geostrategy'],
    audiences: ['ceo'],
    hero: 'hero-factory.png',
    daysAgo: 95,
    regions: ['apac'],
  },
  {
    slug: 'supplier-risk-signals',
    series: 'supply-chain-reset',
    position: 3,
    format: 'article',
    headline: tr('Early warning: reading supplier risk signals'),
    standfirst: tr(
      'Payment terms, hiring and shipping data warn of supplier distress months before a missed delivery.',
    ),
    topics: ['supply-chain', 'ai-and-data'],
    hero: 'hero-port.png',
    daysAgo: 40,
  },
];

/** The long tail: one article per (topic, angle), with deterministic variety in shape. */
const ANGLES = [
  [
    'Five moves for',
    'The leaders getting {t} right share five habits, and none of them is a technology choice.',
  ],
  [
    'What CFOs need to know about',
    'The numbers behind {t}, and the three decisions finance teams cannot delegate.',
  ],
  [
    'Getting {t} past the pilot',
    'Most programmes stall between proof of concept and scale. The difference is ownership.',
  ],
  [
    'How regulators now see',
    'Supervisors have moved from principles to examinations on {t}. Here is what they ask for.',
  ],
  [
    'The {t} playbook for 2027',
    'A practical sequence for the next twelve months, with the trade-offs made explicit.',
  ],
] as const;

const LONG_TAIL_TOPICS: readonly [string, string, string][] = [
  ['geostrategy', 'geopolitical risk', 'hero-horizon.png'],
  ['m-and-a', 'deal value creation', 'hero-boardroom.png'],
  ['cloud', 'cloud cost', 'hero-data-grid.png'],
  ['emerging-technology', 'quantum readiness', 'hero-lab.png'],
  ['cybersecurity', 'identity security', 'hero-data-grid.png'],
  ['nature', 'nature-related risk', 'hero-wind-farm.png'],
  ['sustainability-reporting', 'sustainability reporting', 'hero-wind-farm.png'],
  ['financial-crime', 'financial crime', 'hero-trading-floor.png'],
  ['regulatory-change', 'operational resilience', 'hero-trading-floor.png'],
  ['internal-audit', 'internal audit', 'hero-trading-floor.png'],
  ['indirect-tax', 'e-invoicing', 'hero-port.png'],
  ['tax-technology', 'tax data', 'hero-data-grid.png'],
  ['future-of-work', 'hybrid work', 'hero-mentoring.png'],
  ['skills-and-talent', 'reskilling', 'hero-classroom.png'],
  ['transformation', 'transformation', 'hero-factory.png'],
  ['finance-function', 'the finance function', 'hero-trading-floor.png'],
  ['climate', 'decarbonization', 'hero-wind-farm.png'],
  ['ai-and-data', 'generative AI', 'hero-data-grid.png'],
  ['growth-strategy', 'pricing', 'hero-horizon.png'],
  ['supply-chain', 'procurement', 'hero-port.png'],
  ['cybersecurity', 'ransomware recovery', 'hero-data-grid.png'],
  ['m-and-a', 'carve-outs', 'hero-boardroom.png'],
  ['climate', 'carbon markets', 'hero-wind-farm.png'],
  ['ai-and-data', 'AI agents', 'hero-data-grid.png'],
];

const AREAS = ['global', 'americas', 'emeia', 'apac'] as const;
const CHARTS = [
  'chart-ceo-confidence.png',
  'chart-minimum-tax.png',
  'chart-cyber-incidents.png',
] as const;

function longTail(): InsightDef[] {
  return LONG_TAIL_TOPICS.map(([topicSlug, subject, hero], n) => {
    const [lead, stand] = pickOf(ANGLES, n);
    const headline = lead.includes('{t}') ? lead.replace('{t}', subject) : `${lead} ${subject}`;
    const status: Spec['status'] = n % 6 === 5 ? 'draft' : n % 7 === 3 ? 'changed' : 'published';
    return {
      slug: headline
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, ''),
      headline: tr(
        headline.charAt(0).toUpperCase() + headline.slice(1),
        n % 4 === 0
          ? {
              'en-GB': headline
                .replace(/ization/g, 'isation')
                .replace(/^./, (c) => c.toUpperCase()),
            }
          : {},
      ),
      standfirst: tr(stand.replace('{t}', subject)),
      format: n % 4 === 1 ? 'chaptered' : 'article',
      topics: [topicSlug],
      hero,
      daysAgo: 7 + n * 9,
      status,
      area: pickOf(AREAS, n),
      tags: [
        ...(n % 3 === 0 ? ['global-rollout'] : ['local-only']),
        ...(n % 5 === 2 ? ['refresh-due'] : []),
        ...(n % 8 === 6 ? ['ai-assisted', 'translation-pending'] : []),
        ...(topicSlug === 'm-and-a' ? ['sub-brand-vantage'] : []),
      ],
      ...(topicSlug === 'm-and-a' ? { brand: 'vantage' as const } : {}),
    };
  });
}

export const INSIGHTS: readonly InsightDef[] = [...FLAGSHIP, ...SERIES_ARTICLES, ...longTail()];

/** A chaptered, structured body for the master; the chaptered variant adds more chapters. */
function body(def: InsightDef, n: number, related: string | undefined, chart: string | undefined) {
  const chapters = def.format === 'article' ? 2 : 4;
  const blocks = [
    p(def.standfirst.en),
    p(
      'The organizations moving fastest have stopped treating this as a project. ',
      b('They have made it part of how the business is run'),
      ': owned by a named executive, measured every quarter, and funded from the operating budget.',
    ),
  ];
  const headings = [
    'Where things stand',
    'What leaders are doing differently',
    'The trade-offs',
    'What to do next',
  ];
  for (let c = 0; c < chapters; c++) {
    blocks.push(h2(headings[c] as string));
    if (c === 0) {
      blocks.push(
        p(
          `Our research with ${400 + ((n * 37) % 900)} executives shows a widening gap between leaders and the rest.`,
        ),
        table([
          ['Measure', 'Leaders', 'Others'],
          ['Executive owner named', `${70 + (n % 20)}%`, `${30 + (n % 15)}%`],
          ['Measured quarterly', `${55 + (n % 30)}%`, `${20 + (n % 10)}%`],
          ['Funded from operating budget', `${48 + (n % 25)}%`, `${18 + (n % 12)}%`],
        ]),
      );
    } else if (c === 1) {
      blocks.push(
        ul([
          'They start with the decision, not the data.',
          'They fund the change, not just the technology.',
          'They publish what they measure, inside the business and out.',
        ]),
        quote(
          `“The hardest part was not the technology. It was agreeing who decides.” — a chief operating officer interviewed for this research`,
        ),
      );
    } else if (c === 2) {
      blocks.push(
        p(
          'Speed and control pull in opposite directions. The answer is not to pick one, but to decide in advance which decisions need which.',
        ),
        ...(n % 3 === 0 && chart ? [embedAsset(chart)] : []),
      );
    } else {
      blocks.push(
        ol([
          'Name the executive owner and the measures within thirty days.',
          'Run a ninety-day pilot with a decision at the end, not a report.',
          'Fund the scale-up from what the pilot saves.',
        ]),
      );
    }
  }
  blocks.push(
    p(
      'Read more in our ',
      a('/insights', 'latest insights'),
      related ? ', or ' : '.',
      ...(related
        ? [
            {
              nodeType: 'entry-hyperlink',
              data: { target: { id: related, linkType: 'Entry' } },
              content: [{ nodeType: 'text', value: 'a related article', marks: [] }],
            },
            '.',
          ]
        : []),
    ),
    p(i(`This article reflects the views of the authors and not necessarily of ${BRAND.name}.`)),
  );
  return doc(...blocks);
}

export async function seedEnterpriseSeries(run: EnterpriseRun): Promise<void> {
  const { space } = run;
  const terms = await loadTerms(run);
  const files = await assetIdsByFile(run);
  const people = await keysOf(run, 'person');
  const specs: Spec[] = SERIES.map((s) => {
    const cover = files.get(s.kind === 'podcast' ? 'hero-boardroom.png' : 'hero-horizon.png');
    return {
      key: s.slug,
      fields: {
        name: loc(s.name, space),
        slug: one(s.slug, space),
        kind: one(s.kind, space),
        description: loc(s.description, space),
        ...(cover ? { cover: one(asset(cover), space) } : {}),
        ...('hosts' in s
          ? {
              hosts: one(
                s.hosts.map((h) => entry(need(people, h, 'person'))),
                space,
              ),
              platforms: one(
                [
                  { platform: 'apple', url: `https://podcasts.example/${s.slug}` },
                  { platform: 'spotify', url: `https://open.spotify.example/show/${s.slug}` },
                ],
                space,
              ),
            }
          : {}),
        seo: locBuild(s.name, space, (name) => ({ title: `${name} | ${BRAND.name}` })),
      },
    };
  });
  await ensureEntries(run, 'series', specs, terms);
}

/** One batch of insights (the install splits them across phases to fit the D1 budget). */
export async function seedEnterpriseInsights(
  run: EnterpriseRun,
  from: number,
  to: number,
): Promise<void> {
  const { space } = run;
  const now = run.ctx.clock.now();
  const terms = await loadTerms(run);
  const files = await assetIdsByFile(run);
  const people = await keysOf(run, 'person');
  const series = await keysOf(run, 'series');
  const forms = await keysOf(run, 'form', 'name');
  const existing = await keysOf(run, 'insight');
  const corporate = people.get('aldermoor-global');

  const specs: Spec[] = INSIGHTS.slice(from, to).map((def, k) => {
    const n = from + k;
    const authors = [...new Set(def.topics.flatMap(expertsOn))]
      .slice(0, 1 + (n % 3))
      .map((slug) => people.get(slug))
      .filter((id): id is string => !!id);
    const heroId = files.get(def.hero);
    const pdfId = def.pdf ? files.get(def.pdf) : undefined;
    const related = [...existing.values()][n % Math.max(1, existing.size)];
    const masterBody = body(def, n, related, files.get(pickOf(CHARTS, n)));
    const bodies: Record<string, unknown> = { [space.defaultLocale]: masterBody };
    for (const [locale, texts] of Object.entries(def.translatedBody ?? {})) {
      if (space.locales.includes(locale) && locale !== space.defaultLocale && texts) {
        bodies[locale] = paras(...texts);
      }
    }
    const isResearch = def.format === 'report' || def.format === 'survey' || def.format === 'index';
    return {
      key: def.slug,
      status: def.status ?? 'published',
      tags: [
        ...(def.tags ?? []),
        ...(isResearch ? [] : ['sme-reviewed']),
        ...(def.gated ? ['gated'] : []),
      ],
      concepts: [
        ...def.topics.map(topic),
        ...(def.audiences ?? []).map(audience),
        ...(def.regions ?? []).map(region),
      ],
      patch: {
        standfirst: loc({ en: `${def.standfirst.en} Updated with this quarter’s figures.` }, space),
      },
      fields: {
        headline: loc(def.headline, space),
        slug: one(def.slug, space),
        format: one(def.format, space),
        standfirst: loc(def.standfirst, space),
        ...(def.inBrief
          ? {
              inBrief: Object.fromEntries(
                Object.keys(loc(def.inBrief[0] as Tr, space)).map((l) => [
                  l,
                  def.inBrief?.map((x) => loc(x, space)[l] ?? x.en),
                ]),
              ),
            }
          : {}),
        ...(heroId ? { heroImage: one(asset(heroId), space) } : {}),
        authors: one((authors.length ? authors : corporate ? [corporate] : []).map(entry), space),
        ...(n % 4 === 0
          ? { contributors: one(['Research team, Aldermoor Institute', 'Priya Natarajan'], space) }
          : {}),
        ...(def.series ? { series: one(entry(need(series, def.series, 'series')), space) } : {}),
        ...(def.position ? { seriesPosition: one(def.position, space) } : {}),
        readingTime: one(def.format === 'article' ? 5 + (n % 4) : 9 + (n % 7), space),
        tier: one(def.tier ?? 'tier-2', space),
        body: bodies,
        ...(def.edition ? { edition: one(def.edition, space) } : {}),
        ...(def.stats
          ? {
              keyStats: one(
                def.stats.map(([value, unit, label]) => ({
                  value,
                  unit,
                  label,
                  source: `${BRAND.name} Institute`,
                })),
                space,
              ),
            }
          : {}),
        ...(isResearch
          ? {
              methodology: {
                [space.defaultLocale]: doc(
                  p(
                    `The ${BRAND.name} Institute surveyed senior executives between June and August. Results are weighted by region and company size.`,
                  ),
                  p(i('Totals may not add to 100% because of rounding.')),
                ),
              },
            }
          : {}),
        references: one(
          [
            `${BRAND.name} Institute analysis, ${now.getUTCFullYear()}.`,
            'Company disclosures and public filings.',
          ],
          space,
        ),
        ...(pdfId ? { downloads: one([asset(pdfId)], space) } : {}),
        gated: one(!!def.gated, space),
        ...(def.gated && forms.get('CEO Outlook 2027 download')
          ? { gateForm: one(entry(forms.get('CEO Outlook 2027 download') as string), space) }
          : {}),
        ...(n % 5 === 0
          ? {
              faq: {
                [space.defaultLocale]: [
                  {
                    question: 'Who took part in the research?',
                    answer: doc(
                      p('Senior executives at companies with revenue above US$1 billion.'),
                    ),
                  },
                  {
                    question: 'Can I use these figures?',
                    answer: doc(p(`Yes, with attribution to the ${BRAND.name} Institute.`)),
                  },
                ],
              },
            }
          : {}),
        ...(related ? { related: one([entry(related)], space) } : {}),
        area: one(def.area ?? 'global', space),
        brand: one(def.brand ?? 'aldermoor', space),
        displayDate: one(dayOnly(now, -def.daysAgo), space),
        seo: locBuild(def.headline, space, (headline, l) => ({
          title: `${headline} | ${def.brand ? BRAND.subBrand : BRAND.name}`,
          description: (loc(def.standfirst, space)[l] ?? def.standfirst.en).slice(0, 158),
          ...(heroId ? { ogImage: asset(heroId) } : {}),
        })),
      },
    };
  });
  await ensureEntries(run, 'insight', specs, terms);
}

export const INSIGHT_COUNT = INSIGHTS.length;
