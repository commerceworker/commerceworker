import { assetIdsByFile } from './assets';
import { BRAND, loc, locBuild, one, type Tr } from './brand';
import {
  asset,
  dayOffset,
  dayOnly,
  ensureEntries,
  entry,
  keysOf,
  loadTerms,
  pickOf,
  type Spec,
} from './entries';
import { OFFICES, PEOPLE } from './people';
import { b, doc, h2, p } from './rt';
import type { EnterpriseRun } from './run';
import { sector, topic } from './taxonomy';

/**
 * Case studies (challenge, approach, outcome; client named only with clearance, anonymized
 * otherwise; some co-delivered with an alliance partner) and the newsroom: a year of press
 * releases with datelines, highlights, spokesperson quotes, notes to editors and embargoes.
 */

interface CaseDef {
  readonly slug: string;
  readonly title: Tr;
  readonly client?: string;
  readonly descriptor: string;
  readonly industry: string;
  readonly sectorSlug: string;
  readonly services: readonly string[];
  readonly alliance?: string;
  readonly topics: readonly string[];
  readonly challenge: string;
  readonly approach: string;
  readonly outcome: string;
  readonly stats: readonly (readonly [string, string, string])[];
  readonly hero: string;
  readonly status?: Spec['status'];
}

export const CASES: readonly CaseDef[] = [
  {
    slug: 'regional-bank-close-in-three-days',
    title: {
      en: 'How a regional bank closed its books in three days',
      'de-DE': 'Wie eine Regionalbank ihren Abschluss in drei Tagen erstellt',
    },
    descriptor: 'A regional bank in Northern Europe',
    industry: 'banking-capital-markets',
    sectorSlug: 'banking',
    services: ['finance-transformation'],
    alliance: 'halcyon-erp',
    topics: ['finance-function'],
    challenge:
      'A twelve-day close, three ledgers and a regulator asking for daily liquidity reporting.',
    approach:
      'One ledger on a new ERP, reconciliations automated end to end, and a close calendar rebuilt around exceptions.',
    outcome: 'A three-day close, daily liquidity reporting and 40% fewer manual journals.',
    stats: [
      ['3', 'days', 'to close, from 12'],
      ['40', '%', 'fewer manual journals'],
    ],
    hero: 'hero-trading-floor.png',
  },
  {
    slug: 'insurer-ai-claims-triage',
    title: { en: 'An insurer puts AI to work on claims, with controls the regulator signed off' },
    client: 'Halvard Mutual',
    descriptor: 'A mutual insurer',
    industry: 'insurance-industry',
    sectorSlug: 'insurance',
    services: ['ai-and-data-consulting', 'ai-governance'],
    alliance: 'quillon-data',
    topics: ['ai-and-data'],
    challenge:
      'Claims backlogs had doubled, and every automation proposal stalled at model risk review.',
    approach:
      'A governed triage model with human review on every denial, and a model inventory the risk team owns.',
    outcome:
      'Simple claims settled in a day; complex ones reach an adjuster with the file already assembled.',
    stats: [
      ['1', 'day', 'to settle simple claims'],
      ['28', '%', 'lower handling cost'],
    ],
    hero: 'hero-data-grid.png',
  },
  {
    slug: 'utility-grid-decarbonization-plan',
    title: {
      en: 'A utility’s decarbonization plan, financed',
      'pt-BR': 'O plano de descarbonização de uma concessionária, financiado',
    },
    descriptor: 'A power utility in Brazil',
    industry: 'power-utilities',
    sectorSlug: 'power',
    services: ['decarbonization'],
    alliance: 'verdant-ledger',
    topics: ['climate'],
    challenge: 'A net-zero target investors liked, and no plan lenders would fund.',
    approach:
      'An asset-by-asset transition plan with the capital programme, tariffs and supply chain worked through.',
    outcome:
      'A green bond priced inside the utility’s conventional curve, and a plan the auditor could test.',
    stats: [
      ['1.8', 'bn', 'green financing raised'],
      ['46', '%', 'emissions cut by 2032'],
    ],
    hero: 'hero-wind-farm.png',
  },
  {
    slug: 'retailer-supply-chain-resilience',
    title: {
      en: 'A retailer rebuilds its supply chain for disruption',
      'es-ES': 'Un minorista reconstruye su cadena de suministro ante la disrupción',
    },
    descriptor: 'A European fashion retailer',
    industry: 'consumer-retail',
    sectorSlug: 'consumer',
    services: ['supply-chain-operations'],
    topics: ['supply-chain'],
    challenge: 'Two seasons of late stock and markdowns, with 70% of volume from one region.',
    approach:
      'Dual sourcing for core lines, nearshore capacity for fast fashion, and planning moved to weekly cycles.',
    outcome: 'On-shelf availability back above 95% and markdowns down a third.',
    stats: [
      ['95', '%', 'on-shelf availability'],
      ['33', '%', 'fewer markdowns'],
    ],
    hero: 'hero-port.png',
  },
  {
    slug: 'automaker-carve-out',
    title: {
      en: 'Carving out a components business in nine months',
      'de-DE': 'Carve-out eines Zuliefergeschäfts in neun Monaten',
    },
    client: 'Rennfeld Automotive',
    descriptor: 'A German automaker',
    industry: 'automotive-mobility',
    sectorSlug: 'mobility',
    services: ['deals', 'restructuring'],
    topics: ['m-and-a'],
    challenge: 'A components division to separate, with 40 shared systems and a buyer waiting.',
    approach:
      'A separation office, transitional services priced line by line, and day-one readiness rehearsed twice.',
    outcome: 'Closed on schedule with no disruption to production.',
    stats: [
      ['9', 'months', 'from signing to close'],
      ['0', '', 'production days lost'],
    ],
    hero: 'hero-factory.png',
  },
  {
    slug: 'telco-cyber-recovery',
    title: {
      en: 'A telecom operator rehearses its way to faster recovery',
      'ja-JP': '通信事業者、訓練で復旧を加速',
    },
    descriptor: 'A telecom operator in Japan',
    industry: 'telecommunications-industry',
    sectorSlug: 'telecommunications',
    services: ['cybersecurity-consulting', 'managed-detection'],
    alliance: 'sentrix-security',
    topics: ['cybersecurity'],
    challenge: 'A ransomware scare showed recovery plans that existed only on paper.',
    approach:
      'Quarterly crisis simulations with the board, immutable backups and a recovery runbook per service.',
    outcome: 'Recovery time for critical services cut from 19 days to 4 in the next live test.',
    stats: [
      ['4', 'days', 'to recover critical services'],
      ['4', '', 'board simulations a year'],
    ],
    hero: 'hero-data-grid.png',
  },
  {
    slug: 'ministry-digital-services',
    title: {
      en: 'A ministry moves 120 services online',
      'ar-AE': 'وزارة تنقل 120 خدمة إلى الإنترنت',
    },
    descriptor: 'A government ministry in the Gulf',
    industry: 'public-sector',
    sectorSlug: 'public-sector',
    services: ['cloud-transformation'],
    alliance: 'northgrid-cloud',
    topics: ['transformation', 'cloud'],
    challenge: 'Citizens visited an office for 80% of transactions.',
    approach:
      'A service catalogue redesigned around life events, on a sovereign cloud, released in waves.',
    outcome: '120 services online, with satisfaction scores up 31 points.',
    stats: [
      ['120', '', 'services online'],
      ['31', 'pts', 'higher satisfaction'],
    ],
    hero: 'hero-horizon.png',
  },
  {
    slug: 'pharma-tax-operating-model',
    title: { en: 'A pharmaceutical group readies for the minimum tax' },
    descriptor: 'A global life sciences company',
    industry: 'life-sciences-industry',
    sectorSlug: 'life-sciences',
    services: ['international-tax', 'pillar-two-readiness', 'tax-technology-services'],
    topics: ['global-minimum-tax', 'tax-technology'],
    challenge: 'Data for 140 entities in 60 countries, and the first filing a year away.',
    approach:
      'A tax data model on the existing ERP, effective-rate calculations automated, and a managed filing service.',
    outcome: 'First filings on time, with the calculation reviewed by the audit committee.',
    stats: [
      ['140', '', 'entities in scope'],
      ['60', '', 'countries'],
    ],
    hero: 'hero-lab.png',
  },
  {
    slug: 'miner-nature-strategy',
    title: { en: 'A miner sets nature targets it can measure' },
    descriptor: 'A mining company in Australia',
    industry: 'mining-metals',
    sectorSlug: 'mining',
    services: ['nature-strategy', 'sustainability-reporting-services'],
    topics: ['nature', 'sustainability-reporting'],
    challenge: 'Investors asked for nature disclosures the company had no baseline for.',
    approach:
      'Site-level biodiversity baselines from satellite and field data, and targets tied to each mine plan.',
    outcome: 'Its first nature disclosure, with limited assurance over the key metrics.',
    stats: [
      ['14', '', 'sites with baselines'],
      ['1', 'st', 'assured nature disclosure'],
    ],
    hero: 'hero-wind-farm.png',
  },
  {
    slug: 'asset-manager-sustainability-assurance',
    title: {
      en: 'An asset manager gets its sustainability data assured',
      'fr-FR': 'Un gestionnaire d’actifs fait certifier ses données de durabilité',
      'fr-CA': 'Un gestionnaire d’actifs fait certifier ses données de durabilité',
    },
    descriptor: 'An asset manager in Canada',
    industry: 'wealth-asset-management',
    sectorSlug: 'wealth',
    services: ['sustainability-assurance'],
    topics: ['sustainability-reporting'],
    challenge: 'Fund-level sustainability claims under new rules, and data from 30 sources.',
    approach: 'A controls framework over the data, tested before the first assurance engagement.',
    outcome: 'Reasonable assurance over fund-level metrics in year one.',
    stats: [['30', '', 'data sources brought under control']],
    hero: 'hero-trading-floor.png',
  },
  {
    slug: 'manufacturer-internal-audit-analytics',
    title: { en: 'Continuous auditing at an industrial group' },
    descriptor: 'An industrial group in Italy',
    industry: 'industrials',
    sectorSlug: 'industrials',
    services: ['internal-audit-services'],
    topics: ['internal-audit'],
    challenge: 'An audit plan built on samples, and findings that arrived months after the fact.',
    approach:
      'Continuous controls monitoring on procurement and payroll, with analytics run weekly.',
    outcome: 'Issues found within a week, and audit coverage up from 12% to 100% of transactions.',
    stats: [['100', '%', 'of transactions covered']],
    hero: 'hero-factory.png',
    status: 'draft',
  },
  {
    slug: 'bank-financial-crime-transformation',
    title: {
      en: 'Fewer false alarms, more real cases',
      'en-GB': 'Fewer false alarms, more real cases',
    },
    client: 'Corvel Bank',
    descriptor: 'A UK bank',
    industry: 'banking-capital-markets',
    sectorSlug: 'banking',
    services: ['ai-and-data-consulting'],
    topics: ['financial-crime'],
    challenge: 'Ninety-eight percent of transaction monitoring alerts were false positives.',
    approach: 'Network analytics and a risk-scored queue, validated with the bank’s second line.',
    outcome: 'False positives halved and twice as many suspicious activity reports filed.',
    stats: [
      ['50', '%', 'fewer false positives'],
      ['2', 'x', 'more reports filed'],
    ],
    hero: 'hero-trading-floor.png',
    status: 'changed',
  },
];

interface ReleaseDef {
  readonly slug: string;
  readonly headline: Tr;
  readonly sub: Tr;
  readonly daysAgo: number;
  readonly city: string;
  readonly spokesperson: string;
  readonly topics: readonly string[];
  readonly embargoInDays?: number;
  readonly issuer?: string;
  readonly report?: string;
  readonly market?: string;
}

const R = (
  slug: string,
  headline: Tr,
  sub: string,
  daysAgo: number,
  city: string,
  spokesperson: string,
  topics: string[],
  extra: Partial<ReleaseDef> = {},
): ReleaseDef => ({
  slug,
  headline,
  sub: { en: sub },
  daysAgo,
  city,
  spokesperson,
  topics,
  ...extra,
});

export const RELEASES: readonly ReleaseDef[] = [
  R(
    'ceo-outlook-2027-launch',
    {
      en: 'Two-thirds of CEOs expect growth in 2027, Aldermoor CEO Outlook finds',
      'de-DE': 'Zwei Drittel der CEOs erwarten 2027 Wachstum, zeigt der Aldermoor CEO Outlook',
      'ja-JP': 'CEOの3分の2が2027年の成長を予想：Aldermoor CEOアウトルック',
      'fr-FR':
        'Deux tiers des dirigeants prévoient une croissance en 2027, selon le CEO Outlook d’Aldermoor',
    },
    'Geopolitics overtakes inflation as the top risk; AI investment now funded from savings.',
    -9,
    'london',
    'amara-okafor',
    ['growth-strategy', 'geostrategy'],
    { embargoInDays: 9, report: 'ceo-outlook-2027', issuer: 'aldermoor-global' },
  ),
  R(
    'global-revenues-fy2026',
    {
      en: 'Aldermoor reports global revenues of US$52.3 billion for fiscal 2026',
      'de-DE':
        'Aldermoor meldet für das Geschäftsjahr 2026 einen weltweiten Umsatz von 52,3 Mrd. US-Dollar',
      'fr-FR':
        'Aldermoor annonce un chiffre d’affaires mondial de 52,3 milliards de dollars pour l’exercice 2026',
      'es-ES':
        'Aldermoor registra unos ingresos globales de 52.300 millones de dólares en el ejercicio 2026',
      'ja-JP': 'Aldermoor、2026年度の全世界売上高523億米ドルを発表',
      'zh-CN': 'Aldermoor公布2026财年全球收入523亿美元',
      'pt-BR': 'Aldermoor reporta receita global de US$ 52,3 bilhões no ano fiscal de 2026',
      'ar-AE': 'Aldermoor تعلن عن إيرادات عالمية بقيمة 52.3 مليار دولار للسنة المالية 2026',
    },
    'Growth of 6.1% in local currency, led by technology consulting and sustainability.',
    38,
    'london',
    'amara-okafor',
    ['growth-strategy'],
    { issuer: 'aldermoor-global' },
  ),
  R(
    'tax-policy-index-wave-6',
    { en: 'Minimum tax now applies in 58 jurisdictions, Aldermoor index shows' },
    'Wave 6 of the Global Tax Policy Index finds data, not rates, is the new compliance bottleneck.',
    21,
    'new-york',
    'rafael-duarte',
    ['global-minimum-tax'],
    { report: 'global-tax-policy-index-wave-6', issuer: 'aldermoor-americas' },
  ),
  R(
    'cyber-resilience-index-2026',
    {
      en: 'Organizations contain cyber incidents twice as fast, but recovery lags',
      'ja-JP': 'サイバー攻撃の封じ込めは2倍速に、復旧は遅れ',
    },
    'Boards that rehearse recover twice as fast, the third Cyber Resilience Index finds.',
    64,
    'new-york',
    'samuel-osei',
    ['cybersecurity'],
    { report: 'cyber-resilience-index-2026' },
  ),
  R(
    'climate-barometer-2026',
    {
      en: 'Climate plans are credible, financing is not, Aldermoor barometer finds',
      'fr-FR':
        'Les plans climat sont crédibles, pas leur financement, selon le baromètre Aldermoor',
    },
    'Only 29% of large companies have committed the capital to deliver their transition plans.',
    102,
    'dubai',
    'layla-haddad',
    ['climate'],
    { report: 'climate-transition-barometer' },
  ),
  R(
    'acquires-brightwater-analytics',
    { en: 'Aldermoor acquires data engineering firm Brightwater Analytics' },
    'The acquisition adds 600 data engineers across North America and Europe.',
    130,
    'new-york',
    'claire-dubois',
    ['ai-and-data'],
  ),
  R(
    'new-uk-managing-partner',
    {
      en: 'Sophie Hartley appointed UK Managing Partner',
      'en-GB': 'Sophie Hartley appointed UK Managing Partner',
    },
    'Hartley succeeds a twelve-year term and takes office on 1 July.',
    160,
    'london',
    'amara-okafor',
    [],
    { market: 'en-GB', issuer: 'aldermoor-emeia' },
  ),
  R(
    'japan-ai-centre',
    {
      en: 'Aldermoor opens AI centre of excellence in Tokyo',
      'ja-JP': 'Aldermoor、東京にAIセンター・オブ・エクセレンスを開設',
    },
    'The centre will employ 300 specialists by 2028.',
    75,
    'tokyo',
    'hiroshi-sato',
    ['ai-and-data'],
    { market: 'ja-JP' },
  ),
  R(
    'germany-audit-reform',
    {
      en: 'Aldermoor welcomes German audit reform proposals',
      'de-DE': 'Aldermoor begrüßt Vorschläge zur Reform der Abschlussprüfung',
    },
    'The firm supports mandatory rotation of key audit partners every five years.',
    55,
    'frankfurt',
    'katharina-vogel',
    ['regulatory-change'],
    { market: 'de-DE' },
  ),
  R(
    'brazil-energy-transition-fund',
    {
      en: 'Aldermoor advises on Brazil’s largest energy transition fund',
      'pt-BR': 'Aldermoor assessora o maior fundo de transição energética do Brasil',
    },
    'The fund will finance 4 GW of renewable generation.',
    88,
    'sao-paulo',
    'beatriz-santos',
    ['climate'],
    { market: 'pt-BR' },
  ),
  R(
    'graduate-intake-record',
    { en: 'Aldermoor to hire 14,000 graduates worldwide this year' },
    'A record intake, with a third joining technology and data roles.',
    190,
    'london',
    'ingrid-solberg',
    ['skills-and-talent'],
  ),
  R(
    'impact-report-2026',
    {
      en: 'Aldermoor publishes 2026 Impact Report',
      'de-DE': 'Aldermoor veröffentlicht Impact Report 2026',
    },
    'Emissions down 41% against the 2019 baseline; gender balance among new partners reaches 46%.',
    120,
    'london',
    'layla-haddad',
    ['climate', 'sustainability-reporting'],
    { issuer: 'aldermoor-global' },
  ),
  R(
    'uae-vat-guidance',
    {
      en: 'Aldermoor launches e-invoicing readiness service in the UAE',
      'ar-AE': 'Aldermoor تطلق خدمة الجاهزية للفوترة الإلكترونية في الإمارات',
    },
    'The service helps businesses prepare for mandatory e-invoicing.',
    45,
    'dubai',
    'nadia-farouk',
    ['indirect-tax'],
    { market: 'ar-AE' },
  ),
  R(
    'mexico-financial-crime-lab',
    {
      en: 'Aldermoor opens financial crime lab in Mexico City',
      'es-MX': 'Aldermoor abre un laboratorio contra delitos financieros en la Ciudad de México',
    },
    'The lab brings together 120 specialists serving banks across Latin America.',
    210,
    'mexico-city',
    'maria-gonzalez',
    ['financial-crime'],
    { market: 'es-MX' },
  ),
  R(
    'vantage-deals-outlook',
    { en: 'Aldermoor Vantage: deal volumes set to recover in the second half' },
    'Private equity dry powder and lower rates point to a stronger second half.',
    33,
    'frankfurt',
    'tobias-weber',
    ['m-and-a'],
  ),
  R(
    'board-matters-series',
    { en: 'Aldermoor launches Board Matters webcast series for directors' },
    'Monthly sessions on AI oversight, cyber resilience and climate governance.',
    150,
    'new-york',
    'daniel-park',
    ['ai-and-data'],
  ),
  R(
    'china-supply-chain-survey',
    {
      en: 'Most manufacturers in Greater China plan to add a second region',
      'zh-CN': '大中华区多数制造商计划增设第二个生产区域',
    },
    'A survey of 400 manufacturers finds regionalization accelerating.',
    98,
    'shanghai',
    'lin-zhou',
    ['supply-chain'],
    { market: 'zh-CN' },
  ),
  R(
    'sydney-office-move',
    { en: 'Aldermoor moves Sydney team to new carbon-neutral office' },
    'The new office is designed for hybrid work and certified carbon-neutral.',
    240,
    'sydney',
    'liam-oconnor',
    [],
    { market: 'en-GB' },
  ),
  R(
    'canada-sustainability-assurance',
    {
      en: 'Aldermoor expands sustainability assurance in Canada',
      'fr-CA': 'Aldermoor étend ses services de certification en développement durable au Canada',
    },
    'Fifty new specialists join in Toronto and Montréal.',
    180,
    'montreal',
    'emily-tremblay',
    ['sustainability-reporting'],
    { market: 'fr-CA' },
  ),
  R(
    'quantum-alliance',
    { en: 'Aldermoor and Northgrid Cloud launch quantum readiness programme' },
    'A joint programme to help financial institutions prepare for post-quantum cryptography.',
    60,
    'san-francisco',
    'chen-wei',
    ['emerging-technology', 'cybersecurity'],
  ),
  R(
    'spain-retail-study',
    {
      en: 'Spanish retailers bet on stores as fulfilment hubs',
      'es-ES': 'Los minoristas españoles apuestan por las tiendas como centros logísticos',
    },
    'Three in four plan to fulfil online orders from stores by 2028.',
    115,
    'madrid',
    'elena-ruiz',
    ['supply-chain'],
    { market: 'es-ES' },
  ),
  R(
    'q4-tax-update-embargo',
    { en: 'Aldermoor tax leaders brief on year-end policy changes' },
    'A briefing on the year-end changes affecting multinationals in 30 jurisdictions.',
    -21,
    'new-york',
    'marcus-reid',
    ['global-minimum-tax'],
    { embargoInDays: 21 },
  ),
];

export async function seedEnterpriseCaseStudies(run: EnterpriseRun): Promise<void> {
  const { space } = run;
  const now = run.ctx.clock.now();
  const terms = await loadTerms(run);
  const files = await assetIdsByFile(run);
  const industries = await keysOf(run, 'industry');
  const services = await keysOf(run, 'service');
  const alliances = await keysOf(run, 'alliance');
  const people = await keysOf(run, 'person');

  const specs: Spec[] = CASES.map((c, n) => {
    const image = files.get(c.hero);
    const chapter = (kind: string, headline: string, narrative: string) => ({
      kind,
      headline,
      ...(image ? { image: asset(image) } : {}),
      narrative: doc(
        p(narrative),
        p(
          b('Why it mattered: '),
          'the result changed how the leadership team runs the business, not just one process.',
        ),
      ),
    });
    const industryId = industries.get(c.industry);
    return {
      key: c.slug,
      status: c.status ?? 'published',
      tags: [
        ...(c.client ? ['client-named', 'legal'] : []),
        ...(c.alliance ? ['global-rollout'] : []),
      ],
      concepts: [...c.topics.map(topic), sector(c.sectorSlug)],
      patch: { summary: loc({ en: `${c.outcome} Client approved the updated figures.` }, space) },
      fields: {
        title: loc(c.title, space),
        slug: one(c.slug, space),
        summary: loc({ en: `${c.challenge} ${c.outcome}` }, space),
        clientNamed: one(!!c.client, space),
        ...(c.client
          ? { clientName: one(c.client, space) }
          : { clientDescriptor: one(c.descriptor, space) }),
        ...(industryId ? { industry: one(entry(industryId), space) } : {}),
        services: one(
          c.services
            .map((s) => services.get(s))
            .filter((x): x is string => !!x)
            .map(entry),
          space,
        ),
        ...(c.alliance && alliances.get(c.alliance)
          ? { alliance: one(entry(alliances.get(c.alliance) as string), space) }
          : {}),
        chapters: {
          [space.defaultLocale]: [
            chapter('challenge', 'The better the question', c.challenge),
            chapter('approach', 'The better the answer', c.approach),
            chapter('outcome', 'The better the outcome', c.outcome),
          ],
        },
        outcomeStats: one(
          c.stats.map(([value, unit, label]) => ({ value, unit, label })),
          space,
        ),
        quotes: {
          [space.defaultLocale]: [
            {
              text: 'They stayed until it worked, and then they made sure we could run it without them.',
              name: c.client ? 'Chief Operating Officer' : 'Client executive',
              organization: c.client ?? c.descriptor,
            },
          ],
        },
        team: one(
          [
            pickOf(
              ['claire-dubois', 'chen-wei', 'layla-haddad', 'rafael-duarte', 'tobias-weber'],
              n,
            ),
          ]
            .map((s) => people.get(s))
            .filter((x): x is string => !!x)
            .map(entry),
          space,
        ),
        area: one(pickOf(['global', 'emeia', 'americas', 'apac'], n), space),
        brand: one(c.services.includes('deals') ? 'vantage' : 'aldermoor', space),
        displayDate: one(dayOnly(now, -20 - n * 17), space),
        seo: locBuild(c.title, space, (title) => ({
          title: `${title} | ${BRAND.name}`,
          description: c.outcome.slice(0, 158),
        })),
      },
    };
  });
  await ensureEntries(run, 'caseStudy', specs, terms);
}

export async function seedEnterpriseNewsroom(run: EnterpriseRun): Promise<void> {
  const { space } = run;
  const now = run.ctx.clock.now();
  const terms = await loadTerms(run);
  const people = await keysOf(run, 'person');
  const insights = await keysOf(run, 'insight');
  const disclaimers = await keysOf(run, 'disclaimer', 'internalName');
  const contacts = await keysOf(run, 'mediaContact', 'label');

  const specs: Spec[] = RELEASES.map((r, n) => {
    const office = OFFICES.find((o) => o.slug === r.city);
    const city = (office?.city.en ?? r.city).toUpperCase();
    const releaseDate = dayOnly(now, -r.daysAgo);
    const speaker = PEOPLE.find((x) => x.slug === r.spokesperson);
    const speakerName = speaker?.display ?? `${speaker?.given} ${speaker?.family}`;
    const issuer = people.get(r.issuer ?? 'aldermoor-global');
    const embargoed = r.embargoInDays !== undefined;
    const contact = contacts.get(
      office && ['us', 'ca', 'latam'].includes(office.area)
        ? 'Americas media relations'
        : office && ['jp', 'greater-china', 'sea', 'oceania'].includes(office.area)
          ? 'Asia-Pacific media relations'
          : 'Global media relations',
    );
    const notes = [
      'About Aldermoor (notes to editors)',
      ...(r.report ? ['About the Aldermoor Institute (notes to editors)'] : []),
      ...(r.topics.includes('m-and-a') ? ['Vantage statement'] : []),
    ]
      .map((k) => disclaimers.get(k))
      .filter((x): x is string => !!x)
      .map(entry);
    const dateline = `${city}, ${new Date(`${releaseDate}T00:00:00Z`).toUTCString().slice(5, 16)} –`;
    return {
      key: r.slug,
      status: embargoed ? 'draft' : n % 9 === 4 ? 'changed' : 'published',
      tags: [
        ...(embargoed ? ['embargoed', 'legal'] : []),
        ...(r.market ? ['local-only'] : ['global-rollout']),
        ...(r.slug.startsWith('ceo-outlook') ? ['campaign-ceo-outlook'] : []),
        ...(r.slug === 'impact-report-2026' ? ['campaign-impact-report'] : []),
      ],
      concepts: r.topics.map(topic),
      patch: {
        subheadline: loc({ en: `${r.sub.en} (Corrected figure in paragraph three.)` }, space),
      },
      fields: {
        headline: loc(r.headline, space),
        slug: one(r.slug, space),
        subheadline: loc(r.sub, space),
        releaseDate: one(releaseDate, space),
        datelineCity: one(city, space),
        highlights: one(
          [
            r.sub.en,
            `${BRAND.name} spokesperson: ${speakerName}`,
            'Full findings and methodology online',
          ],
          space,
        ),
        body: locBuild(r.headline, space, (headline) =>
          doc(
            p(b(dateline), ` ${headline}. ${r.sub.en}`),
            p(
              `“${pickOf(['This is a moment for clarity, not caution', 'Our clients are moving faster than ever', 'The evidence is clear, and so is the opportunity'], n)},” said ${speakerName}. “${pickOf(['The organizations that act now will set the terms for everyone else.', 'We are investing so that they can.', 'We will keep publishing what we find.'], n)}”`,
            ),
            h2('About the findings'),
            p(
              'The full results, including the methodology and regional breakdowns, are available on our website.',
            ),
            p('– ends –'),
          ),
        ),
        quotes: {
          [space.defaultLocale]: [
            {
              text: pickOf(
                [
                  'The organizations that act now will set the terms for everyone else.',
                  'We are investing so that our clients can move faster.',
                ],
                n,
              ),
              name: speakerName,
              title: speaker?.title.en ?? '',
              organization: BRAND.name,
            },
          ],
        },
        ...(issuer ? { issuer: one(entry(issuer), space) } : {}),
        notesToEditors: one(notes, space),
        ...(contact ? { mediaContact: one(entry(contact), space) } : {}),
        ...(r.report && insights.get(r.report)
          ? { relatedReport: one(entry(insights.get(r.report) as string), space) }
          : {}),
        embargoed: one(embargoed, space),
        ...(embargoed
          ? { embargoUntil: one(dayOffset(now, r.embargoInDays as number, 6), space) }
          : {}),
        area: one(
          r.market
            ? r.market.startsWith('en-GB') ||
              r.market.startsWith('de') ||
              r.market.startsWith('fr-FR') ||
              r.market.startsWith('es-ES') ||
              r.market === 'ar-AE'
              ? 'emeia'
              : ['ja-JP', 'zh-CN'].includes(r.market)
                ? 'apac'
                : 'americas'
            : 'global',
          space,
        ),
        brand: one(r.topics.includes('m-and-a') ? 'vantage' : 'aldermoor', space),
        displayDate: one(releaseDate, space),
        seo: locBuild(r.headline, space, (headline) => ({
          title: `${headline} | ${BRAND.name} Newsroom`,
          description: r.sub.en.slice(0, 158),
        })),
      },
    };
  });
  await ensureEntries(run, 'pressRelease', specs, terms);
}
