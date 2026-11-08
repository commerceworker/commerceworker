import { assetIdsByFile } from './assets';
import { BRAND, loc, locBuild, one, type Tr } from './brand';
import { asset, ensureEntries, entry, keysOf, loadTerms, pickOf, type Spec } from './entries';
import { expertsOn } from './people';
import { b, doc, h2, p, ul } from './rt';
import type { EnterpriseRun } from './run';
import { sector, topic } from './taxonomy';

/**
 * What the firm sells: six service lines, each with sub-services and offerings (the strategy line
 * under the Vantage sub-brand), the industries it serves as a group → sector tree, and five
 * alliance partners. Curation (featured insights and case studies) is filled in later phases, once
 * that content exists.
 */

interface ServiceDef {
  readonly slug: string;
  readonly name: Tr;
  readonly blurb: Tr;
  readonly level: 'line' | 'sub-service' | 'offering';
  readonly parent?: string;
  readonly topics: readonly string[];
  readonly brand?: 'vantage';
  readonly hero?: string;
}

const LINE = (
  slug: string,
  name: Tr,
  blurb: Tr,
  topics: string[],
  extra: Partial<ServiceDef> = {},
): ServiceDef => ({ slug, name, blurb, level: 'line', topics, ...extra });
const SUB = (
  parent: string,
  slug: string,
  name: Tr | string,
  blurb: string,
  topics: string[],
  extra: Partial<ServiceDef> = {},
): ServiceDef => ({
  slug,
  name: typeof name === 'string' ? { en: name } : name,
  blurb: { en: blurb },
  level: 'sub-service',
  parent,
  topics,
  ...extra,
});
const OFFER = (
  parent: string,
  slug: string,
  en: string,
  blurb: string,
  topics: string[],
): ServiceDef => ({
  slug,
  name: { en },
  blurb: { en: blurb },
  level: 'offering',
  parent,
  topics,
});

export const SERVICES: readonly ServiceDef[] = [
  LINE(
    'assurance',
    {
      en: 'Audit and Assurance',
      'de-DE': 'Wirtschaftsprüfung',
      'fr-FR': 'Audit et certification',
      'es-ES': 'Auditoría',
      'ja-JP': '監査・保証',
      'zh-CN': '审计与鉴证',
      'pt-BR': 'Auditoria e asseguração',
      'ar-AE': 'التدقيق والتأكيد',
    },
    {
      en: 'Independent audit and assurance that markets can rely on, from financial statements to sustainability disclosures.',
      'de-DE':
        'Unabhängige Prüfung, auf die sich Märkte verlassen können: vom Jahresabschluss bis zur Nachhaltigkeitsberichterstattung.',
      'fr-FR':
        'Un audit indépendant sur lequel les marchés peuvent s’appuyer, des états financiers aux informations de durabilité.',
      'ja-JP': '財務諸表からサステナビリティ開示まで、市場が信頼できる独立した監査・保証。',
    },
    ['internal-audit', 'sustainability-reporting'],
    { hero: 'hero-trading-floor.png' },
  ),
  SUB(
    'assurance',
    'financial-statement-audit',
    'Financial statement audit',
    'Risk-focused audits that use the whole population of transactions, not a sample.',
    ['internal-audit'],
  ),
  SUB(
    'assurance',
    'sustainability-assurance',
    'Sustainability assurance',
    'Limited and reasonable assurance over emissions, climate and nature disclosures.',
    ['sustainability-reporting', 'climate'],
  ),
  SUB(
    'assurance',
    'internal-audit-services',
    'Internal audit',
    'Co-sourced and outsourced internal audit, from risk assessment to continuous controls monitoring.',
    ['internal-audit'],
  ),
  OFFER(
    'sustainability-assurance',
    'emissions-verification',
    'Emissions verification',
    'Scope 1, 2 and 3 verification against the main greenhouse gas standards.',
    ['climate'],
  ),

  LINE(
    'consulting',
    {
      en: 'Consulting',
      'de-DE': 'Beratung',
      'fr-FR': 'Conseil',
      'es-ES': 'Consultoría',
      'ja-JP': 'コンサルティング',
      'zh-CN': '咨询',
      'pt-BR': 'Consultoria',
      'ar-AE': 'الاستشارات',
    },
    {
      en: 'Transformation that sticks: strategy through to the operating model, the technology and the people who run it.',
      'de-DE':
        'Transformation, die bleibt: von der Strategie über das Betriebsmodell bis zur Technologie und den Menschen.',
      'fr-FR':
        'Des transformations durables, de la stratégie au modèle opérationnel, à la technologie et aux équipes.',
    },
    ['transformation', 'ai-and-data'],
    { hero: 'hero-boardroom.png' },
  ),
  SUB(
    'consulting',
    'ai-and-data-consulting',
    'AI and data',
    'From an AI strategy the board can sign to models in production with the controls regulators expect.',
    ['ai-and-data'],
    {
      name: {
        en: 'AI and data',
        'de-DE': 'KI und Daten',
        'fr-FR': 'IA et données',
        'ja-JP': 'AIとデータ',
      },
    },
  ),
  SUB(
    'consulting',
    'cybersecurity-consulting',
    'Cybersecurity',
    'Resilience programmes, identity, cloud security and incident response, run by people who have done it.',
    ['cybersecurity'],
  ),
  SUB(
    'consulting',
    'finance-transformation',
    'Finance transformation',
    'A faster close, cleaner data and a finance team that spends its time on decisions.',
    ['finance-function'],
  ),
  SUB(
    'consulting',
    'supply-chain-operations',
    'Supply chain and operations',
    'Resilient networks, smarter planning and procurement that holds up under stress.',
    ['supply-chain'],
  ),
  SUB(
    'consulting',
    'people-advisory',
    'People advisory',
    'Workforce strategy, reward, skills and the change management that makes it land.',
    ['future-of-work', 'skills-and-talent'],
  ),
  OFFER(
    'ai-and-data-consulting',
    'ai-governance',
    'AI governance',
    'Inventory, risk-tiering and controls for every model in use, mapped to the main AI regulations.',
    ['ai-and-data', 'regulatory-change'],
  ),
  OFFER(
    'cybersecurity-consulting',
    'managed-detection',
    'Managed detection and response',
    'Around-the-clock detection and response from security operations centres on three continents.',
    ['cybersecurity'],
  ),

  LINE(
    'tax-and-law',
    {
      en: 'Tax and Law',
      'de-DE': 'Steuern und Recht',
      'fr-FR': 'Fiscalité et droit',
      'es-ES': 'Fiscalidad y Legal',
      'ja-JP': '税務・法務',
      'zh-CN': '税务与法律',
      'pt-BR': 'Tributos e Direito',
      'ar-AE': 'الضرائب والقانون',
    },
    {
      en: 'Tax and legal advice that keeps pace with policy, in every jurisdiction you operate in.',
      'de-DE':
        'Steuer- und Rechtsberatung, die mit der Politik Schritt hält, in jeder Jurisdiktion.',
    },
    ['global-minimum-tax', 'indirect-tax'],
    { hero: 'hero-port.png' },
  ),
  SUB(
    'tax-and-law',
    'international-tax',
    'International tax',
    'Global minimum tax readiness, transfer pricing and the structures that hold up to scrutiny.',
    ['global-minimum-tax'],
  ),
  SUB(
    'tax-and-law',
    'indirect-tax-services',
    'Indirect tax',
    'VAT, GST and customs: compliance, recovery and e-invoicing across 120 jurisdictions.',
    ['indirect-tax'],
  ),
  SUB(
    'tax-and-law',
    'tax-technology-services',
    'Tax technology',
    'Data, automation and managed services for the tax function.',
    ['tax-technology'],
  ),
  SUB(
    'tax-and-law',
    'law',
    'Law',
    'Corporate, employment and regulatory legal services, delivered alongside tax.',
    ['regulatory-change'],
  ),
  OFFER(
    'international-tax',
    'pillar-two-readiness',
    'Global minimum tax readiness',
    'Data mapping, effective-tax-rate modelling and filings for the global minimum tax.',
    ['global-minimum-tax'],
  ),

  LINE(
    'strategy-and-transactions',
    {
      en: 'Strategy and Transactions',
      'de-DE': 'Strategie und Transaktionen',
      'fr-FR': 'Stratégie et transactions',
      'ja-JP': '戦略・トランザクション',
      'zh-CN': '战略与交易',
    },
    {
      en: 'Aldermoor Vantage: strategy, deals and restructuring for the moments that define a company.',
      'de-DE':
        'Aldermoor Vantage: Strategie, Transaktionen und Restrukturierung für die entscheidenden Momente.',
    },
    ['m-and-a', 'growth-strategy'],
    { brand: 'vantage', hero: 'hero-horizon.png' },
  ),
  SUB(
    'strategy-and-transactions',
    'corporate-strategy',
    'Corporate strategy',
    'Portfolio strategy, growth bets and the capital allocation behind them.',
    ['growth-strategy'],
    { brand: 'vantage' },
  ),
  SUB(
    'strategy-and-transactions',
    'deals',
    'Deals',
    'Due diligence, valuation and integration on both sides of the table.',
    ['m-and-a'],
    { brand: 'vantage' },
  ),
  SUB(
    'strategy-and-transactions',
    'restructuring',
    'Turnaround and restructuring',
    'Liquidity, stakeholder negotiation and operational turnaround under time pressure.',
    ['m-and-a'],
    { brand: 'vantage' },
  ),

  LINE(
    'technology',
    {
      en: 'Technology',
      'de-DE': 'Technologie',
      'fr-FR': 'Technologie',
      'ja-JP': 'テクノロジー',
      'zh-CN': '技术',
    },
    {
      en: 'Cloud platforms, enterprise systems and managed services, delivered with our alliance partners.',
    },
    ['cloud', 'emerging-technology'],
    { hero: 'hero-data-grid.png' },
  ),
  SUB(
    'technology',
    'cloud-transformation',
    'Cloud transformation',
    'Migration, modernization and the FinOps discipline to keep the bill honest.',
    ['cloud'],
  ),
  SUB(
    'technology',
    'enterprise-systems',
    'Enterprise systems',
    'ERP, CRM and HR platforms implemented to a business case, not a feature list.',
    ['transformation'],
  ),

  LINE(
    'sustainability',
    {
      en: 'Sustainability',
      'de-DE': 'Nachhaltigkeit',
      'fr-FR': 'Développement durable',
      'es-ES': 'Sostenibilidad',
      'ja-JP': 'サステナビリティ',
      'zh-CN': '可持续发展',
      'pt-BR': 'Sustentabilidade',
      'ar-AE': 'الاستدامة',
    },
    {
      en: 'Decarbonization plans that are financeable, reporting that is assurable and nature strategies grounded in data.',
      'ar-AE':
        'خطط لإزالة الكربون قابلة للتمويل، وتقارير قابلة للتأكيد، واستراتيجيات للطبيعة قائمة على البيانات.',
    },
    ['climate', 'nature'],
    { hero: 'hero-wind-farm.png' },
  ),
  SUB(
    'sustainability',
    'decarbonization',
    'Decarbonization',
    'Transition plans with the capital, supply chain and technology choices worked through.',
    ['climate'],
  ),
  SUB(
    'sustainability',
    'sustainability-reporting-services',
    'Sustainability reporting',
    'Double materiality, disclosures and the data systems behind them.',
    ['sustainability-reporting'],
  ),
  SUB(
    'sustainability',
    'nature-strategy',
    'Nature and biodiversity',
    'Nature-related risk assessment and target-setting, from site to portfolio.',
    ['nature'],
  ),
];

interface IndustryDef {
  readonly slug: string;
  readonly name: Tr;
  readonly level: 'group' | 'sector';
  readonly parent?: string;
  readonly sector: string;
  readonly hero?: string;
}

const GROUP = (slug: string, name: Tr, sectorSlug: string, hero?: string): IndustryDef => ({
  slug,
  name,
  level: 'group',
  sector: sectorSlug,
  ...(hero ? { hero } : {}),
});
const SECTOR = (parent: string, slug: string, name: Tr, sectorSlug: string): IndustryDef => ({
  slug,
  name,
  level: 'sector',
  parent,
  sector: sectorSlug,
});

export const INDUSTRIES: readonly IndustryDef[] = [
  GROUP(
    'financial-services',
    {
      en: 'Financial services',
      'de-DE': 'Finanzdienstleistungen',
      'fr-FR': 'Services financiers',
      'ja-JP': '金融サービス',
      'zh-CN': '金融服务',
    },
    'financial-services',
    'hero-trading-floor.png',
  ),
  SECTOR(
    'financial-services',
    'banking-capital-markets',
    { en: 'Banking and capital markets', 'de-DE': 'Banken und Kapitalmärkte' },
    'banking',
  ),
  SECTOR(
    'financial-services',
    'insurance-industry',
    { en: 'Insurance', 'de-DE': 'Versicherungen', 'fr-FR': 'Assurance' },
    'insurance',
  ),
  SECTOR(
    'financial-services',
    'wealth-asset-management',
    { en: 'Wealth and asset management', 'de-CH': 'Vermögensverwaltung' },
    'wealth',
  ),
  GROUP(
    'consumer-health',
    { en: 'Consumer and health', 'fr-FR': 'Consommation et santé' },
    'consumer-and-health',
    'hero-lab.png',
  ),
  SECTOR(
    'consumer-health',
    'consumer-retail',
    { en: 'Consumer products and retail', 'es-ES': 'Consumo y distribución' },
    'consumer',
  ),
  SECTOR(
    'consumer-health',
    'life-sciences-industry',
    { en: 'Life sciences', 'de-CH': 'Life Sciences' },
    'life-sciences',
  ),
  GROUP(
    'energy-resources',
    { en: 'Energy and resources', 'pt-BR': 'Energia e recursos', 'ar-AE': 'الطاقة والموارد' },
    'energy-and-resources',
    'hero-wind-farm.png',
  ),
  SECTOR(
    'energy-resources',
    'power-utilities',
    { en: 'Power and utilities', 'pt-BR': 'Energia e utilities' },
    'power',
  ),
  SECTOR('energy-resources', 'mining-metals', { en: 'Mining and metals' }, 'mining'),
  GROUP(
    'tmt',
    { en: 'Technology, media and telecom', 'ja-JP': 'テクノロジー・メディア・通信' },
    'tmt',
    'hero-data-grid.png',
  ),
  SECTOR(
    'tmt',
    'telecommunications-industry',
    { en: 'Telecommunications', 'ja-JP': '通信' },
    'telecommunications',
  ),
  GROUP(
    'industrials',
    { en: 'Industrials', 'de-DE': 'Industrie' },
    'industrials',
    'hero-factory.png',
  ),
  SECTOR(
    'industrials',
    'automotive-mobility',
    {
      en: 'Automotive and mobility',
      'de-DE': 'Automobil und Mobilität',
      'ja-JP': '自動車・モビリティ',
    },
    'mobility',
  ),
  GROUP(
    'public-sector',
    { en: 'Government and public sector', 'ar-AE': 'الحكومة والقطاع العام' },
    'public-sector',
  ),
];

export const ALLIANCES = [
  {
    slug: 'northgrid-cloud',
    name: 'Northgrid Cloud',
    logo: 'logo-northgrid.png',
    what: 'a hyperscale cloud provider',
    offerings: ['cloud-transformation'],
  },
  {
    slug: 'quillon-data',
    name: 'Quillon Data',
    logo: 'logo-quillon.png',
    what: 'a data and analytics platform',
    offerings: ['ai-and-data-consulting', 'ai-governance'],
  },
  {
    slug: 'halcyon-erp',
    name: 'Halcyon ERP',
    logo: 'logo-halcyon.png',
    what: 'an enterprise resource planning suite',
    offerings: ['enterprise-systems', 'finance-transformation'],
  },
  {
    slug: 'sentrix-security',
    name: 'Sentrix Security',
    logo: 'logo-sentrix.png',
    what: 'a security operations platform',
    offerings: ['managed-detection'],
  },
  {
    slug: 'verdant-ledger',
    name: 'Verdant Ledger',
    logo: 'logo-verdant.png',
    what: 'a carbon accounting platform',
    offerings: ['emissions-verification', 'decarbonization'],
  },
] as const;

const FAQ_BANK = [
  [
    'How do you price an engagement?',
    'Most work is scoped to outcomes with a fixed fee per phase; we agree the measures before we start.',
  ],
  [
    'Can you work alongside our internal team?',
    'Yes. Most programmes are co-delivered, and we plan the hand-over from the first week.',
  ],
  [
    'Which regions do you cover?',
    'Every market we have an office in, and through member firms in 64 countries.',
  ],
  [
    'How do you manage independence?',
    'For audit clients, every proposal is checked against the independence rules before it is made.',
  ],
] as const;

const faq = (n: number) =>
  [0, 1, 2].map((k) => {
    const [q, a] = pickOf(FAQ_BANK, n + k);
    return { question: q, answer: doc(p(a)) };
  });

/** Services (`services`), or industries and alliances (`industries`): one phase each. */
export async function seedEnterpriseOfferings(
  run: EnterpriseRun,
  part: 'services' | 'industries',
): Promise<void> {
  const { space } = run;
  const terms = await loadTerms(run);
  const files = await assetIdsByFile(run);
  const people = await keysOf(run, 'person');
  const hero = (file: string | undefined, headline: string, sub: string) => {
    const image = file ? files.get(file) : undefined;
    return {
      variant: 'banner',
      headline,
      subhead: sub,
      ...(image ? { image: asset(image) } : {}),
      ctaLabel: 'Talk to us',
      ctaUrl: '/en-US/contact',
    };
  };

  // Lines first, so sub-services and offerings can name their parent.
  const services = await keysOf(run, 'service');
  for (const level of part === 'services' ? (['line', 'sub-service', 'offering'] as const) : []) {
    const specs: Spec[] = SERVICES.filter((s) => s.level === level).map((s, n) => {
      const team = s.topics
        .flatMap(expertsOn)
        .slice(0, 4)
        .map((slug) => people.get(slug))
        .filter((id): id is string => !!id)
        .map(entry);
      const parentId = s.parent ? services.get(s.parent) : undefined;
      const heroFile = s.hero ?? SERVICES.find((x) => x.slug === s.parent)?.hero;
      return {
        key: s.slug,
        concepts: s.topics.map(topic),
        tags: s.brand ? ['sub-brand-vantage', 'global-rollout'] : ['global-rollout'],
        status: n === 5 && level === 'sub-service' ? 'changed' : 'published',
        patch: {
          shortDescription: loc(
            { en: `${s.blurb.en} Updated for the 2027 planning cycle.` },
            space,
          ),
        },
        fields: {
          name: loc(s.name, space),
          slug: one(s.slug, space),
          level: one(s.level, space),
          ...(parentId ? { parent: one(entry(parentId), space) } : {}),
          shortDescription: loc(s.blurb, space),
          hero: locBuild(s.name, space, (name, l) =>
            hero(heroFile, name, loc(s.blurb, space)[l] ?? s.blurb.en),
          ),
          intro: {
            [space.defaultLocale]: doc(
              p(s.blurb.en),
              h2('Where we help'),
              ul([
                `Diagnose: an independent view of where ${s.name.en.toLowerCase()} stands today.`,
                'Design: a plan with the business case, the risks and the sequence agreed.',
                'Deliver: teams that stay until the change is running, then hand it over.',
              ]),
              p(b(`${BRAND.name} ${s.name.en}`), ` works with clients in every sector we serve.`),
            ),
          },
          ...(team.length ? { team: one(team, space) } : {}),
          faq: { [space.defaultLocale]: faq(n) },
          area: one('global', space),
          brand: one(s.brand ?? 'aldermoor', space),
          seo: locBuild(s.name, space, (name, l) => ({
            title: `${name} | ${s.brand ? BRAND.subBrand : BRAND.name}`,
            description: (loc(s.blurb, space)[l] ?? s.blurb.en).slice(0, 155),
          })),
        },
      };
    });
    for (const [k, v] of await ensureEntries(run, 'service', specs, terms)) services.set(k, v);
  }

  if (part === 'services') return;
  const industries = await keysOf(run, 'industry');
  for (const level of ['group', 'sector'] as const) {
    const specs: Spec[] = INDUSTRIES.filter((i) => i.level === level).map((ind, n) => {
      const parentId = ind.parent ? industries.get(ind.parent) : undefined;
      const heroFile = ind.hero ?? INDUSTRIES.find((x) => x.slug === ind.parent)?.hero;
      const related = SERVICES.filter((s) => s.level === 'line')
        .slice(n % 3, (n % 3) + 3)
        .map((s) => services.get(s.slug))
        .filter((id): id is string => !!id)
        .map(entry);
      return {
        key: ind.slug,
        concepts: [sector(ind.sector)],
        tags: ['global-rollout'],
        fields: {
          name: loc(ind.name, space),
          slug: one(ind.slug, space),
          level: one(ind.level, space),
          ...(parentId ? { parent: one(entry(parentId), space) } : {}),
          shortDescription: loc(
            {
              en: `How ${BRAND.name} helps ${ind.name.en.toLowerCase()} organizations grow, transform and stay resilient.`,
            },
            space,
          ),
          hero: {
            [space.defaultLocale]: hero(
              heroFile,
              ind.name.en,
              `Insight and experience across ${ind.name.en.toLowerCase()}.`,
            ),
          },
          intro: {
            [space.defaultLocale]: doc(
              p(
                `${ind.name.en} leaders face three pressures at once: cost, regulation and a customer who expects more each year.`,
              ),
              p(
                `Our ${ind.name.en.toLowerCase()} teams combine sector specialists with the firm’s service lines.`,
              ),
            ),
          },
          keyStats: one(
            [
              {
                value: String(40 + ((n * 7) % 50)),
                unit: '%',
                label: 'of executives plan to increase investment',
                source: `${BRAND.name} CEO Outlook 2027`,
              },
              {
                value: String(3 + (n % 5)),
                unit: 'x',
                label: 'faster value for digital leaders',
                source: `${BRAND.name} Institute analysis`,
              },
            ],
            space,
          ),
          ...(related.length ? { relatedServices: one(related, space) } : {}),
          area: one('global', space),
          brand: one('aldermoor', space),
        },
      };
    });
    for (const [k, v] of await ensureEntries(run, 'industry', specs, terms)) industries.set(k, v);
  }

  const allianceSpecs: Spec[] = ALLIANCES.map((a) => {
    const logo = files.get(a.logo);
    return {
      key: a.slug,
      concepts: [topic('emerging-technology')],
      fields: {
        name: one(a.name, space),
        slug: one(a.slug, space),
        ...(logo ? { logo: one(asset(logo), space) } : {}),
        summary: loc(
          {
            en: `${BRAND.name} and ${a.name}, ${a.what}, deliver joint solutions to shared clients.`,
          },
          space,
        ),
        body: {
          [space.defaultLocale]: doc(
            p(
              `Our alliance with ${a.name} pairs ${a.what} with ${BRAND.name}’s industry and implementation teams.`,
            ),
            ul([
              'Joint go-to-market in 30 countries',
              'Certified practitioners across our consulting teams',
              'Co-developed accelerators for regulated industries',
            ]),
          ),
        },
        offerings: one(
          a.offerings
            .map((s) => services.get(s))
            .filter((id): id is string => !!id)
            .map(entry),
          space,
        ),
        website: one(`https://www.${a.slug}.example`, space),
      },
    };
  });
  await ensureEntries(run, 'alliance', allianceSpecs, terms);
}
