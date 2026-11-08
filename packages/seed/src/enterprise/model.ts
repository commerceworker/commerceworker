import type { ContentTypeDraft, FieldDefinition, FieldValidations } from '@commerceworker/domain';
import { ensureContentType } from '../helpers';
import type { EnterpriseRun } from './run';

/**
 * Aldermoor's content model: twenty types in seven groups, modelled on how a large multi-market
 * professional-services site is actually built. A shared page base (slug, SEO, topics, region,
 * brand, display date) on every routable type; components for the repeated shapes (hero, stat,
 * quote, FAQ, chapter); a blocks field for page building; URL patterns with the market in the
 * path; editor layouts in tabs; conditional rules (CPE fields only for credit-bearing events, the
 * embargo time only for embargoed releases, the client name only when it is cleared); labelled
 * options; presets; date ranges; MIME rules on asset links; guidance for editors and for agents.
 */

type F = Omit<FieldDefinition, 'position'>;
type Opts = Partial<Omit<FieldDefinition, 'apiId' | 'name' | 'type' | 'position'>>;

const base = (apiId: string, name: string, type: FieldDefinition['type'], o: Opts = {}): F => ({
  apiId,
  name,
  type,
  localized: false,
  required: false,
  ...o,
});

const sym = (apiId: string, name: string, o: Opts = {}) => base(apiId, name, 'Symbol', o);
const text = (apiId: string, name: string, o: Opts = {}) => base(apiId, name, 'Text', o);
const rich = (apiId: string, name: string, o: Opts = {}) => base(apiId, name, 'RichText', o);
const int = (apiId: string, name: string, o: Opts = {}) => base(apiId, name, 'Integer', o);
const num = (apiId: string, name: string, o: Opts = {}) => base(apiId, name, 'Number', o);
const bool = (apiId: string, name: string, o: Opts = {}) => base(apiId, name, 'Boolean', o);
const date = (apiId: string, name: string, o: Opts = {}) =>
  base(apiId, name, 'Date', { format: 'date', ...o });
const datetime = (apiId: string, name: string, o: Opts = {}) =>
  base(apiId, name, 'Date', { format: 'datetime', ...o });
const json = (apiId: string, name: string, o: Opts = {}) => base(apiId, name, 'JSON', o);
const slug = (o: Opts = {}) =>
  base('slug', 'Slug', 'Slug', {
    required: true,
    unique: true,
    help: 'Lowercase words joined by hyphens. Changing it on a published entry adds a 301.',
    ...o,
  });
const seo = () =>
  base('seo', 'SEO', 'Seo', {
    localized: true,
    help: 'Title as "{Title} | Aldermoor"; description under 160 characters.',
  });
const link = (apiId: string, name: string, types: readonly string[], o: Opts = {}) =>
  base(apiId, name, 'Link', {
    linkType: 'Entry',
    ...o,
    validations: { linkContentTypes: [...types], ...o.validations },
  });
const links = (
  apiId: string,
  name: string,
  types: readonly string[],
  o: Opts & { max?: number; min?: number } = {},
) => {
  const { max, min, ...rest } = o;
  return base(apiId, name, 'Array', {
    ...rest,
    items: { type: 'Link', linkType: 'Entry', validations: { linkContentTypes: [...types] } },
    ...(max !== undefined || min !== undefined ? { validations: { size: { min, max } } } : {}),
  });
};
const IMAGE: FieldValidations = {
  assetMimeTypes: ['image/*'],
  messages: { assetMimeTypes: 'Use an image: PNG, JPEG, WebP or AVIF.' },
};
const image = (apiId: string, name: string, o: Opts = {}) =>
  base(apiId, name, 'Link', { linkType: 'Asset', validations: IMAGE, ...o });
const pdfs = (apiId: string, name: string, o: Opts = {}) =>
  base(apiId, name, 'Array', {
    items: {
      type: 'Link',
      linkType: 'Asset',
      validations: { assetMimeTypes: ['application/pdf'] },
    },
    ...o,
  });
const list = (apiId: string, name: string, o: Opts & { max?: number } = {}) => {
  const { max, ...rest } = o;
  return base(apiId, name, 'Array', {
    items: { type: 'Symbol', validations: { size: { max: 200 } } },
    ...(max !== undefined ? { validations: { size: { max } } } : {}),
    ...rest,
  });
};
const choice = (
  apiId: string,
  name: string,
  options: readonly (readonly [string, string])[],
  o: Opts = {},
) =>
  sym(apiId, name, {
    ...o,
    validations: { in: options.map(([value, label]) => ({ value, label })), ...o.validations },
  });
const comp = (apiId: string, name: string, fields: readonly F[], o: Opts = {}) =>
  base(apiId, name, 'Component', { fields: positioned(fields), ...o });
const repeater = (
  apiId: string,
  name: string,
  fields: readonly F[],
  o: Opts & { max?: number } = {},
) => {
  const { max, ...rest } = o;
  return base(apiId, name, 'Array', {
    items: { type: 'Component', fields: positioned(fields) },
    ...(max !== undefined ? { validations: { size: { max } } } : {}),
    ...rest,
  });
};

function positioned(fields: readonly F[]): FieldDefinition[] {
  return fields.map((f, position) => ({ ...f, position }) as FieldDefinition);
}

// ---- Shared vocabularies --------------------------------------------------------------------

export const AREAS = [
  ['global', 'Global'],
  ['americas', 'Americas'],
  ['emeia', 'Europe, Middle East, India and Africa'],
  ['apac', 'Asia-Pacific'],
] as const;

export const BRANDS = [
  ['aldermoor', 'Aldermoor'],
  ['vantage', 'Aldermoor Vantage (strategy)'],
] as const;

export const TIERS = [
  ['tier-1', 'Tier 1: flagship'],
  ['tier-2', 'Tier 2: supporting'],
  ['none', 'Not thought leadership'],
] as const;

const CTA_STYLES = [
  ['primary', 'Primary button'],
  ['secondary', 'Secondary button'],
  ['link', 'Text link'],
] as const;

// ---- Components -----------------------------------------------------------------------------

const heroFields: F[] = [
  choice(
    'variant',
    'Variant',
    [
      ['banner', 'Banner image'],
      ['identity', 'Identity (campaign)'],
      ['product', 'Product'],
      ['team', 'Team'],
      ['case-study', 'Case study'],
    ],
    { defaultValue: 'banner' },
  ),
  sym('eyebrow', 'Eyebrow', { validations: { size: { max: 60 } } }),
  sym('headline', 'Headline', { required: true, validations: { size: { max: 120 } } }),
  text('subhead', 'Subhead', { validations: { size: { max: 300 } } }),
  image('image', 'Image', { help: 'Set a focal point on the asset: heroes crop on phones.' }),
  sym('ctaLabel', 'Button label'),
  sym('ctaUrl', 'Button URL', {
    placeholder: '/en-US/contact',
    rules: [{ action: 'hide', when: { field: 'ctaLabel', operator: 'empty' } }],
  }),
];

const statFields: F[] = [
  sym('value', 'Value', { required: true, placeholder: '72' }),
  sym('unit', 'Unit', { placeholder: '%' }),
  sym('label', 'Label', { required: true }),
  sym('source', 'Source', { help: 'Name the survey or dataset; legal asks for it.' }),
];

const quoteFields: F[] = [
  text('text', 'Quote', { required: true, validations: { size: { max: 600 } } }),
  sym('name', 'Name', { required: true }),
  sym('title', 'Job title'),
  sym('organization', 'Organization'),
  image('portrait', 'Portrait'),
];

const faqFields: F[] = [
  sym('question', 'Question', { required: true }),
  rich('answer', 'Answer', { required: true }),
];

const ctaInlineFields: F[] = [
  sym('label', 'Label', { required: true }),
  sym('url', 'URL', { required: true }),
  choice('style', 'Style', CTA_STYLES, { defaultValue: 'primary' }),
];

/** The page-building blocks every page, campaign and hub composes. */
const SECTION_VARIANTS = [
  { apiId: 'hero', name: 'Hero', fields: positioned(heroFields) },
  {
    apiId: 'richText',
    name: 'Rich text',
    fields: positioned([sym('heading', 'Heading'), rich('body', 'Body', { required: true })]),
  },
  {
    apiId: 'cardGrid',
    name: 'Content grid',
    fields: positioned([
      sym('heading', 'Heading'),
      choice('mode', 'Source', [
        ['manual', 'Pick entries by hand'],
        ['query', 'Latest by topic and type'],
      ]),
      links('items', 'Entries', ['insight', 'caseStudy', 'pressRelease', 'event', 'service'], {
        max: 12,
        rules: [{ action: 'hide', when: { field: 'mode', operator: 'eq', value: 'query' } }],
      }),
      sym('queryType', 'Content type', {
        rules: [{ action: 'hide', when: { field: 'mode', operator: 'eq', value: 'manual' } }],
      }),
      sym('queryTopic', 'Topic slug', {
        rules: [{ action: 'hide', when: { field: 'mode', operator: 'eq', value: 'manual' } }],
      }),
      int('maxItems', 'Max items', { validations: { range: { min: 1, max: 24 } } }),
      choice('layout', 'Layout', [
        ['grid', 'Grid'],
        ['carousel', 'Carousel'],
      ]),
    ]),
  },
  {
    apiId: 'statBand',
    name: 'Stat band',
    fields: positioned([sym('heading', 'Heading'), repeater('stats', 'Stats', statFields)]),
  },
  { apiId: 'quote', name: 'Quote', fields: positioned(quoteFields) },
  {
    apiId: 'faq',
    name: 'FAQ',
    fields: positioned([
      sym('heading', 'Heading'),
      repeater('items', 'Questions', faqFields, { max: 12 }),
      bool('emitSchema', 'Emit FAQ structured data', { defaultValue: true }),
    ]),
  },
  {
    apiId: 'ctaBand',
    name: 'CTA band',
    fields: positioned([link('cta', 'CTA', ['cta'], { required: true })]),
  },
  {
    apiId: 'video',
    name: 'Video',
    fields: positioned([
      sym('title', 'Title', { required: true }),
      sym('embedUrl', 'Video URL', { validations: { regexp: { pattern: '', preset: 'url' } } }),
      text('transcript', 'Transcript'),
    ]),
  },
  {
    apiId: 'downloads',
    name: 'Downloads',
    fields: positioned([sym('heading', 'Heading'), pdfs('files', 'Files')]),
  },
  {
    apiId: 'team',
    name: 'Team',
    fields: positioned([sym('heading', 'Heading'), links('people', 'People', ['person'])]),
  },
  {
    apiId: 'logoRow',
    name: 'Partner logos',
    fields: positioned([links('partners', 'Partners', ['alliance'])]),
  },
  {
    apiId: 'eventList',
    name: 'Event list',
    fields: positioned([
      sym('heading', 'Heading'),
      choice('window', 'Window', [
        ['upcoming', 'Upcoming'],
        ['on-demand', 'On demand'],
        ['all', 'All'],
      ]),
      int('maxItems', 'Max items', { validations: { range: { min: 1, max: 12 } } }),
    ]),
  },
  {
    apiId: 'form',
    name: 'Form',
    fields: positioned([link('form', 'Form', ['form'], { required: true })]),
  },
  {
    apiId: 'tabs',
    name: 'Tabs',
    fields: positioned([
      repeater('tabs', 'Tabs', [sym('label', 'Label', { required: true }), rich('body', 'Body')], {
        max: 6,
      }),
    ]),
  },
];

const sections = (o: Opts = {}) =>
  base('sections', 'Sections', 'Array', {
    localized: true,
    help: 'Build the page from blocks; reorder by dragging.',
    items: { type: 'Component', variants: SECTION_VARIANTS },
    validations: { size: { max: 30 } },
    ...o,
  });

/** The fields every routable page shares: ownership, brand and display date (topics are concepts). */
const pageMeta = (): F[] => [
  choice('area', 'Owning area', AREAS, { defaultValue: 'global' }),
  choice('brand', 'Brand', BRANDS, {
    defaultValue: 'aldermoor',
    help: 'Vantage switches the logo and the footer disclaimer.',
  }),
  date('displayDate', 'Display date', {
    help: 'The date readers see. Publishing again keeps it; update it on a real review.',
  }),
  bool('hideFromSearch', 'Hide from site search'),
];

// ---- Types ----------------------------------------------------------------------------------

const types = (): ContentTypeDraft[] => [
  {
    apiId: 'homePage',
    name: 'Home page',
    group: 'Site',
    icon: 'house',
    singleton: true,
    displayField: 'title',
    urlPattern: '/{locale}',
    description: 'The market home page: one per environment, localized per market.',
    fields: positioned([
      sym('title', 'Title', { localized: true, required: true }),
      sections(),
      links('spotlight', 'Spotlight', ['insight', 'caseStudy', 'pressRelease'], { max: 4 }),
      seo(),
    ]),
  },
  {
    apiId: 'page',
    name: 'Page',
    group: 'Site',
    icon: 'layout',
    displayField: 'title',
    urlPattern: '/{locale}/{slug}',
    description:
      'Campaigns, programs, topic hubs, about pages and C-suite agendas, built from blocks.',
    agentInstructions:
      'Pages are assembled from sections. Prefer a content grid in query mode over hand-picked ' +
      'items for hubs, so the page stays fresh. Never invent statistics: stat bands cite a source.',
    fields: positioned([
      sym('title', 'Title', { localized: true, required: true }),
      slug(),
      choice('template', 'Template', [
        ['campaign', 'Campaign'],
        ['program', 'Program / C-suite agenda'],
        ['topic-hub', 'Topic hub'],
        ['about', 'About'],
        ['generic', 'Generic'],
      ]),
      text('summary', 'Summary', { localized: true, validations: { size: { max: 300 } } }),
      sections(),
      link('parent', 'Parent page', ['page'], { help: 'Builds the breadcrumb.' }),
      ...pageMeta(),
      seo(),
    ]),
    layout: {
      tabs: [
        {
          apiId: 'content',
          name: 'Content',
          groups: [{ fields: ['title', 'slug', 'template', 'summary', 'sections'] }],
        },
        {
          apiId: 'placement',
          name: 'Placement',
          groups: [
            { name: 'Site tree', fields: ['parent'] },
            {
              name: 'Ownership',
              fields: ['area', 'brand', 'displayDate', 'hideFromSearch'],
              collapsed: true,
            },
          ],
        },
        { apiId: 'seo', name: 'SEO', groups: [{ fields: ['seo'] }] },
      ],
    },
  },
  {
    apiId: 'legalPage',
    name: 'Legal page',
    group: 'Site',
    icon: 'scale',
    displayField: 'title',
    urlPattern: '/{locale}/legal/{slug}',
    description:
      'Privacy, cookies, terms, accessibility, imprint and jurisdiction-only notices. Owned by ' +
      'Legal & Risk; every change goes through legal review.',
    agentInstructions: 'Never rewrite legal text. Translation only through the translation team.',
    fields: positioned([
      sym('title', 'Title', { localized: true, required: true }),
      slug(),
      choice('kind', 'Kind', [
        ['privacy', 'Privacy statement'],
        ['cookies', 'Cookie policy'],
        ['terms', 'Terms of use'],
        ['accessibility', 'Accessibility statement'],
        ['imprint', 'Imprint (Impressum)'],
        ['state-privacy', 'US state privacy notice'],
        ['modern-slavery', 'Modern slavery statement'],
        ['entities', 'Member firm entities'],
        ['whistleblowing', 'Whistleblowing hotline'],
      ]),
      list('jurisdictions', 'Jurisdictions', {
        help: 'ISO country codes this notice applies to; empty means everywhere.',
      }),
      rich('body', 'Body', { localized: true, required: true }),
      date('lastUpdated', 'Last updated', { required: true }),
      date('reviewBy', 'Review by', { help: 'Legal reviews notices at least yearly.' }),
      seo(),
    ]),
  },
  {
    apiId: 'siteSettings',
    name: 'Site settings',
    group: 'Site',
    icon: 'settings',
    singleton: true,
    displayField: 'siteName',
    description: 'Footer, social handles, the network disclaimer and the cookie banner text.',
    fields: positioned([
      sym('siteName', 'Site name', { required: true }),
      text('footerStatement', 'Footer statement', { localized: true }),
      link('networkDisclaimer', 'Network disclaimer', ['disclaimer']),
      link('subBrandDisclaimer', 'Sub-brand disclaimer', ['disclaimer']),
      repeater('social', 'Social links', [
        choice('network', 'Network', [
          ['linkedin', 'LinkedIn'],
          ['x', 'X'],
          ['youtube', 'YouTube'],
          ['instagram', 'Instagram'],
        ]),
        sym('url', 'URL', {
          required: true,
          validations: { regexp: { pattern: '', preset: 'url' } },
        }),
      ]),
      text('cookieBanner', 'Cookie banner text', { localized: true }),
      json('analytics', 'Analytics configuration', {
        description: 'Container ids per market, read by the front end.',
      }),
    ]),
  },
  {
    apiId: 'service',
    name: 'Service',
    group: 'Offerings',
    icon: 'briefcase',
    displayField: 'name',
    urlPattern: '/{locale}/services/{slug}',
    description: 'Service lines, sub-services and offerings, as a tree.',
    fields: positioned([
      sym('name', 'Name', { localized: true, required: true }),
      slug(),
      choice('level', 'Level', [
        ['line', 'Service line'],
        ['sub-service', 'Sub-service'],
        ['offering', 'Offering'],
      ]),
      link('parent', 'Parent service', ['service'], {
        rules: [{ action: 'hide', when: { field: 'level', operator: 'eq', value: 'line' } }],
      }),
      text('shortDescription', 'Short description', {
        localized: true,
        required: true,
        validations: { size: { max: 240 } },
      }),
      comp('hero', 'Hero', heroFields, { localized: true }),
      rich('intro', 'Introduction', { localized: true }),
      links('howWeCanHelp', 'How we can help', ['service'], { max: 18 }),
      links('featuredInsights', 'Featured insights', ['insight'], { max: 12 }),
      links('featuredCaseStudies', 'Featured case studies', ['caseStudy'], { max: 12 }),
      links('team', 'Team', ['person'], { max: 10 }),
      links('relatedIndustries', 'Related industries', ['industry']),
      repeater('faq', 'FAQ', faqFields, { localized: true, max: 6 }),
      link('contactForm', 'Contact form', ['form']),
      ...pageMeta(),
      seo(),
    ]),
    layout: {
      tabs: [
        {
          apiId: 'content',
          name: 'Content',
          groups: [
            { fields: ['name', 'slug', 'level', 'parent', 'shortDescription'] },
            { name: 'Page', fields: ['hero', 'intro', 'faq'] },
          ],
        },
        {
          apiId: 'curation',
          name: 'Curation',
          groups: [
            {
              fields: [
                'howWeCanHelp',
                'featuredInsights',
                'featuredCaseStudies',
                'team',
                'relatedIndustries',
                'contactForm',
              ],
            },
          ],
        },
        {
          apiId: 'meta',
          name: 'SEO & ownership',
          groups: [{ fields: ['seo', 'area', 'brand', 'displayDate', 'hideFromSearch'] }],
        },
      ],
    },
  },
  {
    apiId: 'industry',
    name: 'Industry',
    group: 'Offerings',
    icon: 'factory',
    displayField: 'name',
    urlPattern: '/{locale}/industries/{slug}',
    description: 'Sector groups, sectors and sub-sectors.',
    fields: positioned([
      sym('name', 'Name', { localized: true, required: true }),
      slug(),
      choice('level', 'Level', [
        ['group', 'Sector group'],
        ['sector', 'Sector'],
        ['sub-sector', 'Sub-sector'],
      ]),
      link('parent', 'Parent', ['industry']),
      text('shortDescription', 'Short description', { localized: true, required: true }),
      comp('hero', 'Hero', heroFields, { localized: true }),
      rich('intro', 'Introduction', { localized: true }),
      repeater('keyStats', 'Key figures', statFields, { max: 4 }),
      links('relatedServices', 'Related services', ['service']),
      links('featuredInsights', 'Featured insights', ['insight'], { max: 12 }),
      links('team', 'Team', ['person'], { max: 6 }),
      ...pageMeta(),
      seo(),
    ]),
  },
  {
    apiId: 'alliance',
    name: 'Alliance partner',
    group: 'Offerings',
    icon: 'handshake',
    displayField: 'name',
    urlPattern: '/{locale}/alliances/{slug}',
    fields: positioned([
      sym('name', 'Name', { required: true }),
      slug(),
      image('logo', 'Logo', { required: true }),
      text('summary', 'Summary', { localized: true }),
      rich('body', 'Body', { localized: true }),
      links('offerings', 'Joint offerings', ['service']),
      sym('website', 'Website', { validations: { regexp: { pattern: '', preset: 'url' } } }),
      seo(),
    ]),
  },
  {
    apiId: 'insight',
    name: 'Insight',
    group: 'Thought leadership',
    icon: 'newspaper',
    displayField: 'headline',
    urlPattern: '/{locale}/insights/{slug}',
    description: 'Articles, chaptered articles and flagship reports, surveys and indexes.',
    agentInstructions:
      'Write in plain, confident British-neutral English. The standfirst is one sentence. ' +
      '"In brief" is exactly three points. Cite every figure in the references. Forward-looking ' +
      'figures are illustrative and carry the methodology note.',
    fields: positioned([
      sym('headline', 'Headline', {
        localized: true,
        required: true,
        validations: { size: { max: 140 } },
      }),
      slug(),
      choice('format', 'Format', [
        ['article', 'Article'],
        ['chaptered', 'Chaptered article'],
        ['report', 'Report'],
        ['survey', 'Survey'],
        ['index', 'Index'],
      ]),
      text('standfirst', 'Standfirst', {
        localized: true,
        required: true,
        validations: { size: { max: 280 }, messages: { size: 'Keep the standfirst to one line.' } },
      }),
      list('inBrief', 'In brief', {
        localized: true,
        max: 3,
        help: 'Three short points readers can scan.',
      }),
      image('heroImage', 'Hero image', { required: true }),
      links('authors', 'Authors', ['person'], { min: 1, max: 7, required: true }),
      list('contributors', 'Contributors', { help: 'Names only; acknowledged, not linked.' }),
      link('series', 'Series', ['series']),
      int('seriesPosition', 'Position in series', {
        validations: { range: { min: 1, max: 50 } },
        rules: [{ action: 'hide', when: { field: 'series', operator: 'empty' } }],
      }),
      int('readingTime', 'Reading time (minutes)', { validations: { range: { min: 1, max: 60 } } }),
      choice('tier', 'Content tier', TIERS, { defaultValue: 'tier-2' }),
      rich('body', 'Body', { localized: true, required: true }),
      int('edition', 'Edition or wave', {
        validations: { range: { min: 1, max: 100 } },
        rules: [
          {
            action: 'hide',
            when: { field: 'format', operator: 'in', value: ['article', 'chaptered'] },
          },
        ],
      }),
      repeater('keyStats', 'Key figures', statFields, { max: 6 }),
      rich('methodology', 'Methodology', { localized: true }),
      list('references', 'References', { localized: true }),
      pdfs('downloads', 'Downloads'),
      bool('gated', 'Gate the download'),
      link('gateForm', 'Gate form', ['form'], {
        rules: [{ action: 'hide', when: { field: 'gated', operator: 'ne', value: true } }],
      }),
      repeater('faq', 'FAQ', faqFields, { localized: true, max: 6 }),
      links('related', 'Related', ['insight', 'caseStudy'], { max: 3 }),
      ...pageMeta(),
      seo(),
    ]),
    layout: {
      tabs: [
        {
          apiId: 'story',
          name: 'Story',
          groups: [
            { fields: ['headline', 'slug', 'format', 'standfirst', 'inBrief', 'heroImage'] },
            { name: 'Body', fields: ['body', 'methodology', 'references', 'faq'] },
          ],
        },
        {
          apiId: 'credits',
          name: 'Credits',
          groups: [
            { fields: ['authors', 'contributors', 'series', 'seriesPosition', 'readingTime'] },
          ],
        },
        {
          apiId: 'research',
          name: 'Research',
          groups: [{ fields: ['edition', 'keyStats', 'downloads', 'gated', 'gateForm'] }],
        },
        {
          apiId: 'distribution',
          name: 'Distribution',
          groups: [
            { fields: ['tier', 'related'] },
            {
              name: 'Ownership',
              fields: ['area', 'brand', 'displayDate', 'hideFromSearch'],
              collapsed: true,
            },
            { name: 'SEO', fields: ['seo'] },
          ],
        },
      ],
    },
  },
  {
    apiId: 'series',
    name: 'Series',
    group: 'Thought leadership',
    icon: 'list-ordered',
    displayField: 'name',
    urlPattern: '/{locale}/series/{slug}',
    fields: positioned([
      sym('name', 'Name', { localized: true, required: true }),
      slug(),
      choice('kind', 'Kind', [
        ['whitepaper', 'Whitepaper series'],
        ['podcast', 'Podcast'],
        ['index', 'Recurring index'],
      ]),
      text('description', 'Description', { localized: true }),
      image('cover', 'Cover art'),
      links('hosts', 'Hosts', ['person'], {
        rules: [{ action: 'hide', when: { field: 'kind', operator: 'ne', value: 'podcast' } }],
      }),
      repeater('platforms', 'Listen on', [
        choice('platform', 'Platform', [
          ['apple', 'Apple Podcasts'],
          ['spotify', 'Spotify'],
          ['youtube', 'YouTube'],
        ]),
        sym('url', 'URL', { required: true }),
      ]),
      seo(),
    ]),
  },
  {
    apiId: 'caseStudy',
    name: 'Case study',
    group: 'Thought leadership',
    icon: 'trophy',
    displayField: 'title',
    urlPattern: '/{locale}/case-studies/{slug}',
    description:
      'The challenge, our approach, the outcome. A named client needs client clearance before ' +
      'it publishes.',
    fields: positioned([
      sym('title', 'Title', { localized: true, required: true }),
      slug(),
      text('summary', 'Summary', { localized: true, required: true }),
      bool('clientNamed', 'Client is named', {
        help: 'Only with written client consent: the clearance workflow checks it.',
      }),
      sym('clientName', 'Client name', {
        rules: [{ action: 'hide', when: { field: 'clientNamed', operator: 'ne', value: true } }],
      }),
      sym('clientDescriptor', 'Anonymous descriptor', {
        placeholder: 'A global consumer goods company',
        rules: [{ action: 'hide', when: { field: 'clientNamed', operator: 'eq', value: true } }],
      }),
      link('industry', 'Client industry', ['industry'], { required: true }),
      links('services', 'Services', ['service'], { max: 4 }),
      link('alliance', 'Alliance partner', ['alliance']),
      repeater(
        'chapters',
        'Chapters',
        [
          choice('kind', 'Chapter', [
            ['challenge', 'The challenge'],
            ['approach', 'Our approach'],
            ['outcome', 'The outcome'],
          ]),
          sym('headline', 'Headline', { required: true }),
          sym('subhead', 'Subhead'),
          image('image', 'Image'),
          rich('narrative', 'Narrative', { required: true }),
        ],
        { localized: true, max: 3, help: 'Exactly three: challenge, approach, outcome.' },
      ),
      repeater('outcomeStats', 'Outcome figures', statFields, { max: 4 }),
      repeater('quotes', 'Quotes', quoteFields, { localized: true, max: 3 }),
      links('team', 'Team', ['person'], { max: 4 }),
      ...pageMeta(),
      seo(),
    ]),
  },
  {
    apiId: 'technicalBulletin',
    name: 'Technical bulletin',
    group: 'Thought leadership',
    icon: 'file-text',
    displayField: 'title',
    urlPattern: '/{locale}/technical/{slug}',
    description: 'Tax alerts and accounting updates: high volume, jurisdiction-tagged, expiring.',
    agentInstructions:
      'Bulletins are factual and dated. Summaries state what changed, for whom, and from when. ' +
      'Never give advice; end with the standard "this is general information" disclaimer.',
    fields: positioned([
      sym('title', 'Title', { localized: true, required: true }),
      slug(),
      choice('category', 'Category', [
        ['corporate-tax', 'Corporate tax'],
        ['indirect-tax', 'Indirect tax'],
        ['transfer-pricing', 'Transfer pricing'],
        ['people-tax', 'People and mobility tax'],
        ['accounting', 'Accounting standards'],
        ['trade', 'Trade and customs'],
      ]),
      sym('jurisdiction', 'Jurisdiction', {
        required: true,
        help: 'ISO country code, or EU / OECD.',
        validations: { regexp: { pattern: '^([A-Z]{2}|EU|OECD)$' } },
      }),
      date('effectiveDate', 'Effective from'),
      text('summary', 'Summary', { localized: true, required: true }),
      rich('body', 'Body', { localized: true, required: true }),
      pdfs('attachments', 'Attachments'),
      link('disclaimer', 'Disclaimer', ['disclaimer']),
      date('expiresOn', 'Expires on', {
        help: 'Bulletins drop out of listings after this date; the freshness review re-checks them.',
      }),
      seo(),
    ]),
  },
  {
    apiId: 'event',
    name: 'Event',
    group: 'Media & events',
    icon: 'calendar',
    displayField: 'title',
    urlPattern: '/{locale}/events/{slug}',
    description: 'Webcasts, in-person events and conferences, with CPE credit where it applies.',
    fields: positioned([
      sym('title', 'Title', { localized: true, required: true }),
      slug(),
      choice('eventType', 'Type', [
        ['webcast', 'Webcast'],
        ['in-person', 'In-person event'],
        ['conference', 'Conference'],
        ['roundtable', 'Executive roundtable'],
      ]),
      text('description', 'Description', { localized: true, required: true }),
      datetime('startsAt', 'Starts', {
        required: true,
        help: 'In UTC; readers see their local time.',
        validations: { dateRange: { min: '2024-01-01T00:00:00.000Z' } },
      }),
      datetime('endsAt', 'Ends', { required: true }),
      int('durationMinutes', 'Duration (minutes)', {
        validations: { range: { min: 15, max: 600 } },
      }),
      base('venue', 'Venue', 'Location', {
        rules: [{ action: 'hide', when: { field: 'eventType', operator: 'eq', value: 'webcast' } }],
      }),
      sym('venueName', 'Venue name', {
        rules: [{ action: 'hide', when: { field: 'eventType', operator: 'eq', value: 'webcast' } }],
      }),
      links('presenters', 'Presenters', ['person'], { max: 8 }),
      bool('cpeEligible', 'Offers CPE credit'),
      num('cpeCredits', 'CPE credits', {
        validations: { range: { min: 0.5, max: 8 } },
        rules: [{ action: 'hide', when: { field: 'cpeEligible', operator: 'ne', value: true } }],
      }),
      choice(
        'fieldOfStudy',
        'Field of study',
        [
          ['accounting', 'Accounting'],
          ['auditing', 'Auditing'],
          ['taxes', 'Taxes'],
          ['specialized-knowledge', 'Specialized knowledge'],
          ['information-technology', 'Information technology'],
        ],
        {
          rules: [{ action: 'hide', when: { field: 'cpeEligible', operator: 'ne', value: true } }],
        },
      ),
      choice(
        'programLevel',
        'Program level',
        [
          ['basic', 'Basic'],
          ['intermediate', 'Intermediate'],
          ['advanced', 'Advanced'],
        ],
        {
          rules: [{ action: 'hide', when: { field: 'cpeEligible', operator: 'ne', value: true } }],
        },
      ),
      list('learningObjectives', 'Learning objectives', { localized: true, max: 6 }),
      link('registrationForm', 'Registration form', ['form']),
      sym('recordingUrl', 'Recording URL', {
        help: 'Added after the event; the listing switches it to on demand.',
        validations: { regexp: { pattern: '', preset: 'url' } },
      }),
      link('cpeDisclaimer', 'CPE disclaimer', ['disclaimer'], {
        rules: [{ action: 'hide', when: { field: 'cpeEligible', operator: 'ne', value: true } }],
      }),
      bool('promoted', 'Promote on the events hub'),
      ...pageMeta(),
      seo(),
    ]),
    layout: {
      tabs: [
        {
          apiId: 'event',
          name: 'Event',
          groups: [
            { fields: ['title', 'slug', 'eventType', 'description'] },
            {
              name: 'When and where',
              fields: ['startsAt', 'endsAt', 'durationMinutes', 'venue', 'venueName'],
            },
            { name: 'People', fields: ['presenters', 'learningObjectives'] },
          ],
        },
        {
          apiId: 'cpe',
          name: 'CPE',
          groups: [
            {
              fields: [
                'cpeEligible',
                'cpeCredits',
                'fieldOfStudy',
                'programLevel',
                'cpeDisclaimer',
              ],
            },
          ],
        },
        {
          apiId: 'promotion',
          name: 'Promotion',
          groups: [
            { fields: ['registrationForm', 'recordingUrl', 'promoted'] },
            {
              name: 'SEO & ownership',
              fields: ['seo', 'area', 'brand', 'displayDate', 'hideFromSearch'],
              collapsed: true,
            },
          ],
        },
      ],
    },
  },
  {
    apiId: 'podcastEpisode',
    name: 'Podcast episode',
    group: 'Media & events',
    icon: 'mic',
    displayField: 'title',
    urlPattern: '/{locale}/podcasts/{slug}',
    fields: positioned([
      sym('title', 'Title', { localized: true, required: true }),
      slug(),
      link('series', 'Series', ['series'], { required: true }),
      int('season', 'Season', { validations: { range: { min: 1, max: 30 } } }),
      int('episode', 'Episode', { validations: { range: { min: 1, max: 500 } } }),
      base('duration', 'Duration', 'Date', { format: 'time', help: 'Running time as hh:mm.' }),
      date('releasedOn', 'Released on', { required: true }),
      links('guests', 'Guests', ['person']),
      rich('showNotes', 'Show notes', { localized: true }),
      text('transcript', 'Transcript', { localized: true }),
      sym('audioUrl', 'Audio URL', { validations: { regexp: { pattern: '', preset: 'url' } } }),
      seo(),
    ]),
  },
  {
    apiId: 'pressRelease',
    name: 'Press release',
    group: 'Newsroom',
    icon: 'megaphone',
    displayField: 'headline',
    urlPattern: '/{locale}/news/{slug}',
    description:
      'Releases with a dateline, highlights, quotes and notes to editors. Embargoes apply.',
    agentInstructions:
      'Releases open with the dateline. Quotes are only ever from named, approved spokespeople. ' +
      'Never move an embargo.',
    fields: positioned([
      sym('headline', 'Headline', { localized: true, required: true }),
      slug(),
      text('subheadline', 'Subheadline', { localized: true }),
      date('releaseDate', 'Release date', { required: true }),
      sym('datelineCity', 'Dateline city', { required: true, placeholder: 'LONDON' }),
      list('highlights', 'Highlights', { localized: true, max: 3 }),
      rich('body', 'Body', { localized: true, required: true }),
      repeater('quotes', 'Quotes', quoteFields, { localized: true, max: 3 }),
      link('issuer', 'Issued by', ['person'], {
        help: 'A corporate author, such as "Aldermoor Global".',
      }),
      links('notesToEditors', 'Notes to editors', ['disclaimer']),
      link('mediaContact', 'Media contact', ['mediaContact']),
      link('relatedReport', 'Related report', ['insight']),
      bool('embargoed', 'Embargoed'),
      datetime('embargoUntil', 'Embargo lifts', {
        rules: [{ action: 'hide', when: { field: 'embargoed', operator: 'ne', value: true } }],
      }),
      ...pageMeta(),
      seo(),
    ]),
  },
  {
    apiId: 'mediaContact',
    name: 'Media contact',
    group: 'Newsroom',
    icon: 'phone',
    displayField: 'label',
    fields: positioned([
      sym('label', 'Label', { required: true }),
      sym('region', 'Region'),
      sym('email', 'Email', {
        required: true,
        validations: { regexp: { pattern: '', preset: 'email' } },
      }),
      sym('phone', 'Phone', { validations: { regexp: { pattern: '', preset: 'phone' } } }),
    ]),
  },
  {
    apiId: 'person',
    name: 'Person',
    group: 'People & places',
    icon: 'user',
    displayField: 'displayName',
    urlPattern: '/{locale}/people/{slug}',
    description:
      'Partners, leaders and authors. Global people are shared; local people belong to a market. ' +
      'Email addresses are never delivered: the contact form reaches them.',
    fields: positioned([
      sym('displayName', 'Display name', {
        required: true,
        help: 'As the person writes it, in their own name order.',
      }),
      slug(),
      sym('givenName', 'Given name'),
      sym('familyName', 'Family name'),
      choice('nameOrder', 'Name order', [
        ['given-family', 'Given name first'],
        ['family-given', 'Family name first'],
      ]),
      sym('jobTitle', 'Job title', { localized: true, required: true }),
      text('tagline', 'Tagline', { localized: true }),
      image('photo', 'Photo'),
      rich('bio', 'Biography', { localized: true }),
      link('office', 'Office', ['office']),
      choice('scope', 'Scope', [
        ['global', 'Global'],
        ['local', 'Local to a market'],
      ]),
      sym('homeMarket', 'Home market', {
        rules: [{ action: 'hide', when: { field: 'scope', operator: 'eq', value: 'global' } }],
      }),
      bool('corporateAuthor', 'Corporate author', {
        help: 'A byline for the firm itself, e.g. "Aldermoor Global".',
      }),
      sym('email', 'Email', {
        unique: true,
        validations: { regexp: { pattern: '', preset: 'email' } },
        rules: [
          { action: 'hide', when: { field: 'corporateAuthor', operator: 'eq', value: true } },
        ],
      }),
      sym('phone', 'Phone', { validations: { regexp: { pattern: '', preset: 'phone' } } }),
      sym('linkedIn', 'LinkedIn', { validations: { regexp: { pattern: '', preset: 'url' } } }),
      list('languages', 'Languages'),
      ...pageMeta(),
      seo(),
    ]),
  },
  {
    apiId: 'office',
    name: 'Office',
    group: 'People & places',
    icon: 'building',
    displayField: 'name',
    urlPattern: '/{locale}/offices/{slug}',
    fields: positioned([
      sym('name', 'Name', { localized: true, required: true }),
      slug(),
      sym('countryCode', 'Country', {
        required: true,
        validations: { regexp: { pattern: '^[A-Z]{2}$' } },
      }),
      sym('city', 'City', { localized: true, required: true }),
      sym('region', 'State or region'),
      text('address', 'Address', { localized: true, required: true }),
      sym('postalCode', 'Postal code'),
      base('geo', 'Map pin', 'Location', { required: true }),
      list('phones', 'Phones'),
      sym('timeZone', 'Time zone', { placeholder: 'Europe/London' }),
      list('legalEntities', 'Legal entities'),
      links('leaders', 'Office leaders', ['person'], { max: 4 }),
      image('photo', 'Photo'),
      base('openingHours', 'Opens', 'Date', { format: 'time' }),
      base('closingHours', 'Closes', 'Date', { format: 'time' }),
    ]),
  },
  {
    apiId: 'careerArea',
    name: 'Career area',
    group: 'Careers',
    icon: 'graduation-cap',
    displayField: 'title',
    urlPattern: '/{locale}/careers/{slug}',
    description: 'Career areas and life-here pages. Job postings live in the applicant system.',
    fields: positioned([
      sym('title', 'Title', { localized: true, required: true }),
      slug(),
      choice('audience', 'Audience', [
        ['students', 'Students and graduates'],
        ['experienced', 'Experienced professionals'],
        ['mba', 'MBA and advanced degrees'],
        ['contract', 'Contractors'],
        ['everyone', 'Everyone'],
      ]),
      text('summary', 'Summary', { localized: true, required: true }),
      comp('hero', 'Hero', heroFields, { localized: true }),
      rich('body', 'Body', { localized: true }),
      repeater('impactStats', 'Figures', statFields, { max: 4 }),
      links('relatedServices', 'Related services', ['service']),
      sym('applyUrl', 'Apply URL', { validations: { regexp: { pattern: '', preset: 'url' } } }),
      repeater('faq', 'FAQ', faqFields, { localized: true, max: 6 }),
      seo(),
    ]),
  },
  {
    apiId: 'cta',
    name: 'CTA',
    group: 'Building blocks',
    icon: 'mouse-pointer-click',
    displayField: 'internalName',
    description: 'Promotional banners and calls to action, reused across pages.',
    fields: positioned([
      sym('internalName', 'Internal name', { required: true }),
      sym('eyebrow', 'Eyebrow', { localized: true }),
      sym('heading', 'Heading', { localized: true, required: true }),
      text('body', 'Body', { localized: true }),
      comp('primary', 'Primary action', ctaInlineFields, { localized: true }),
      image('image', 'Image'),
      choice('theme', 'Theme', [
        ['light', 'Light'],
        ['dark', 'Dark'],
        ['brand', 'Brand'],
      ]),
    ]),
  },
  {
    apiId: 'form',
    name: 'Form',
    group: 'Building blocks',
    icon: 'clipboard-list',
    displayField: 'name',
    description:
      'Forms hosted by the marketing automation platform: the CMS holds their copy and routing.',
    fields: positioned([
      sym('name', 'Name', { required: true }),
      choice('kind', 'Kind', [
        ['contact', 'Contact'],
        ['subscribe', 'Newsletter subscribe'],
        ['registration', 'Event registration'],
        ['gated-download', 'Gated download'],
        ['person-contact', 'Contact a person'],
        ['rfp', 'Request for proposal'],
      ]),
      sym('heading', 'Heading', { localized: true, required: true }),
      text('intro', 'Intro', { localized: true }),
      sym('formUrl', 'Form URL', {
        required: true,
        validations: { regexp: { pattern: '', preset: 'url' } },
      }),
      text('successMessage', 'Success message', { localized: true }),
      sym('routingEmail', 'Routing inbox', {
        validations: { regexp: { pattern: '', preset: 'email' } },
      }),
      link('consentNotice', 'Consent notice', ['disclaimer']),
    ]),
  },
  {
    apiId: 'disclaimer',
    name: 'Disclaimer',
    group: 'Building blocks',
    icon: 'shield',
    displayField: 'internalName',
    description: 'Network disclaimers, notes to editors, CPE sponsor statements, consent text.',
    fields: positioned([
      sym('internalName', 'Internal name', { required: true }),
      choice('kind', 'Kind', [
        ['network', 'Global network statement'],
        ['sub-brand', 'Sub-brand statement'],
        ['about', 'Notes to editors: about'],
        ['cpe', 'CPE sponsor statement'],
        ['illustrative', 'Illustrative figures'],
        ['general-information', 'General information'],
        ['consent', 'Consent'],
      ]),
      list('jurisdictions', 'Jurisdictions'),
      rich('body', 'Body', { localized: true, required: true }),
    ]),
  },
];

export const ENTERPRISE_TYPE_IDS = types().map((t) => t.apiId);

/** Creates and publishes every type that isn't there yet (a type already there is left alone). */
export async function seedEnterpriseModel(run: EnterpriseRun): Promise<void> {
  for (const draft of types()) {
    await ensureContentType({ ...run, keepExistingTypes: true }, draft);
  }
}
