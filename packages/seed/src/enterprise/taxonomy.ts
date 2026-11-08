import {
  createConcept,
  createScheme,
  createTag,
  listConcepts,
  listSchemes,
  listTags,
} from '@commerceworker/application';
import { loc, type Tr } from './brand';
import type { EnterpriseRun } from './run';

/**
 * Language-neutral terms with labels per market: Topics (every page carries one to four), Sectors,
 * Regions (the owning area, not the language), C-suite audiences, and tax jurisdictions for the
 * technical bulletins. Tags are the editorial and operational flags teams filter by.
 */

interface TermDef {
  readonly label: Tr;
  readonly slug?: string;
  readonly description?: string;
  readonly children?: readonly TermDef[];
}

const T = (
  en: string,
  de: string,
  fr: string,
  es: string,
  ja: string,
  zh: string,
  pt: string,
  ar: string,
): Tr => ({
  en,
  'en-GB': en,
  'de-DE': de,
  'fr-FR': fr,
  'es-ES': es,
  'ja-JP': ja,
  'zh-CN': zh,
  'pt-BR': pt,
  'ar-AE': ar,
});

export const SCHEMES: readonly { name: string; terms: readonly TermDef[] }[] = [
  {
    name: 'Topics',
    terms: [
      {
        label: T(
          'Strategy and growth',
          'Strategie und Wachstum',
          'Stratégie et croissance',
          'Estrategia y crecimiento',
          '戦略と成長',
          '战略与增长',
          'Estratégia e crescimento',
          'الاستراتيجية والنمو',
        ),
        children: [
          {
            label: T(
              'Geostrategy',
              'Geostrategie',
              'Géostratégie',
              'Geoestrategia',
              '地政学戦略',
              '地缘战略',
              'Geoestratégia',
              'الاستراتيجية الجيوسياسية',
            ),
          },
          {
            label: T(
              'Mergers and acquisitions',
              'Fusionen und Übernahmen',
              'Fusions et acquisitions',
              'Fusiones y adquisiciones',
              'M&A',
              '并购',
              'Fusões e aquisições',
              'عمليات الاندماج والاستحواذ',
            ),
            slug: 'm-and-a',
          },
          {
            label: T(
              'Growth strategy',
              'Wachstumsstrategie',
              'Stratégie de croissance',
              'Estrategia de crecimiento',
              '成長戦略',
              '增长战略',
              'Estratégia de crescimento',
              'استراتيجية النمو',
            ),
          },
        ],
      },
      {
        label: T(
          'Technology',
          'Technologie',
          'Technologie',
          'Tecnología',
          'テクノロジー',
          '技术',
          'Tecnologia',
          'التكنولوجيا',
        ),
        children: [
          {
            label: T(
              'AI and data',
              'KI und Daten',
              'IA et données',
              'IA y datos',
              'AIとデータ',
              '人工智能与数据',
              'IA e dados',
              'الذكاء الاصطناعي والبيانات',
            ),
            slug: 'ai-and-data',
          },
          {
            label: T(
              'Cybersecurity',
              'Cybersicherheit',
              'Cybersécurité',
              'Ciberseguridad',
              'サイバーセキュリティ',
              '网络安全',
              'Cibersegurança',
              'الأمن السيبراني',
            ),
          },
          {
            label: T(
              'Cloud',
              'Cloud',
              'Cloud',
              'Nube',
              'クラウド',
              '云计算',
              'Nuvem',
              'الحوسبة السحابية',
            ),
          },
          {
            label: T(
              'Emerging technology',
              'Neue Technologien',
              'Technologies émergentes',
              'Tecnologías emergentes',
              '新興技術',
              '新兴技术',
              'Tecnologias emergentes',
              'التقنيات الناشئة',
            ),
          },
        ],
      },
      {
        label: T(
          'Sustainability',
          'Nachhaltigkeit',
          'Développement durable',
          'Sostenibilidad',
          'サステナビリティ',
          '可持续发展',
          'Sustentabilidade',
          'الاستدامة',
        ),
        children: [
          {
            label: T(
              'Climate and decarbonization',
              'Klima und Dekarbonisierung',
              'Climat et décarbonation',
              'Clima y descarbonización',
              '気候変動と脱炭素',
              '气候与脱碳',
              'Clima e descarbonização',
              'المناخ وإزالة الكربون',
            ),
            slug: 'climate',
          },
          {
            label: T(
              'Nature and biodiversity',
              'Natur und Biodiversität',
              'Nature et biodiversité',
              'Naturaleza y biodiversidad',
              '自然と生物多様性',
              '自然与生物多样性',
              'Natureza e biodiversidade',
              'الطبيعة والتنوع البيولوجي',
            ),
            slug: 'nature',
          },
          {
            label: T(
              'Sustainability reporting',
              'Nachhaltigkeitsberichterstattung',
              'Reporting de durabilité',
              'Informes de sostenibilidad',
              'サステナビリティ報告',
              '可持续发展报告',
              'Relato de sustentabilidade',
              'تقارير الاستدامة',
            ),
          },
        ],
      },
      {
        label: T(
          'Risk and regulation',
          'Risiko und Regulierung',
          'Risques et réglementation',
          'Riesgo y regulación',
          'リスクと規制',
          '风险与监管',
          'Risco e regulação',
          'المخاطر والتنظيم',
        ),
        children: [
          {
            label: T(
              'Financial crime',
              'Finanzkriminalität',
              'Criminalité financière',
              'Delitos financieros',
              '金融犯罪',
              '金融犯罪',
              'Crimes financeiros',
              'الجرائم المالية',
            ),
          },
          {
            label: T(
              'Regulatory change',
              'Regulatorischer Wandel',
              'Évolutions réglementaires',
              'Cambio regulatorio',
              '規制の変化',
              '监管变革',
              'Mudança regulatória',
              'التغيير التنظيمي',
            ),
          },
          {
            label: T(
              'Internal audit',
              'Interne Revision',
              'Audit interne',
              'Auditoría interna',
              '内部監査',
              '内部审计',
              'Auditoria interna',
              'التدقيق الداخلي',
            ),
          },
        ],
      },
      {
        label: T(
          'Tax and policy',
          'Steuern und Politik',
          'Fiscalité et politiques publiques',
          'Fiscalidad y políticas',
          '税務と政策',
          '税务与政策',
          'Tributos e políticas',
          'الضرائب والسياسات',
        ),
        children: [
          {
            label: T(
              'Global minimum tax',
              'Globale Mindeststeuer',
              'Impôt minimum mondial',
              'Impuesto mínimo global',
              'グローバル・ミニマム課税',
              '全球最低税',
              'Imposto mínimo global',
              'الحد الأدنى العالمي للضريبة',
            ),
          },
          {
            label: T(
              'Indirect tax',
              'Indirekte Steuern',
              'Fiscalité indirecte',
              'Impuestos indirectos',
              '間接税',
              '间接税',
              'Tributos indiretos',
              'الضرائب غير المباشرة',
            ),
          },
          {
            label: T(
              'Tax technology',
              'Steuertechnologie',
              'Technologies fiscales',
              'Tecnología fiscal',
              '税務テクノロジー',
              '税务科技',
              'Tecnologia tributária',
              'تقنيات الضرائب',
            ),
          },
        ],
      },
      {
        label: T(
          'Workforce',
          'Belegschaft',
          'Capital humain',
          'Personas',
          '人材',
          '人才与组织',
          'Força de trabalho',
          'القوى العاملة',
        ),
        children: [
          {
            label: T(
              'Future of work',
              'Zukunft der Arbeit',
              'Avenir du travail',
              'Futuro del trabajo',
              '働き方の未来',
              '未来工作',
              'Futuro do trabalho',
              'مستقبل العمل',
            ),
          },
          {
            label: T(
              'Skills and talent',
              'Kompetenzen und Talente',
              'Compétences et talents',
              'Habilidades y talento',
              'スキルと人材',
              '技能与人才',
              'Habilidades e talentos',
              'المهارات والمواهب',
            ),
          },
        ],
      },
      {
        label: T(
          'Operations',
          'Betrieb',
          'Opérations',
          'Operaciones',
          'オペレーション',
          '运营',
          'Operações',
          'العمليات',
        ),
        children: [
          {
            label: T(
              'Supply chain',
              'Lieferkette',
              'Chaîne d’approvisionnement',
              'Cadena de suministro',
              'サプライチェーン',
              '供应链',
              'Cadeia de suprimentos',
              'سلسلة الإمداد',
            ),
          },
          {
            label: T(
              'Transformation',
              'Transformation',
              'Transformation',
              'Transformación',
              'トランスフォーメーション',
              '转型',
              'Transformação',
              'التحول',
            ),
          },
          {
            label: T(
              'Finance function',
              'Finanzfunktion',
              'Fonction finance',
              'Función financiera',
              '財務機能',
              '财务职能',
              'Função financeira',
              'الوظيفة المالية',
            ),
          },
        ],
      },
    ],
  },
  {
    name: 'Sectors',
    terms: [
      {
        label: T(
          'Financial services',
          'Finanzdienstleistungen',
          'Services financiers',
          'Servicios financieros',
          '金融サービス',
          '金融服务',
          'Serviços financeiros',
          'الخدمات المالية',
        ),
        children: [
          {
            label: T(
              'Banking and capital markets',
              'Banken und Kapitalmärkte',
              'Banque et marchés de capitaux',
              'Banca y mercados de capitales',
              '銀行・資本市場',
              '银行与资本市场',
              'Bancos e mercados de capitais',
              'المصارف وأسواق رأس المال',
            ),
            slug: 'banking',
          },
          {
            label: T(
              'Insurance',
              'Versicherungen',
              'Assurance',
              'Seguros',
              '保険',
              '保险',
              'Seguros',
              'التأمين',
            ),
          },
          {
            label: T(
              'Wealth and asset management',
              'Vermögensverwaltung',
              'Gestion de patrimoine et d’actifs',
              'Gestión de patrimonios y activos',
              'ウェルス・アセットマネジメント',
              '财富与资产管理',
              'Gestão de patrimônio e ativos',
              'إدارة الثروات والأصول',
            ),
            slug: 'wealth',
          },
        ],
      },
      {
        label: T(
          'Consumer and health',
          'Konsum und Gesundheit',
          'Consommation et santé',
          'Consumo y salud',
          '消費財・ヘルスケア',
          '消费与医疗',
          'Consumo e saúde',
          'الاستهلاك والصحة',
        ),
        children: [
          {
            label: T(
              'Consumer products and retail',
              'Konsumgüter und Handel',
              'Produits de grande consommation et distribution',
              'Consumo y distribución',
              '消費財・小売',
              '消费品与零售',
              'Bens de consumo e varejo',
              'السلع الاستهلاكية والتجزئة',
            ),
            slug: 'consumer',
          },
          {
            label: T(
              'Health',
              'Gesundheit',
              'Santé',
              'Salud',
              'ヘルスケア',
              '医疗健康',
              'Saúde',
              'الرعاية الصحية',
            ),
          },
          {
            label: T(
              'Life sciences',
              'Life Sciences',
              'Sciences de la vie',
              'Ciencias de la vida',
              'ライフサイエンス',
              '生命科学',
              'Ciências da vida',
              'علوم الحياة',
            ),
          },
        ],
      },
      {
        label: T(
          'Energy and resources',
          'Energie und Rohstoffe',
          'Énergie et ressources',
          'Energía y recursos',
          'エネルギー・資源',
          '能源与资源',
          'Energia e recursos',
          'الطاقة والموارد',
        ),
        children: [
          {
            label: T(
              'Power and utilities',
              'Energieversorgung',
              'Énergie et services publics',
              'Energía y servicios públicos',
              '電力・公益',
              '电力与公用事业',
              'Energia e utilities',
              'الطاقة والمرافق',
            ),
            slug: 'power',
          },
          {
            label: T(
              'Mining and metals',
              'Bergbau und Metalle',
              'Mines et métaux',
              'Minería y metales',
              '鉱業・金属',
              '矿业与金属',
              'Mineração e metais',
              'التعدين والمعادن',
            ),
            slug: 'mining',
          },
        ],
      },
      {
        label: T(
          'Technology, media and telecom',
          'Technologie, Medien und Telekommunikation',
          'Technologies, médias et télécoms',
          'Tecnología, medios y telecomunicaciones',
          'テクノロジー・メディア・通信',
          '科技、媒体与通信',
          'Tecnologia, mídia e telecomunicações',
          'التكنولوجيا والإعلام والاتصالات',
        ),
        slug: 'tmt',
        children: [
          {
            label: T(
              'Technology sector',
              'Technologiebranche',
              'Secteur technologique',
              'Sector tecnológico',
              'テクノロジー業界',
              '科技行业',
              'Setor de tecnologia',
              'قطاع التكنولوجيا',
            ),
            slug: 'technology-sector',
          },
          {
            label: T(
              'Telecommunications',
              'Telekommunikation',
              'Télécommunications',
              'Telecomunicaciones',
              '通信',
              '电信',
              'Telecomunicações',
              'الاتصالات',
            ),
          },
        ],
      },
      {
        label: T(
          'Industrials',
          'Industrie',
          'Industrie',
          'Industria',
          '製造業',
          '工业',
          'Indústria',
          'الصناعة',
        ),
        children: [
          {
            label: T(
              'Advanced manufacturing',
              'Fortschrittliche Fertigung',
              'Industrie avancée',
              'Fabricación avanzada',
              '先端製造',
              '先进制造',
              'Manufatura avançada',
              'التصنيع المتقدم',
            ),
          },
          {
            label: T(
              'Mobility',
              'Mobilität',
              'Mobilité',
              'Movilidad',
              'モビリティ',
              '出行',
              'Mobilidade',
              'التنقل',
            ),
          },
        ],
      },
      {
        label: T(
          'Government and public sector',
          'Öffentlicher Sektor',
          'Secteur public',
          'Sector público',
          '官公庁・公共',
          '政府与公共部门',
          'Governo e setor público',
          'الحكومة والقطاع العام',
        ),
        slug: 'public-sector',
      },
    ],
  },
  {
    name: 'Regions',
    terms: [
      {
        label: T(
          'Americas',
          'Amerika',
          'Amériques',
          'América',
          '米州',
          '美洲',
          'Américas',
          'الأمريكتان',
        ),
        children: [
          {
            label: T(
              'United States',
              'Vereinigte Staaten',
              'États-Unis',
              'Estados Unidos',
              '米国',
              '美国',
              'Estados Unidos',
              'الولايات المتحدة',
            ),
            slug: 'us',
          },
          {
            label: T('Canada', 'Kanada', 'Canada', 'Canadá', 'カナダ', '加拿大', 'Canadá', 'كندا'),
            slug: 'ca',
          },
          {
            label: T(
              'Latin America',
              'Lateinamerika',
              'Amérique latine',
              'Latinoamérica',
              '中南米',
              '拉丁美洲',
              'América Latina',
              'أمريكا اللاتينية',
            ),
            slug: 'latam',
          },
        ],
      },
      {
        label: T(
          'Europe, Middle East, India and Africa',
          'Europa, Naher Osten, Indien und Afrika',
          'Europe, Moyen-Orient, Inde et Afrique',
          'Europa, Oriente Medio, India y África',
          '欧州・中東・インド・アフリカ',
          '欧洲、中东、印度和非洲',
          'Europa, Oriente Médio, Índia e África',
          'أوروبا والشرق الأوسط والهند وأفريقيا',
        ),
        slug: 'emeia',
        children: [
          {
            label: T(
              'United Kingdom',
              'Vereinigtes Königreich',
              'Royaume-Uni',
              'Reino Unido',
              '英国',
              '英国',
              'Reino Unido',
              'المملكة المتحدة',
            ),
            slug: 'uk',
          },
          {
            label: T('DACH', 'DACH', 'DACH', 'DACH', 'DACH', '德奥瑞', 'DACH', 'دول داخ'),
            slug: 'dach',
          },
          {
            label: T(
              'Western Europe',
              'Westeuropa',
              'Europe de l’Ouest',
              'Europa Occidental',
              '西欧',
              '西欧',
              'Europa Ocidental',
              'أوروبا الغربية',
            ),
            slug: 'western-europe',
          },
          {
            label: T(
              'Middle East',
              'Naher Osten',
              'Moyen-Orient',
              'Oriente Medio',
              '中東',
              '中东',
              'Oriente Médio',
              'الشرق الأوسط',
            ),
            slug: 'middle-east',
          },
        ],
      },
      {
        label: T(
          'Asia-Pacific',
          'Asien-Pazifik',
          'Asie-Pacifique',
          'Asia-Pacífico',
          'アジア太平洋',
          '亚太',
          'Ásia-Pacífico',
          'آسيا والمحيط الهادئ',
        ),
        slug: 'apac',
        children: [
          {
            label: T('Japan', 'Japan', 'Japon', 'Japón', '日本', '日本', 'Japão', 'اليابان'),
            slug: 'jp',
          },
          {
            label: T(
              'Greater China',
              'Großchina',
              'Grande Chine',
              'Gran China',
              '中華圏',
              '大中华区',
              'Grande China',
              'الصين الكبرى',
            ),
            slug: 'greater-china',
          },
          {
            label: T(
              'Oceania',
              'Ozeanien',
              'Océanie',
              'Oceanía',
              'オセアニア',
              '大洋洲',
              'Oceania',
              'أوقيانوسيا',
            ),
            slug: 'oceania',
          },
          {
            label: T(
              'Southeast Asia',
              'Südostasien',
              'Asie du Sud-Est',
              'Sudeste Asiático',
              '東南アジア',
              '东南亚',
              'Sudeste Asiático',
              'جنوب شرق آسيا',
            ),
            slug: 'sea',
          },
        ],
      },
    ],
  },
  {
    name: 'Audiences',
    terms: [
      {
        label: T(
          'Chief executive',
          'Vorstandsvorsitz',
          'Direction générale',
          'Consejero delegado',
          'CEO',
          '首席执行官',
          'CEO',
          'الرئيس التنفيذي',
        ),
        slug: 'ceo',
      },
      {
        label: T(
          'Chief financial officer',
          'Finanzvorstand',
          'Direction financière',
          'Director financiero',
          'CFO',
          '首席财务官',
          'CFO',
          'المدير المالي',
        ),
        slug: 'cfo',
      },
      {
        label: T(
          'Chief information officer',
          'IT-Leitung',
          'Direction des systèmes d’information',
          'Director de sistemas',
          'CIO',
          '首席信息官',
          'CIO',
          'مدير تقنية المعلومات',
        ),
        slug: 'cio',
      },
      {
        label: T(
          'Chief information security officer',
          'Informationssicherheit',
          'Sécurité des systèmes d’information',
          'Director de ciberseguridad',
          'CISO',
          '首席信息安全官',
          'CISO',
          'مدير أمن المعلومات',
        ),
        slug: 'ciso',
      },
      {
        label: T(
          'Chief people officer',
          'Personalvorstand',
          'Direction des ressources humaines',
          'Director de personas',
          'CHRO',
          '首席人力资源官',
          'CHRO',
          'مدير الموارد البشرية',
        ),
        slug: 'chro',
      },
      {
        label: T(
          'Chief sustainability officer',
          'Nachhaltigkeitsleitung',
          'Direction du développement durable',
          'Director de sostenibilidad',
          'CSO',
          '首席可持续发展官',
          'CSO',
          'مدير الاستدامة',
        ),
        slug: 'cso',
      },
      {
        label: T(
          'Board member',
          'Aufsichtsrat',
          'Administrateur',
          'Consejero',
          '取締役',
          '董事会成员',
          'Conselheiro',
          'عضو مجلس الإدارة',
        ),
        slug: 'board',
      },
      {
        label: T(
          'General counsel',
          'Rechtsabteilung',
          'Direction juridique',
          'Director jurídico',
          '法務責任者',
          '总法律顾问',
          'Diretor jurídico',
          'المستشار القانوني العام',
        ),
        slug: 'general-counsel',
      },
    ],
  },
  {
    name: 'Jurisdictions',
    terms: [
      { label: { en: 'United States' }, slug: 'jurisdiction-us' },
      { label: { en: 'United Kingdom' }, slug: 'jurisdiction-gb' },
      { label: { en: 'Germany', 'de-DE': 'Deutschland' }, slug: 'jurisdiction-de' },
      { label: { en: 'France', 'fr-FR': 'France' }, slug: 'jurisdiction-fr' },
      { label: { en: 'Japan', 'ja-JP': '日本' }, slug: 'jurisdiction-jp' },
      { label: { en: 'Brazil', 'pt-BR': 'Brasil' }, slug: 'jurisdiction-br' },
      {
        label: { en: 'United Arab Emirates', 'ar-AE': 'الإمارات العربية المتحدة' },
        slug: 'jurisdiction-ae',
      },
      { label: { en: 'European Union' }, slug: 'jurisdiction-eu' },
      { label: { en: 'OECD' }, slug: 'jurisdiction-oecd' },
    ],
  },
];

/** Editorial and operational flags: what teams filter, gate and report by. */
export const TAGS: readonly { name: string; description: string; label?: Tr }[] = [
  { name: 'tier-1', description: 'Flagship thought leadership: boosted in search and on hubs.' },
  { name: 'featured', description: 'Eligible for the home page spotlight.' },
  { name: 'evergreen', description: 'No natural expiry; reviewed yearly.' },
  { name: 'embargoed', description: 'Must not publish before its embargo lifts.' },
  { name: 'legal', description: 'Routes the entry through Legal & Risk review.' },
  { name: 'client-named', description: 'Names a client: needs signed client clearance.' },
  { name: 'global-rollout', description: 'Global master rolled out to every market.' },
  { name: 'local-only', description: 'Written for one market; not rolled out.' },
  { name: 'refresh-due', description: 'Past its review date; owner notified.' },
  { name: 'ai-assisted', description: 'Drafted or translated with AI; human-reviewed.' },
  { name: 'translation-pending', description: 'Waiting on the translation team.' },
  { name: 'sme-reviewed', description: 'Signed off by the named subject-matter expert.' },
  {
    name: 'accessibility-checked',
    description: 'Alt text, contrast and chart descriptions checked.',
  },
  { name: 'campaign-ceo-outlook', description: 'Part of the CEO Outlook 2027 launch.' },
  { name: 'campaign-impact-report', description: 'Part of the 2026 Impact Report.' },
  { name: 'sub-brand-vantage', description: 'Published under Aldermoor Vantage.' },
  { name: 'gated', description: 'Download behind a form.' },
  { name: 'cpe', description: 'Carries CPE credit.' },
];

/** Every scheme, concept and tag, each found by name before it's created. */
export async function seedEnterpriseTaxonomy(run: EnterpriseRun): Promise<void> {
  const { ctx, scope, space } = run;
  const tags = await listTags(ctx, scope);
  for (const tag of TAGS) {
    if (tags.some((t) => t.name === tag.name)) continue;
    await createTag(ctx, scope, { name: tag.name, description: tag.description });
  }

  const schemes = await listSchemes(ctx, scope);
  for (const def of SCHEMES) {
    const scheme =
      schemes.find((s) => s.name === def.name) ??
      (await createScheme(ctx, scope, { name: def.name }));
    const existing = await listConcepts(ctx, scope, scheme.id);
    const ensure = async (term: TermDef, broaderId: string | null) => {
      const labels = loc(term.label, space);
      const prefLabel = labels[space.defaultLocale] as string;
      // Keyed by an English-derived slug, so the keys hold whatever the space's default locale.
      const slug = term.slug ?? slugify(term.label.en);
      const found = existing.find((c) => c.slug === slug);
      if (found) return found.id;
      const concept = await createConcept(ctx, scope, {
        schemeId: scheme.id,
        prefLabel,
        broaderId,
        labels,
        slug,
        ...(term.description ? { description: term.description } : {}),
      });
      existing.push(concept);
      return concept.id;
    };
    for (const term of def.terms) {
      const parent = await ensure(term, null);
      for (const child of term.children ?? []) await ensure(child, parent);
    }
  }
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** The concept key `ensureEntries` resolves: `Scheme/slug`. */
export const topic = (slug: string) => `Topics/${slug}`;
export const sector = (slug: string) => `Sectors/${slug}`;
export const region = (slug: string) => `Regions/${slug}`;
export const audience = (slug: string) => `Audiences/${slug}`;
