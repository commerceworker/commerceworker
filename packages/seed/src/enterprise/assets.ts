import {
  addToAssetCollection,
  allAssets,
  assetObjectKey,
  createAsset,
  createAssetCollection,
  createAssetFolder,
  listAssetCollections,
  listAssetFolders,
  moveAssets,
  publishAsset,
  setAssetMetadata,
  setAssetRights,
} from '@commerceworker/application';
import { logger } from '@commerceworker/telemetry';
import { placeholderPdf, placeholderPng } from '../placeholders';
import { BRAND, loc, type Tr } from './brand';
import { dayOffset } from './entries';
import type { EnterpriseRun } from './run';

/**
 * The brand's media library: heroes, portraits, office photography, report PDFs and press kit
 * files, filed in folders, grouped in collections, with credits and licences, one licence that
 * expires, one image under embargo until a launch, localized alt text and focal points. The bytes
 * are generated (a gradient PNG, a one-page PDF), so the repo carries no binaries.
 */

type Kind = 'image' | 'pdf';
interface FileDef {
  readonly file: string;
  readonly kind: Kind;
  readonly folder: string;
  readonly title: Tr;
  readonly alt?: Tr;
  readonly credit?: string;
  readonly license?: string;
  readonly expiresInDays?: number;
  readonly embargoDays?: number;
  readonly draft?: boolean;
  readonly focal?: readonly [number, number];
  readonly collections?: readonly string[];
}

const STUDIO = `${BRAND.name} Brand Studio`;
const LICENSED = 'Licensed for worldwide digital and print use';

const img = (
  file: string,
  folder: string,
  title: Tr,
  alt: Tr,
  extra: Partial<FileDef> = {},
): FileDef => ({
  file,
  kind: 'image',
  folder,
  title,
  alt,
  credit: STUDIO,
  license: 'Owned by Aldermoor',
  ...extra,
});
const pdf = (file: string, folder: string, title: Tr, extra: Partial<FileDef> = {}): FileDef => ({
  file,
  kind: 'pdf',
  folder,
  title,
  ...extra,
});

export const FILES: readonly FileDef[] = [
  img(
    'hero-horizon.png',
    'Brand/Heroes',
    {
      en: 'Horizon over the estuary',
      'de-DE': 'Horizont über der Flussmündung',
      'fr-FR': 'Horizon sur l’estuaire',
      'ja-JP': '河口の地平線',
    },
    {
      en: 'Morning light over a wide estuary, a city skyline on the far bank',
      'de-DE': 'Morgenlicht über einer weiten Flussmündung, am anderen Ufer eine Stadtsilhouette',
      'fr-FR': 'Lumière du matin sur un large estuaire, une ville sur l’autre rive',
      'ja-JP': '広い河口に差す朝の光と対岸の街並み',
    },
    { focal: [0.62, 0.4], collections: ['Brand heroes'] },
  ),
  img(
    'hero-boardroom.png',
    'Brand/Heroes',
    { en: 'Boardroom conversation' },
    {
      en: 'Four executives in conversation around a table by a tall window',
      'de-DE': 'Vier Führungskräfte im Gespräch an einem Tisch vor einem hohen Fenster',
    },
    { focal: [0.45, 0.35], collections: ['Brand heroes'] },
  ),
  img(
    'hero-data-grid.png',
    'Brand/Heroes',
    { en: 'Data in motion' },
    { en: 'Abstract lines of light forming a grid, suggesting data flowing between systems' },
    { collections: ['Brand heroes'] },
  ),
  img(
    'hero-wind-farm.png',
    'Brand/Heroes',
    { en: 'Offshore wind at dusk', 'de-DE': 'Offshore-Windpark in der Dämmerung' },
    {
      en: 'Offshore wind turbines in a line at dusk',
      'de-DE': 'Offshore-Windräder in einer Reihe in der Dämmerung',
    },
    {
      credit: 'Northlight Images',
      license: LICENSED,
      focal: [0.3, 0.55],
      collections: ['Brand heroes', 'Impact Report 2026'],
    },
  ),
  img(
    'hero-port.png',
    'Brand/Heroes',
    { en: 'Container port' },
    { en: 'Stacked shipping containers and cranes at a busy port' },
    { credit: 'Northlight Images', license: LICENSED, expiresInDays: 45 },
  ),
  img(
    'hero-lab.png',
    'Brand/Heroes',
    { en: 'Laboratory bench' },
    { en: 'A scientist pipetting samples at a laboratory bench' },
  ),
  img(
    'hero-factory.png',
    'Brand/Heroes',
    { en: 'Assembly line robotics' },
    { en: 'Robotic arms working along a bright assembly line' },
  ),
  img(
    'hero-trading-floor.png',
    'Brand/Heroes',
    { en: 'Trading floor' },
    { en: 'Rows of screens showing market data on a quiet trading floor' },
  ),
  img(
    'hero-classroom.png',
    'Careers',
    { en: 'Graduate cohort' },
    {
      en: 'A group of graduates working together in a training room',
      'fr-FR': 'Un groupe de jeunes diplômés travaillant ensemble en salle de formation',
    },
    { collections: ['Careers campaign'] },
  ),
  img(
    'hero-mentoring.png',
    'Careers',
    { en: 'Mentoring session' },
    { en: 'Two colleagues reviewing a laptop together' },
    { collections: ['Careers campaign'] },
  ),
  img(
    'campaign-ceo-outlook.png',
    'Campaigns/CEO Outlook 2027',
    {
      en: 'CEO Outlook 2027 key visual',
      'de-DE': 'CEO Outlook 2027 Key Visual',
      'ja-JP': 'CEOアウトルック2027 キービジュアル',
    },
    { en: 'The CEO Outlook 2027 cover: a compass needle over a map of trade routes' },
    { embargoDays: 9, collections: ['CEO Outlook 2027 launch kit'] },
  ),
  img(
    'campaign-impact-report.png',
    'Campaigns/Impact Report 2026',
    { en: 'Impact Report 2026 cover' },
    { en: 'Impact Report 2026 cover: a forest canopy seen from above' },
    { collections: ['Impact Report 2026'] },
  ),
  img(
    'chart-ceo-confidence.png',
    'Campaigns/CEO Outlook 2027',
    { en: 'Chart: CEO confidence by region' },
    { en: 'Bar chart of CEO confidence in growth by region, Americas highest at 71%' },
    { collections: ['CEO Outlook 2027 launch kit'] },
  ),
  img(
    'chart-minimum-tax.png',
    'Insights/Charts',
    { en: 'Chart: minimum tax adoption' },
    { en: 'Map shading the jurisdictions that have adopted a global minimum tax' },
  ),
  img(
    'chart-cyber-incidents.png',
    'Insights/Charts',
    { en: 'Chart: incident response times' },
    { en: 'Line chart: median time to contain an incident falling from 21 to 9 days' },
  ),
  img(
    'portrait-amara-okafor.png',
    'People/Portraits',
    { en: 'Amara Okafor' },
    { en: 'Portrait of Amara Okafor' },
    { focal: [0.5, 0.3] },
  ),
  img(
    'portrait-henrik-lindqvist.png',
    'People/Portraits',
    { en: 'Henrik Lindqvist' },
    { en: 'Portrait of Henrik Lindqvist' },
    { focal: [0.5, 0.3] },
  ),
  img(
    'portrait-mei-tanaka.png',
    'People/Portraits',
    { en: 'Mei Tanaka', 'ja-JP': '田中 芽衣' },
    { en: 'Portrait of Mei Tanaka', 'ja-JP': '田中芽衣の肖像' },
    { focal: [0.5, 0.3] },
  ),
  img(
    'portrait-rafael-duarte.png',
    'People/Portraits',
    { en: 'Rafael Duarte' },
    { en: 'Portrait of Rafael Duarte' },
    { focal: [0.5, 0.3] },
  ),
  img(
    'portrait-claire-dubois.png',
    'People/Portraits',
    { en: 'Claire Dubois' },
    { en: 'Portrait of Claire Dubois' },
    { focal: [0.5, 0.3] },
  ),
  img(
    'portrait-tobias-weber.png',
    'People/Portraits',
    { en: 'Tobias Weber' },
    { en: 'Portrait of Tobias Weber' },
    { focal: [0.5, 0.3] },
  ),
  img(
    'portrait-layla-haddad.png',
    'People/Portraits',
    { en: 'Layla Haddad', 'ar-AE': 'ليلى حداد' },
    { en: 'Portrait of Layla Haddad', 'ar-AE': 'صورة ليلى حداد' },
    { focal: [0.5, 0.3] },
  ),
  img(
    'portrait-wei-chen.png',
    'People/Portraits',
    { en: 'Chen Wei', 'zh-CN': '陈伟' },
    { en: 'Portrait of Chen Wei', 'zh-CN': '陈伟的肖像' },
    { focal: [0.5, 0.3] },
  ),
  img(
    'portrait-placeholder.png',
    'People/Portraits',
    { en: 'Portrait placeholder' },
    { en: 'Silhouette used when no portrait is available' },
  ),
  img(
    'office-london.png',
    'Offices',
    { en: 'London office, Moorgate' },
    { en: 'The glass atrium of the London office' },
  ),
  img(
    'office-new-york.png',
    'Offices',
    { en: 'New York office, Hudson Yards' },
    { en: 'The lobby of the New York office' },
  ),
  img(
    'office-frankfurt.png',
    'Offices',
    { en: 'Frankfurt office', 'de-DE': 'Büro Frankfurt' },
    {
      en: 'The Frankfurt office tower at night',
      'de-DE': 'Das Frankfurter Bürohochhaus bei Nacht',
    },
  ),
  img(
    'office-tokyo.png',
    'Offices',
    { en: 'Tokyo office, Marunouchi', 'ja-JP': '東京オフィス（丸の内）' },
    { en: 'The Tokyo office entrance', 'ja-JP': '東京オフィスのエントランス' },
  ),
  img(
    'office-dubai.png',
    'Offices',
    { en: 'Dubai office', 'ar-AE': 'مكتب دبي' },
    { en: 'The Dubai office in the financial district', 'ar-AE': 'مكتب دبي في الحي المالي' },
  ),
  img(
    'logo-northgrid.png',
    'Partners',
    { en: 'Northgrid Cloud logo' },
    { en: 'Northgrid Cloud logo' },
    { credit: 'Northgrid Cloud', license: 'Partner logo, used under the alliance agreement' },
  ),
  img(
    'logo-quillon.png',
    'Partners',
    { en: 'Quillon Data logo' },
    { en: 'Quillon Data logo' },
    { credit: 'Quillon Data', license: 'Partner logo, used under the alliance agreement' },
  ),
  img(
    'logo-halcyon.png',
    'Partners',
    { en: 'Halcyon ERP logo' },
    { en: 'Halcyon ERP logo' },
    { credit: 'Halcyon', license: 'Partner logo, used under the alliance agreement' },
  ),
  img(
    'logo-sentrix.png',
    'Partners',
    { en: 'Sentrix Security logo' },
    { en: 'Sentrix Security logo' },
    { credit: 'Sentrix', license: 'Partner logo, used under the alliance agreement' },
  ),
  img(
    'logo-verdant.png',
    'Partners',
    { en: 'Verdant Ledger logo' },
    { en: 'Verdant Ledger logo' },
    { credit: 'Verdant Ledger', license: 'Partner logo, used under the alliance agreement' },
  ),
  img(
    'press-headshots.png',
    'Press',
    { en: 'Leadership headshots sheet' },
    { en: 'A contact sheet of leadership headshots for press use' },
    { collections: ['Press kit'] },
  ),
  img(
    'hero-draft-concept.png',
    'Brand/Heroes',
    { en: 'Concept: city at night (draft)' },
    { en: 'Concept art of a city at night, not approved' },
    { draft: true },
  ),
  pdf(
    'ceo-outlook-2027.pdf',
    'Campaigns/CEO Outlook 2027',
    {
      en: 'CEO Outlook 2027 (full report)',
      'de-DE': 'CEO Outlook 2027 (vollständiger Bericht)',
      'ja-JP': 'CEOアウトルック2027（全文）',
    },
    { embargoDays: 9, collections: ['CEO Outlook 2027 launch kit'] },
  ),
  pdf(
    'impact-report-2026.pdf',
    'Campaigns/Impact Report 2026',
    { en: 'Impact Report 2026' },
    { collections: ['Impact Report 2026'] },
  ),
  pdf('global-tax-policy-index-w6.pdf', 'Insights/Reports', {
    en: 'Global Tax Policy Index, wave 6',
  }),
  pdf('cyber-resilience-index-2026.pdf', 'Insights/Reports', { en: 'Cyber Resilience Index 2026' }),
  pdf('climate-transition-barometer.pdf', 'Insights/Reports', {
    en: 'Climate Transition Barometer',
  }),
  pdf('press-kit-2026.pdf', 'Press', { en: 'Press kit 2026' }, { collections: ['Press kit'] }),
  pdf('brand-guidelines.pdf', 'Brand', { en: 'Brand guidelines v4' }, { draft: true }),
  pdf('cpe-sponsor-statement.pdf', 'Legal', { en: 'CPE sponsor statement' }),
];

const COLLECTIONS: Readonly<Record<string, string>> = {
  'Brand heroes': 'Approved hero images for any page. Check the focal point on phones.',
  'CEO Outlook 2027 launch kit': 'Everything that ships with the CEO Outlook launch. Embargoed.',
  'Impact Report 2026': 'Cover, PDF and supporting imagery for the 2026 Impact Report.',
  'Press kit': 'Approved for media use.',
  'Careers campaign': 'Imagery for the graduate and experienced-hire campaigns.',
};

/** Brand gradients: deep teal to amber, ink to sky, moss to sand. */
const PALETTE: readonly (readonly [
  readonly [number, number, number],
  readonly [number, number, number],
])[] = [
  [
    [8, 51, 68],
    [244, 162, 89],
  ],
  [
    [17, 24, 39],
    [125, 211, 252],
  ],
  [
    [22, 78, 56],
    [234, 221, 186],
  ],
  [
    [49, 46, 129],
    [196, 181, 253],
  ],
];

/** Asset ids by file name, so later phases can link to them. */
export async function assetIdsByFile(run: EnterpriseRun): Promise<Map<string, string>> {
  const assets = await allAssets(run.ctx, run.scope);
  return new Map(assets.map((a) => [a.file.fileName, a.id]));
}

export async function seedEnterpriseAssets(run: EnterpriseRun): Promise<void> {
  const { ctx, scope, space, blob } = run;
  if (!blob) return;
  const now = ctx.clock.now();
  const byFile = await assetIdsByFile(run);

  // Folders, created along each path.
  const folders = await listAssetFolders(ctx, scope);
  const folderId = new Map(folders.map((f) => [f.path ?? f.name, f.id]));
  const ensureFolder = async (path: string): Promise<string> => {
    const known = folderId.get(path);
    if (known) return known;
    const parts = path.split('/');
    const name = parts.pop() as string;
    const parentId = parts.length ? await ensureFolder(parts.join('/')) : undefined;
    const existing = folders.find((f) => f.name === name && (f.parentId ?? undefined) === parentId);
    const id =
      existing?.id ??
      (await createAssetFolder(ctx, scope, { name, ...(parentId ? { parentId } : {}) })).id;
    folderId.set(path, id);
    return id;
  };

  let created = 0;
  for (const [n, f] of FILES.entries()) {
    if (byFile.has(f.file)) continue;
    const contentType = f.kind === 'image' ? 'image/png' : 'application/pdf';
    const { asset } = await createAsset(ctx, blob, scope, {
      fileName: f.file,
      contentType,
      title: loc(f.title, space),
      description: loc(`${f.title.en}. ${BRAND.name} media library.`, space),
    });
    const [from, to] = PALETTE[n % PALETTE.length] as (typeof PALETTE)[number];
    const bytes =
      f.kind === 'image' ? placeholderPng(640, 400, from, to) : placeholderPdf(f.title.en);
    await blob.put(assetObjectKey(scope, asset.id, f.file), bytes, contentType);
    await setAssetMetadata(ctx, scope, asset.id, {
      ...(f.alt ? { altText: loc(f.alt, space) } : {}),
      ...(f.focal ? { focalPoint: { x: f.focal[0], y: f.focal[1] } } : {}),
      fields: { owner: f.folder.split('/')[0], usage: f.collections?.[0] ?? 'general' },
    });
    if (f.credit || f.license || f.expiresInDays || f.embargoDays) {
      await setAssetRights(ctx, scope, asset.id, {
        ...(f.credit ? { credit: f.credit } : {}),
        ...(f.license ? { license: f.license } : {}),
        ...(f.expiresInDays ? { expiresAt: dayOffset(now, f.expiresInDays) } : {}),
        ...(f.embargoDays ? { embargoUntil: dayOffset(now, f.embargoDays, 13) } : {}),
      });
    }
    await moveAssets(ctx, scope, { ids: [asset.id], folderId: await ensureFolder(f.folder) });
    if (!f.draft && !f.embargoDays) await publishAsset(ctx, scope, asset.id);
    byFile.set(f.file, asset.id);
    created++;
  }

  const { items: collections } = await listAssetCollections(ctx, scope, {});
  for (const [name, description] of Object.entries(COLLECTIONS)) {
    const members = FILES.filter((f) => f.collections?.includes(name))
      .map((f) => byFile.get(f.file))
      .filter((id): id is string => !!id);
    const collection =
      collections.find((c) => c.name === name) ??
      (await createAssetCollection(ctx, scope, { name, description }));
    if (members.length) await addToAssetCollection(ctx, scope, collection.id, members);
  }
  if (created) logger.info({ created }, 'starter: enterprise assets');
}
