import { assetIdsByFile } from './assets';
import { BRAND, BRAND_EMAIL, e164, loc, locBuild, one, type Tr } from './brand';
import { asset, dayOnly, ensureEntries, entry, keysOf, loadTerms, type Spec } from './entries';
import { b, doc, h2, h3, p, paras, ul } from './rt';
import type { EnterpriseRun } from './run';
import { audience, topic } from './taxonomy';

/**
 * The reusable pieces pages are assembled from (disclaimers and notes to editors, media contacts,
 * forms, CTAs) and the pages that change least and matter most: legal notices per jurisdiction,
 * and career areas.
 */

const DISCLAIMERS: readonly { key: string; kind: string; body: Tr; jurisdictions?: string[] }[] = [
  {
    key: 'Network statement',
    kind: 'network',
    body: {
      en: `${BRAND.name} refers to the global organization, and may refer to one or more, of the member firms of ${BRAND.legalName}, each of which is a separate legal entity. ${BRAND.legalName}, a company limited by guarantee, does not provide services to clients.`,
      'de-DE': `${BRAND.name} bezeichnet die globale Organisation und kann sich auf eine oder mehrere Mitgliedsfirmen von ${BRAND.legalName} beziehen, die jeweils rechtlich selbstständig sind. ${BRAND.legalName} erbringt keine Leistungen für Mandanten.`,
      'fr-FR': `${BRAND.name} désigne l’organisation mondiale et peut désigner un ou plusieurs cabinets membres de ${BRAND.legalName}, chacun étant une entité juridique distincte. ${BRAND.legalName} ne fournit aucun service aux clients.`,
      'es-ES': `${BRAND.name} hace referencia a la organización global y puede referirse a una o varias firmas miembro de ${BRAND.legalName}, cada una de ellas una entidad jurídica independiente.`,
      'ja-JP': `${BRAND.name}とは、グローバルな組織を指し、${BRAND.legalName}のメンバーファームの1つまたは複数を指す場合があります。各メンバーファームは法的に独立した組織です。`,
      'zh-CN': `${BRAND.name}指全球组织，也可指${BRAND.legalName}的一家或多家成员机构，每家成员机构均为独立的法律实体。`,
      'pt-BR': `${BRAND.name} refere-se à organização global e pode referir-se a uma ou mais firmas-membro da ${BRAND.legalName}, cada uma delas uma entidade legal independente.`,
      'ar-AE': `تشير ${BRAND.name} إلى المنظمة العالمية، وقد تشير إلى واحدة أو أكثر من الشركات الأعضاء في ${BRAND.legalName}، وكل منها كيان قانوني مستقل.`,
    },
  },
  {
    key: 'Vantage statement',
    kind: 'sub-brand',
    body: {
      en: `${BRAND.subBrand} is the strategy and transactions brand of the ${BRAND.name} organization. Services are provided by ${BRAND.name} member firms.`,
    },
  },
  {
    key: 'About Aldermoor (notes to editors)',
    kind: 'about',
    body: {
      en: `${BRAND.name} is a global professional services organization of 92,000 people in 64 countries, providing audit and assurance, consulting, tax and law, strategy and transactions, technology and sustainability services. Information about how ${BRAND.name} collects and uses personal data is at aldermoor.example/privacy.`,
    },
  },
  {
    key: 'About the Aldermoor Institute (notes to editors)',
    kind: 'about',
    body: {
      en: `The ${BRAND.name} Institute is the firm’s research arm. Its surveys and indexes are designed and analysed independently of client work.`,
    },
  },
  {
    key: 'CPE sponsor statement (US)',
    kind: 'cpe',
    jurisdictions: ['US'],
    body: {
      en: `${BRAND.name} US LLP is registered as a sponsor of continuing professional education on the national registry of CPE sponsors. State boards of accountancy have final authority on the acceptance of individual courses for CPE credit. Refunds and cancellations: webcasts are free of charge; registrants may cancel at any time.`,
    },
  },
  {
    key: 'Illustrative figures',
    kind: 'illustrative',
    body: {
      en: 'Figures in this article are illustrative and based on scenarios; they are not forecasts and should not be relied on for investment decisions.',
    },
  },
  {
    key: 'General information (technical)',
    kind: 'general-information',
    body: {
      en: 'This material has been prepared for general information only and is not intended to be relied upon as accounting, tax, legal or other professional advice. Refer to your advisors for specific advice.',
      'de-DE':
        'Diese Veröffentlichung dient ausschließlich der allgemeinen Information und stellt keine Steuer-, Rechts- oder sonstige fachliche Beratung dar.',
      'ja-JP':
        '本資料は一般的な情報提供のみを目的としており、会計、税務、法律その他の専門的助言を意図したものではありません。',
    },
  },
  {
    key: 'Marketing consent',
    kind: 'consent',
    body: {
      en: `By submitting this form you agree that ${BRAND.name} may contact you about related insights and events. You can unsubscribe at any time. See our privacy statement.`,
    },
  },
];

const CONTACTS = [
  {
    key: 'Global media relations',
    region: 'Global',
    email: BRAND_EMAIL('press'),
    phone: '+44 20 7946 0199',
  },
  {
    key: 'Americas media relations',
    region: 'Americas',
    email: BRAND_EMAIL('press.americas'),
    phone: '+1 212 555 0199',
  },
  {
    key: 'EMEIA media relations',
    region: 'EMEIA',
    email: BRAND_EMAIL('press.emeia'),
    phone: '+44 20 7946 0198',
  },
  {
    key: 'Asia-Pacific media relations',
    region: 'Asia-Pacific',
    email: BRAND_EMAIL('press.apac'),
    phone: '+65 6555 0199',
  },
];

const FORMS: readonly {
  key: string;
  kind: string;
  heading: Tr;
  intro?: Tr;
  success: Tr;
  route: string;
}[] = [
  {
    key: 'Contact us',
    kind: 'contact',
    heading: {
      en: 'How can we help?',
      'de-DE': 'Wie können wir helfen?',
      'fr-FR': 'Comment pouvons-nous vous aider ?',
      'es-ES': '¿Cómo podemos ayudarle?',
      'ja-JP': 'お問い合わせ',
      'zh-CN': '我们能为您做些什么？',
      'pt-BR': 'Como podemos ajudar?',
      'ar-AE': 'كيف يمكننا مساعدتك؟',
    },
    intro: {
      en: 'Tell us a little about your question and the right team will reply within two working days.',
    },
    success: {
      en: 'Thank you. A member of the team will be in touch.',
      'de-DE': 'Vielen Dank. Wir melden uns in Kürze.',
    },
    route: 'contact',
  },
  {
    key: 'Newsletter: The Clarity Brief',
    kind: 'subscribe',
    heading: { en: 'Get The Clarity Brief', 'de-DE': 'The Clarity Brief abonnieren' },
    intro: { en: 'Our best thinking, once a fortnight. No spam, unsubscribe any time.' },
    success: { en: 'You’re subscribed. Look out for a confirmation email.' },
    route: 'newsletter',
  },
  {
    key: 'Webcast registration',
    kind: 'registration',
    heading: { en: 'Register for this webcast', 'ja-JP': 'ウェビナーに登録' },
    success: { en: 'You’re registered. We’ve emailed you a calendar invitation.' },
    route: 'events',
  },
  {
    key: 'CEO Outlook 2027 download',
    kind: 'gated-download',
    heading: {
      en: 'Download the full report',
      'de-DE': 'Den vollständigen Bericht herunterladen',
      'ja-JP': 'レポート全文をダウンロード',
    },
    success: { en: 'Thank you. Your download will start shortly.' },
    route: 'ceo-outlook',
  },
  {
    key: 'Contact a person',
    kind: 'person-contact',
    heading: { en: 'Send a message' },
    success: { en: 'Your message has been sent.' },
    route: 'people',
  },
  {
    key: 'Request for proposal (Germany)',
    kind: 'rfp',
    heading: { en: 'Request a proposal', 'de-DE': 'Angebot anfordern' },
    success: { en: 'Thank you for your request.', 'de-DE': 'Vielen Dank für Ihre Anfrage.' },
    route: 'rfp-de',
  },
];

const CTAS: readonly {
  key: string;
  eyebrow?: Tr;
  heading: Tr;
  body?: Tr;
  label: Tr;
  url: string;
  theme: string;
  image?: string;
}[] = [
  {
    key: 'Subscribe band',
    eyebrow: { en: 'The Clarity Brief' },
    heading: {
      en: 'Stay ahead of what’s next',
      'de-DE': 'Bleiben Sie einen Schritt voraus',
      'fr-FR': 'Gardez une longueur d’avance',
      'ja-JP': '次の一手を、いち早く',
    },
    body: { en: 'Fortnightly insight from our partners and the Aldermoor Institute.' },
    label: { en: 'Subscribe', 'de-DE': 'Abonnieren', 'fr-FR': 'S’abonner', 'ja-JP': '購読する' },
    url: '/newsletter',
    theme: 'brand',
  },
  {
    key: 'CEO Outlook promo',
    eyebrow: { en: 'New research' },
    heading: {
      en: 'CEO Outlook 2027: confidence returns, cautiously',
      'de-DE': 'CEO Outlook 2027: Zuversicht kehrt zurück, vorsichtig',
      'ja-JP': 'CEOアウトルック2027：慎重ながら戻る自信',
    },
    label: { en: 'Read the report' },
    url: '/insights/ceo-outlook-2027',
    theme: 'dark',
    image: 'campaign-ceo-outlook.png',
  },
  {
    key: 'Impact report promo',
    heading: { en: 'Our 2026 Impact Report' },
    body: { en: 'How we measure up on climate, people and governance.' },
    label: { en: 'Explore the report' },
    url: '/impact-report-2026',
    theme: 'light',
    image: 'campaign-impact-report.png',
  },
  {
    key: 'Talk to us',
    heading: { en: 'Talk to one of our partners', 'de-DE': 'Sprechen Sie mit unseren Partnern' },
    label: { en: 'Contact us', 'de-DE': 'Kontakt' },
    url: '/contact',
    theme: 'light',
  },
  {
    key: 'Careers: graduates',
    eyebrow: { en: 'Careers' },
    heading: { en: 'Start your career with purpose' },
    label: { en: 'Explore graduate roles' },
    url: '/careers/graduates',
    theme: 'brand',
    image: 'hero-classroom.png',
  },
  {
    key: 'Webcast series promo',
    heading: { en: 'Board Matters: a monthly webcast for directors' },
    label: { en: 'See upcoming sessions' },
    url: '/events',
    theme: 'dark',
  },
  {
    key: 'Minimum tax tool',
    heading: { en: 'Model your global minimum tax exposure' },
    body: { en: 'An interactive tool from our tax policy team.' },
    label: { en: 'Open the tool' },
    url: '/tools/minimum-tax',
    theme: 'light',
    image: 'chart-minimum-tax.png',
  },
  {
    key: 'Cyber readiness check',
    heading: { en: 'How resilient is your organization?' },
    label: { en: 'Take the 5-minute check' },
    url: '/tools/cyber-readiness',
    theme: 'dark',
  },
];

/** Legal notices: global ones translated, jurisdiction-only ones in their own market only. */
const LEGAL: readonly {
  slug: string;
  kind: string;
  title: Tr;
  jurisdictions?: string[];
  body: Tr[];
  status?: Spec['status'];
}[] = [
  {
    slug: 'privacy',
    kind: 'privacy',
    title: {
      en: 'Privacy statement',
      'de-DE': 'Datenschutzerklärung',
      'fr-FR': 'Déclaration de confidentialité',
      'es-ES': 'Declaración de privacidad',
      'ja-JP': 'プライバシーステートメント',
      'zh-CN': '隐私声明',
      'pt-BR': 'Declaração de privacidade',
      'ar-AE': 'بيان الخصوصية',
    },
    body: [
      {
        en: `This statement explains how ${BRAND.name} collects, uses and protects personal data when you visit this site, subscribe to our insights or contact us.`,
        'de-DE': `Diese Erklärung beschreibt, wie ${BRAND.name} personenbezogene Daten erhebt, verwendet und schützt.`,
        'fr-FR': `Cette déclaration explique comment ${BRAND.name} collecte, utilise et protège les données personnelles.`,
        'ja-JP': `本ステートメントは、${BRAND.name}が個人データをどのように収集、利用、保護するかを説明するものです。`,
        'ar-AE': `يوضح هذا البيان كيفية قيام ${BRAND.name} بجمع البيانات الشخصية واستخدامها وحمايتها.`,
      },
      {
        en: 'You can ask to see, correct or delete the data we hold about you at any time by contacting our data protection officer.',
      },
    ],
  },
  {
    slug: 'cookies',
    kind: 'cookies',
    title: {
      en: 'Cookie policy',
      'de-DE': 'Cookie-Richtlinie',
      'fr-FR': 'Politique relative aux cookies',
      'ja-JP': 'クッキーポリシー',
    },
    body: [
      {
        en: 'We use strictly necessary cookies to run this site, and analytics and marketing cookies only with your consent.',
      },
    ],
  },
  {
    slug: 'terms',
    kind: 'terms',
    title: {
      en: 'Terms of use',
      'de-DE': 'Nutzungsbedingungen',
      'fr-FR': 'Conditions d’utilisation',
    },
    body: [
      {
        en: 'Content on this site is for general information only and does not constitute professional advice.',
      },
    ],
  },
  {
    slug: 'accessibility',
    kind: 'accessibility',
    title: {
      en: 'Accessibility statement',
      'de-DE': 'Erklärung zur Barrierefreiheit',
      'fr-FR': 'Déclaration d’accessibilité',
      'ja-JP': 'アクセシビリティに関する声明',
    },
    body: [
      {
        en: 'We aim to meet WCAG 2.2 AA across this site. Charts have text descriptions, videos have captions, and every page works with a keyboard.',
      },
    ],
  },
  {
    slug: 'impressum',
    kind: 'imprint',
    title: { en: 'Imprint', 'de-DE': 'Impressum', 'de-CH': 'Impressum' },
    jurisdictions: ['DE', 'CH'],
    body: [
      {
        en: 'Aldermoor GmbH Wirtschaftsprüfungsgesellschaft, Mainufer 12, 60311 Frankfurt am Main. Registered at the local court of Frankfurt am Main.',
        'de-DE':
          'Aldermoor GmbH Wirtschaftsprüfungsgesellschaft, Mainufer 12, 60311 Frankfurt am Main. Sitz der Gesellschaft: Frankfurt am Main, Amtsgericht Frankfurt am Main.',
      },
    ],
  },
  {
    slug: 'transparency-report',
    kind: 'imprint',
    title: { en: 'Transparency report', 'de-DE': 'Transparenzbericht' },
    jurisdictions: ['DE'],
    body: [
      {
        en: 'Our annual transparency report as a statutory auditor of public-interest entities.',
        'de-DE':
          'Unser jährlicher Transparenzbericht als Abschlussprüfer von Unternehmen von öffentlichem Interesse.',
      },
    ],
  },
  {
    slug: 'us-state-privacy',
    kind: 'state-privacy',
    title: { en: 'US state privacy notice' },
    jurisdictions: ['US'],
    body: [
      {
        en: 'Residents of certain US states have the right to opt out of the sale or sharing of personal information. Use the “Do not sell or share my personal information” link in the footer.',
      },
    ],
  },
  {
    slug: 'modern-slavery',
    kind: 'modern-slavery',
    title: { en: 'Modern slavery statement' },
    jurisdictions: ['GB', 'AU'],
    body: [
      {
        en: 'Our annual statement on the steps we take to prevent modern slavery in our business and supply chain.',
      },
    ],
  },
  {
    slug: 'member-firms-japan',
    kind: 'entities',
    title: { en: 'Member firms in Japan', 'ja-JP': '日本のメンバーファーム' },
    jurisdictions: ['JP'],
    body: [
      {
        en: 'Aldermoor Japan LLC, Aldermoor Tax Japan, Aldermoor Strategy Japan KK.',
        'ja-JP': 'Aldermoor Japan合同会社、Aldermoor税理士法人、Aldermoorストラテジー株式会社。',
      },
    ],
  },
  {
    slug: 'whistleblowing',
    kind: 'whistleblowing',
    title: { en: 'Whistleblowing hotline', 'ja-JP': '内部通報窓口' },
    jurisdictions: ['JP'],
    body: [
      {
        en: 'Report concerns confidentially, in your own language, around the clock.',
        'ja-JP': '懸念事項は、24時間いつでも、母国語で匿名で報告できます。',
      },
    ],
  },
  {
    slug: 'cookie-policy-2024',
    kind: 'cookies',
    title: { en: 'Cookie policy (2024, superseded)' },
    body: [{ en: 'Superseded by the current cookie policy.' }],
    status: 'trashed',
  },
];

const CAREERS: readonly {
  slug: string;
  title: Tr;
  audience: string;
  summary: Tr;
  hero: string;
  services: string[];
}[] = [
  {
    slug: 'graduates',
    title: {
      en: 'Graduates and students',
      'de-DE': 'Absolventen und Studierende',
      'fr-FR': 'Jeunes diplômés et étudiants',
      'ja-JP': '新卒・学生の方',
      'pt-BR': 'Recém-formados e estudantes',
    },
    audience: 'students',
    summary: {
      en: 'Two years of structured training, a mentor from day one and real client work in your first month.',
    },
    hero: 'hero-classroom.png',
    services: ['assurance', 'consulting'],
  },
  {
    slug: 'experienced-professionals',
    title: { en: 'Experienced professionals', 'de-DE': 'Berufserfahrene' },
    audience: 'experienced',
    summary: {
      en: 'Bring your expertise to a firm that invests in the next stage of your career.',
    },
    hero: 'hero-mentoring.png',
    services: ['consulting', 'technology'],
  },
  {
    slug: 'technology-careers',
    title: { en: 'Technology careers' },
    audience: 'experienced',
    summary: { en: 'Engineers, data scientists and architects building what our clients run on.' },
    hero: 'hero-data-grid.png',
    services: ['technology', 'ai-and-data-consulting'],
  },
  {
    slug: 'tax-careers',
    title: { en: 'Tax careers', 'de-DE': 'Karriere im Steuerbereich' },
    audience: 'everyone',
    summary: {
      en: 'From compliance to policy, work on the questions governments are still answering.',
    },
    hero: 'hero-port.png',
    services: ['tax-and-law'],
  },
  {
    slug: 'mba',
    title: { en: 'MBA and advanced degrees' },
    audience: 'mba',
    summary: { en: 'Join the strategy practice with a fast track to client leadership.' },
    hero: 'hero-boardroom.png',
    services: ['strategy-and-transactions'],
  },
  {
    slug: 'life-at-aldermoor',
    title: {
      en: 'Life at Aldermoor',
      'de-DE': 'Arbeiten bei Aldermoor',
      'ja-JP': 'Aldermoorでの働き方',
    },
    audience: 'everyone',
    summary: {
      en: 'Flexible working, a culture of feedback and benefits that support every stage of life.',
    },
    hero: 'hero-mentoring.png',
    services: [],
  },
];

export async function seedEnterpriseBlocks(run: EnterpriseRun): Promise<void> {
  const { space } = run;
  const terms = await loadTerms(run);
  const files = await assetIdsByFile(run);

  const disclaimers = await ensureEntries(
    run,
    'disclaimer',
    DISCLAIMERS.map((d) => ({
      key: d.key,
      fields: {
        internalName: one(d.key, space),
        kind: one(d.kind, space),
        ...(d.jurisdictions ? { jurisdictions: one(d.jurisdictions, space) } : {}),
        body: locBuild(d.body, space, (text) => paras(text)),
      },
    })),
    terms,
    'internalName',
  );

  await ensureEntries(
    run,
    'mediaContact',
    CONTACTS.map((c) => ({
      key: c.key,
      fields: {
        label: one(c.key, space),
        region: one(c.region, space),
        email: one(c.email, space),
        phone: one(e164(c.phone), space),
      },
    })),
    terms,
    'label',
  );

  const consent = disclaimers.get('Marketing consent');
  await ensureEntries(
    run,
    'form',
    FORMS.map((f) => ({
      key: f.key,
      fields: {
        name: one(f.key, space),
        kind: one(f.kind, space),
        heading: loc(f.heading, space),
        ...(f.intro ? { intro: loc(f.intro, space) } : {}),
        formUrl: one(`https://forms.${BRAND.domain}/${f.route}`, space),
        successMessage: loc(f.success, space),
        routingEmail: one(BRAND_EMAIL(`forms.${f.route}`), space),
        ...(consent ? { consentNotice: one(entry(consent), space) } : {}),
      },
    })),
    terms,
    'name',
  );

  await ensureEntries(
    run,
    'cta',
    CTAS.map((c, n) => {
      const image = c.image ? files.get(c.image) : undefined;
      return {
        key: c.key,
        status: n === 5 ? 'draft' : 'published',
        fields: {
          internalName: one(c.key, space),
          ...(c.eyebrow ? { eyebrow: loc(c.eyebrow, space) } : {}),
          heading: loc(c.heading, space),
          ...(c.body ? { body: loc(c.body, space) } : {}),
          primary: locBuild(c.label, space, (label, l) => ({
            label,
            url: `/${l}${c.url}`,
            style: 'primary',
          })),
          ...(image ? { image: one(asset(image), space) } : {}),
          theme: one(c.theme, space),
        },
      };
    }),
    terms,
    'internalName',
  );

  const now = run.ctx.clock.now();
  await ensureEntries(
    run,
    'legalPage',
    LEGAL.map((l, n) => ({
      key: l.slug,
      status: l.status ?? 'published',
      tags: ['legal', ...(l.jurisdictions ? ['local-only'] : ['global-rollout'])],
      fields: {
        title: loc(l.title, space),
        slug: one(l.slug, space),
        kind: one(l.kind, space),
        ...(l.jurisdictions ? { jurisdictions: one(l.jurisdictions, space) } : {}),
        body: Object.fromEntries(
          Object.keys(loc(l.body[0] as Tr, space)).map((locale) => [
            locale,
            doc(
              h2((loc(l.title, space)[locale] ?? l.title.en) as string),
              ...l.body.map((para) => p((loc(para, space)[locale] ?? para.en) as string)),
              h3(locale.startsWith('de') ? 'Kontakt' : 'Contact'),
              p(`${BRAND_EMAIL('privacy')}`),
            ),
          ]),
        ),
        lastUpdated: one(dayOnly(now, -30 - n * 11), space),
        reviewBy: one(dayOnly(now, 300 - n * 40), space),
        seo: locBuild(l.title, space, (title) => ({
          title: `${title} | ${BRAND.name}`,
          noindex: l.kind === 'entities',
        })),
      },
    })),
    terms,
  );

  const services = await keysOf(run, 'service');
  await ensureEntries(
    run,
    'careerArea',
    CAREERS.map((c, n) => {
      const image = files.get(c.hero);
      return {
        key: c.slug,
        concepts: [topic('skills-and-talent'), audience('chro')],
        fields: {
          title: loc(c.title, space),
          slug: one(c.slug, space),
          audience: one(c.audience, space),
          summary: loc(c.summary, space),
          hero: locBuild(c.title, space, (headline) => ({
            variant: 'identity',
            headline,
            ...(image ? { image: asset(image) } : {}),
            ctaLabel: 'Search roles',
            ctaUrl: BRAND.careersAts,
          })),
          body: {
            [space.defaultLocale]: doc(
              p(c.summary.en),
              h2('What you’ll do'),
              ul([
                'Work on real client problems from your first month',
                'Learn from partners who were in your seat',
                'Choose where to grow: specialist, manager or leader',
              ]),
              p(b('Hybrid by default: '), 'most teams spend two to three days a week together.'),
            ),
          },
          impactStats: one(
            [
              { value: String(1200 + n * 350), label: 'joiners this year' },
              { value: '38', unit: 'hours', label: 'of learning per person, per year' },
            ],
            space,
          ),
          relatedServices: one(
            c.services
              .map((s) => services.get(s))
              .filter((id): id is string => !!id)
              .map(entry),
            space,
          ),
          applyUrl: one(`${BRAND.careersAts}/search?area=${c.slug}`, space),
          faq: {
            [space.defaultLocale]: [
              {
                question: 'Do I need a business degree?',
                answer: doc(p('No. Around half our joiners studied something else.')),
              },
              {
                question: 'Can I work flexibly?',
                answer: doc(
                  p('Yes: agree a pattern with your team that works for your clients and for you.'),
                ),
              },
            ],
          },
        },
      };
    }),
    terms,
  );
}
