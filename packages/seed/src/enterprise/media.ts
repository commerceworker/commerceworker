import { BRAND, loc, locBuild, one, type Tr } from './brand';
import {
  dayOffset,
  dayOnly,
  ensureEntries,
  entry,
  keysOf,
  loadTerms,
  need,
  type Spec,
} from './entries';
import { OFFICES } from './people';
import { b, doc, h2, p, ul } from './rt';
import type { EnterpriseRun } from './run';
import { topic } from './taxonomy';

/**
 * Events (webcasts with CPE credit and their registration forms, in-person conferences and
 * roundtables with venues, a monthly board series; upcoming ones scheduled ahead, past ones on
 * demand), podcast episodes in two series, and technical bulletins: dated, jurisdiction-tagged
 * tax and accounting alerts that expire.
 */

interface EventDef {
  readonly slug: string;
  readonly title: Tr;
  readonly type: 'webcast' | 'in-person' | 'conference' | 'roundtable';
  readonly inDays: number;
  readonly minutes: number;
  readonly presenters: readonly string[];
  readonly topics: readonly string[];
  readonly cpe?: { credits: number; field: string; level: string };
  readonly office?: string;
  readonly venue?: string;
  readonly promoted?: boolean;
  readonly status?: Spec['status'];
}

export const EVENTS: readonly EventDef[] = [
  {
    slug: 'board-matters-ai-oversight',
    title: {
      en: 'Board Matters: overseeing AI in 2027',
      'de-DE': 'Board Matters: KI-Aufsicht im Jahr 2027',
    },
    type: 'webcast',
    inDays: 6,
    minutes: 60,
    presenters: ['daniel-park', 'natalie-cho'],
    topics: ['ai-and-data'],
    cpe: { credits: 1.2, field: 'specialized-knowledge', level: 'basic' },
    promoted: true,
  },
  {
    slug: 'ceo-outlook-2027-launch-webcast',
    title: {
      en: 'CEO Outlook 2027: the launch briefing',
      'ja-JP': 'CEOアウトルック2027 発表ブリーフィング',
    },
    type: 'webcast',
    inDays: 10,
    minutes: 45,
    presenters: ['amara-okafor', 'daniel-park'],
    topics: ['growth-strategy'],
    promoted: true,
    status: 'draft',
  },
  {
    slug: 'year-end-tax-update',
    title: { en: 'Year-end tax update for multinationals' },
    type: 'webcast',
    inDays: 22,
    minutes: 90,
    presenters: ['marcus-reid', 'rafael-duarte'],
    topics: ['global-minimum-tax'],
    cpe: { credits: 1.8, field: 'taxes', level: 'intermediate' },
  },
  {
    slug: 'sustainability-reporting-forum-frankfurt',
    title: {
      en: 'Sustainability Reporting Forum',
      'de-DE': 'Forum Nachhaltigkeitsberichterstattung',
    },
    type: 'conference',
    inDays: 35,
    minutes: 420,
    presenters: ['katharina-vogel', 'layla-haddad', 'mei-tanaka'],
    topics: ['sustainability-reporting'],
    office: 'frankfurt',
    venue: 'Aldermoor Forum, Mainufer',
  },
  {
    slug: 'cfo-roundtable-london',
    title: { en: 'CFO roundtable: funding AI from savings' },
    type: 'roundtable',
    inDays: 15,
    minutes: 150,
    presenters: ['henrik-lindqvist', 'sophie-hartley'],
    topics: ['finance-function', 'ai-and-data'],
    office: 'london',
    venue: 'Moorgate Square, 12th floor',
  },
  {
    slug: 'cyber-resilience-tokyo',
    title: { en: 'Cyber resilience summit, Tokyo', 'ja-JP': 'サイバーレジリエンス・サミット東京' },
    type: 'in-person',
    inDays: 48,
    minutes: 240,
    presenters: ['yuki-nakamura', 'samuel-osei'],
    topics: ['cybersecurity'],
    office: 'tokyo',
    venue: '丸の内カンファレンスセンター',
  },
  {
    slug: 'board-matters-cyber',
    title: { en: 'Board Matters: rehearsing a cyber crisis' },
    type: 'webcast',
    inDays: -24,
    minutes: 60,
    presenters: ['samuel-osei', 'kevin-brooks'],
    topics: ['cybersecurity'],
    cpe: { credits: 1.2, field: 'information-technology', level: 'basic' },
  },
  {
    slug: 'board-matters-climate',
    title: { en: 'Board Matters: climate governance' },
    type: 'webcast',
    inDays: -55,
    minutes: 60,
    presenters: ['layla-haddad', 'fatima-rahman'],
    topics: ['climate'],
    cpe: { credits: 1.2, field: 'specialized-knowledge', level: 'basic' },
  },
  {
    slug: 'minimum-tax-data-masterclass',
    title: { en: 'Masterclass: minimum tax data', 'pt-BR': 'Masterclass: dados do imposto mínimo' },
    type: 'webcast',
    inDays: -40,
    minutes: 120,
    presenters: ['rafael-duarte', 'kenji-watanabe'],
    topics: ['global-minimum-tax', 'tax-technology'],
    cpe: { credits: 2.4, field: 'taxes', level: 'advanced' },
  },
  {
    slug: 'supply-chain-reset-live',
    title: { en: 'Supply chain reset: live Q&A', 'zh-CN': '供应链重塑：在线问答' },
    type: 'webcast',
    inDays: -70,
    minutes: 45,
    presenters: ['lin-zhou', 'elena-ruiz'],
    topics: ['supply-chain'],
  },
  {
    slug: 'deals-outlook-breakfast',
    title: { en: 'Deals outlook breakfast' },
    type: 'in-person',
    inDays: -18,
    minutes: 120,
    presenters: ['tobias-weber', 'ethan-cole'],
    topics: ['m-and-a'],
    office: 'new-york',
    venue: 'Meridian Plaza, Level 28',
  },
  {
    slug: 'audit-committee-institute-2026',
    title: { en: 'Audit Committee Institute 2026' },
    type: 'conference',
    inDays: -120,
    minutes: 360,
    presenters: ['mei-tanaka', 'priya-raman', 'katharina-vogel'],
    topics: ['internal-audit', 'regulatory-change'],
    office: 'new-york',
    venue: 'Hudson Yards Conference Center',
    cpe: { credits: 6, field: 'auditing', level: 'intermediate' },
  },
];

const EPISODES: readonly {
  series: string;
  title: string;
  guests: readonly string[];
  topics: readonly string[];
  minutes: number;
}[] = [
  {
    series: 'clarity-podcast',
    title: 'What CEOs are really planning for',
    guests: ['amara-okafor'],
    topics: ['growth-strategy'],
    minutes: 34,
  },
  {
    series: 'clarity-podcast',
    title: 'The board and the algorithm',
    guests: ['natalie-cho'],
    topics: ['ai-and-data'],
    minutes: 29,
  },
  {
    series: 'clarity-podcast',
    title: 'Recovering from a cyber attack',
    guests: ['samuel-osei', 'yuki-nakamura'],
    topics: ['cybersecurity'],
    minutes: 41,
  },
  {
    series: 'clarity-podcast',
    title: 'Paying for the transition',
    guests: ['layla-haddad'],
    topics: ['climate'],
    minutes: 37,
  },
  {
    series: 'clarity-podcast',
    title: 'Is hybrid work working?',
    guests: ['ingrid-solberg', 'aisha-thompson'],
    topics: ['future-of-work'],
    minutes: 32,
  },
  {
    series: 'clarity-podcast',
    title: 'Two regions are better than one',
    guests: ['lin-zhou'],
    topics: ['supply-chain'],
    minutes: 28,
  },
  {
    series: 'tax-talks',
    title: 'The minimum tax, one year in',
    guests: ['rafael-duarte'],
    topics: ['global-minimum-tax'],
    minutes: 22,
  },
  {
    series: 'tax-talks',
    title: 'E-invoicing goes global',
    guests: ['nadia-farouk', 'luis-herrera'],
    topics: ['indirect-tax'],
    minutes: 19,
  },
  {
    series: 'tax-talks',
    title: 'Incentives without rate cuts',
    guests: ['julien-moreau'],
    topics: ['global-minimum-tax'],
    minutes: 21,
  },
  {
    series: 'tax-talks',
    title: 'Tax data is the new bottleneck',
    guests: ['kenji-watanabe'],
    topics: ['tax-technology'],
    minutes: 24,
  },
];

const BULLETINS: readonly {
  title: Tr;
  category: string;
  jurisdiction: string;
  topic: string;
  summary: string;
}[] = [
  {
    title: { en: 'United States: final regulations on the corporate alternative minimum tax' },
    category: 'corporate-tax',
    jurisdiction: 'US',
    topic: 'global-minimum-tax',
    summary:
      'Final regulations clarify financial statement income adjustments for consolidated groups.',
  },
  {
    title: { en: 'United States: new reporting for digital asset brokers' },
    category: 'indirect-tax',
    jurisdiction: 'US',
    topic: 'tax-technology',
    summary: 'Brokers must report gross proceeds from digital asset sales from next year.',
  },
  {
    title: { en: 'United Kingdom: multinational top-up tax return deadlines confirmed' },
    category: 'corporate-tax',
    jurisdiction: 'GB',
    topic: 'global-minimum-tax',
    summary: 'HMRC confirms registration and first return deadlines for in-scope groups.',
  },
  {
    title: { en: 'United Kingdom: e-invoicing consultation response' },
    category: 'indirect-tax',
    jurisdiction: 'GB',
    topic: 'indirect-tax',
    summary: 'The government will mandate business-to-business e-invoicing in phases.',
  },
  {
    title: {
      en: 'Germany: mandatory e-invoicing for domestic B2B transactions',
      'de-DE': 'Deutschland: Verpflichtende E-Rechnung im inländischen B2B-Verkehr',
    },
    category: 'indirect-tax',
    jurisdiction: 'DE',
    topic: 'indirect-tax',
    summary: 'Businesses must be able to receive e-invoices now and issue them from 2027.',
  },
  {
    title: {
      en: 'Germany: minimum tax act amended',
      'de-DE': 'Deutschland: Mindeststeuergesetz geändert',
    },
    category: 'corporate-tax',
    jurisdiction: 'DE',
    topic: 'global-minimum-tax',
    summary: 'Amendments align safe harbours with the latest administrative guidance.',
  },
  {
    title: {
      en: 'France: research tax credit reform',
      'fr-FR': 'France : réforme du crédit d’impôt recherche',
    },
    category: 'corporate-tax',
    jurisdiction: 'FR',
    topic: 'global-minimum-tax',
    summary: 'Eligible expenses narrowed; the credit becomes partly refundable.',
  },
  {
    title: {
      en: 'Japan: income inclusion rule guidance updated',
      'ja-JP': '日本：所得合算ルールに関するガイダンスの改訂',
    },
    category: 'corporate-tax',
    jurisdiction: 'JP',
    topic: 'global-minimum-tax',
    summary: 'The National Tax Agency publishes updated Q&A on the income inclusion rule.',
  },
  {
    title: {
      en: 'Japan: qualified invoice system transitional measures',
      'ja-JP': '日本：適格請求書等保存方式の経過措置',
    },
    category: 'indirect-tax',
    jurisdiction: 'JP',
    topic: 'indirect-tax',
    summary:
      'Transitional input tax credit for purchases from non-registered suppliers steps down.',
  },
  {
    title: {
      en: 'Brazil: consumption tax reform regulations published',
      'pt-BR': 'Brasil: publicada a regulamentação da reforma tributária do consumo',
    },
    category: 'indirect-tax',
    jurisdiction: 'BR',
    topic: 'indirect-tax',
    summary: 'Regulations set out the transition to the dual VAT between 2026 and 2033.',
  },
  {
    title: {
      en: 'Brazil: transfer pricing rules aligned with OECD standards',
      'pt-BR': 'Brasil: regras de preços de transferência alinhadas à OCDE',
    },
    category: 'transfer-pricing',
    jurisdiction: 'BR',
    topic: 'global-minimum-tax',
    summary: 'New rules adopt the arm’s length principle for all controlled transactions.',
  },
  {
    title: {
      en: 'UAE: corporate tax registration deadlines',
      'ar-AE': 'الإمارات: المواعيد النهائية للتسجيل في ضريبة الشركات',
    },
    category: 'corporate-tax',
    jurisdiction: 'AE',
    topic: 'global-minimum-tax',
    summary: 'Penalties apply for late registration from the first tax period.',
  },
  {
    title: {
      en: 'UAE: domestic minimum top-up tax introduced',
      'ar-AE': 'الإمارات: فرض ضريبة تكميلية محلية دنيا',
    },
    category: 'corporate-tax',
    jurisdiction: 'AE',
    topic: 'global-minimum-tax',
    summary: 'A 15% domestic minimum top-up tax applies to large multinational groups.',
  },
  {
    title: { en: 'EU: VAT in the digital age package adopted' },
    category: 'indirect-tax',
    jurisdiction: 'EU',
    topic: 'indirect-tax',
    summary: 'Digital reporting requirements and a single VAT registration are phased in.',
  },
  {
    title: { en: 'EU: customs reform agreement reached' },
    category: 'trade',
    jurisdiction: 'EU',
    topic: 'supply-chain',
    summary: 'A new EU customs authority and data hub will be established.',
  },
  {
    title: { en: 'OECD: administrative guidance on the global minimum tax' },
    category: 'corporate-tax',
    jurisdiction: 'OECD',
    topic: 'global-minimum-tax',
    summary: 'New guidance on deferred tax, side-by-side regimes and safe harbours.',
  },
  {
    title: { en: 'OECD: amount B simplified transfer pricing approach' },
    category: 'transfer-pricing',
    jurisdiction: 'OECD',
    topic: 'global-minimum-tax',
    summary: 'A simplified approach for baseline distribution activities is now available.',
  },
  {
    title: { en: 'IFRS: new presentation and disclosure standard effective' },
    category: 'accounting',
    jurisdiction: 'OECD',
    topic: 'finance-function',
    summary:
      'New subtotals in the income statement and disclosures on management-defined measures.',
  },
  {
    title: { en: 'United States: lease accounting practical expedient for private companies' },
    category: 'accounting',
    jurisdiction: 'US',
    topic: 'finance-function',
    summary: 'Private companies may use written terms for common-control arrangements.',
  },
  {
    title: { en: 'United Kingdom: employer national insurance changes' },
    category: 'people-tax',
    jurisdiction: 'GB',
    topic: 'future-of-work',
    summary: 'The secondary threshold falls and the employer rate rises from April.',
  },
];

const slugOf = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

export async function seedEnterpriseEvents(run: EnterpriseRun): Promise<void> {
  const { space } = run;
  const now = run.ctx.clock.now();
  const terms = await loadTerms(run);
  const people = await keysOf(run, 'person');
  const forms = await keysOf(run, 'form', 'name');
  const disclaimers = await keysOf(run, 'disclaimer', 'internalName');
  const registration = forms.get('Webcast registration');
  const cpeDisclaimer = disclaimers.get('CPE sponsor statement (US)');

  const specs: Spec[] = EVENTS.map((e, n) => {
    const starts = dayOffset(
      now,
      e.inDays,
      e.type === 'webcast' ? 15 : 8,
      e.type === 'webcast' ? 0 : 30,
    );
    const ends = new Date(Date.parse(starts) + e.minutes * 60_000).toISOString();
    const office = e.office ? OFFICES.find((o) => o.slug === e.office) : undefined;
    const past = e.inDays < 0;
    return {
      key: e.slug,
      status: e.status ?? (n === 4 ? 'changed' : 'published'),
      tags: [
        ...(e.cpe ? ['cpe'] : []),
        ...(e.slug.startsWith('ceo-outlook') ? ['campaign-ceo-outlook', 'embargoed'] : []),
      ],
      concepts: e.topics.map(topic),
      patch: {
        description: loc({ en: 'Agenda updated: a new panel on the second session.' }, space),
      },
      fields: {
        title: loc(e.title, space),
        slug: one(e.slug, space),
        eventType: one(e.type, space),
        description: loc(
          {
            en: `${e.title.en}: ${e.minutes >= 240 ? 'a day of' : 'a focused session of'} briefings and discussion with ${BRAND.name} partners and guests.`,
          },
          space,
        ),
        startsAt: one(starts, space),
        endsAt: one(ends, space),
        durationMinutes: one(e.minutes, space),
        ...(office
          ? {
              venue: one({ lat: office.lat, lon: office.lon }, space),
              venueName: one(e.venue ?? office.name.en, space),
            }
          : {}),
        presenters: one(
          e.presenters.map((s) => entry(need(people, s, 'person'))),
          space,
        ),
        cpeEligible: one(!!e.cpe, space),
        ...(e.cpe
          ? {
              cpeCredits: one(e.cpe.credits, space),
              fieldOfStudy: one(e.cpe.field, space),
              programLevel: one(e.cpe.level, space),
              ...(cpeDisclaimer ? { cpeDisclaimer: one(entry(cpeDisclaimer), space) } : {}),
            }
          : {}),
        learningObjectives: one(
          [
            'Identify the decisions that sit with the board',
            'Recognize the leading indicators',
            'Apply the framework to your organization',
          ],
          space,
        ),
        ...(registration && !past ? { registrationForm: one(entry(registration), space) } : {}),
        ...(past
          ? { recordingUrl: one(`https://media.${BRAND.domain}/events/${e.slug}`, space) }
          : {}),
        promoted: one(!!e.promoted, space),
        area: one(
          office
            ? ['us', 'ca', 'latam'].includes(office.area)
              ? 'americas'
              : office.area === 'jp'
                ? 'apac'
                : 'emeia'
            : 'global',
          space,
        ),
        brand: one(e.topics.includes('m-and-a') ? 'vantage' : 'aldermoor', space),
        displayDate: one(starts.slice(0, 10), space),
        seo: locBuild(e.title, space, (title) => ({
          title: `${title} | ${BRAND.name} events`,
          noindex: past && n % 2 === 0,
        })),
      },
    };
  });
  await ensureEntries(run, 'event', specs, terms);

  const series = await keysOf(run, 'series');
  const counters: Record<string, number> = {};
  const episodes: Spec[] = EPISODES.map((ep, n) => {
    counters[ep.series] = (counters[ep.series] ?? 0) + 1;
    const number = counters[ep.series] as number;
    const slug = `${ep.series}-s1-e${number}-${slugOf(ep.title)}`;
    return {
      key: slug,
      status: n === EPISODES.length - 1 ? 'draft' : 'published',
      concepts: ep.topics.map(topic),
      fields: {
        title: loc({ en: ep.title }, space),
        slug: one(slug, space),
        series: one(entry(need(series, ep.series, 'series')), space),
        season: one(1, space),
        episode: one(number, space),
        duration: one(`00:${String(ep.minutes).padStart(2, '0')}`, space),
        releasedOn: one(dayOnly(now, -7 * (EPISODES.length - n)), space),
        guests: one(
          ep.guests.map((s) => entry(need(people, s, 'person'))),
          space,
        ),
        showNotes: {
          [space.defaultLocale]: doc(
            p(`In this episode: ${ep.title.toLowerCase()}.`),
            h2('In this episode'),
            ul([
              'Why it matters now',
              'What leaders are doing differently',
              'One thing to do this quarter',
            ]),
            p(b('Transcript'), ' below.'),
          ),
        },
        transcript: loc(
          {
            en: `HOST: Welcome to the show. Today: ${ep.title.toLowerCase()}.\nGUEST: Thanks for having me. Let’s start with what has changed this year…`,
          },
          space,
        ),
        audioUrl: one(`https://media.${BRAND.domain}/podcasts/${slug}.mp3`, space),
        seo: one({ title: `${ep.title} | ${BRAND.name}` }, space),
      },
    };
  });
  await ensureEntries(run, 'podcastEpisode', episodes, terms);
}

export async function seedEnterpriseBulletins(run: EnterpriseRun): Promise<void> {
  const { space } = run;
  const now = run.ctx.clock.now();
  const terms = await loadTerms(run);
  const disclaimers = await keysOf(run, 'disclaimer', 'internalName');
  const general = disclaimers.get('General information (technical)');

  const specs: Spec[] = BULLETINS.map((bt, n) => {
    const slug = slugOf(bt.title.en);
    const published = -3 - n * 6;
    return {
      key: slug,
      status: n === 1 ? 'draft' : n % 8 === 3 ? 'changed' : 'published',
      tags: [
        n % 5 === 4 ? 'refresh-due' : 'sme-reviewed',
        ...(Object.keys(bt.title).length > 1 ? ['global-rollout'] : ['local-only']),
      ],
      concepts: [topic(bt.topic), `Jurisdictions/jurisdiction-${bt.jurisdiction.toLowerCase()}`],
      patch: {
        summary: loc({ en: `${bt.summary} Updated for guidance issued this week.` }, space),
      },
      fields: {
        title: loc(bt.title, space),
        slug: one(slug, space),
        category: one(bt.category, space),
        jurisdiction: one(bt.jurisdiction, space),
        effectiveDate: one(dayOnly(now, 30 + n * 11), space),
        summary: loc({ en: bt.summary }, space),
        body: locBuild(bt.title, space, (title) =>
          doc(
            p(b('What changed: '), bt.summary),
            p(b('Who is affected: '), 'groups with operations or customers in the jurisdiction.'),
            p(b('When: '), `from ${dayOnly(now, 30 + n * 11)}.`),
            h2('What to do now'),
            ul([
              'Confirm whether the change applies to each entity',
              'Update the compliance calendar',
              'Brief the audit committee if the impact is material',
            ]),
            p(title),
          ),
        ),
        ...(general ? { disclaimer: one(entry(general), space) } : {}),
        expiresOn: one(dayOnly(now, 180 + published), space),
        seo: locBuild(bt.title, space, (title) => ({
          title: `${title} | ${BRAND.name} Tax`,
          description: bt.summary.slice(0, 158),
        })),
      },
    };
  });
  await ensureEntries(run, 'technicalBulletin', specs, terms);
}
