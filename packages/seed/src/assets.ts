import {
  assetObjectKey,
  createAsset,
  listAssets,
  publishAsset,
  setAssetMetadata,
} from '@commerceworker/application';
import type { BlobStore } from '@commerceworker/ports';
import { logger } from '@commerceworker/telemetry';
import { localized, pick } from './helpers';
import { placeholderPdf, placeholderPng } from './placeholders';
import type { SeedRun } from './types';

export const FILES = [
  { fileName: 'hero-coastline.png', contentType: 'image/png', title: 'Coastline at dawn' },
  { fileName: 'team-offsite.png', contentType: 'image/png', title: 'Team offsite' },
  { fileName: 'product-shot-01.png', contentType: 'image/png', title: 'Product shot 1' },
  { fileName: 'product-shot-02.png', contentType: 'image/png', title: 'Product shot 2' },
  { fileName: 'product-shot-03.png', contentType: 'image/png', title: 'Product shot 3' },
  { fileName: 'product-shot-04.png', contentType: 'image/png', title: 'Product shot 4' },
  { fileName: 'architecture-diagram.png', contentType: 'image/png', title: 'Architecture diagram' },
  { fileName: 'workflow-flowchart.png', contentType: 'image/png', title: 'Workflow flowchart' },
  { fileName: 'dashboard-screenshot.png', contentType: 'image/png', title: 'Dashboard screenshot' },
  { fileName: 'launch-keynote.mp4', contentType: 'video/mp4', title: 'Launch keynote' },
  { fileName: 'demo-walkthrough.mp4', contentType: 'video/mp4', title: 'Demo walkthrough' },
  { fileName: 'whitepaper.pdf', contentType: 'application/pdf', title: 'Platform whitepaper' },
  { fileName: 'press-kit.pdf', contentType: 'application/pdf', title: 'Press kit' },
  { fileName: 'benchmark-report.pdf', contentType: 'application/pdf', title: 'Benchmark report' },
  { fileName: 'conference-stage.png', contentType: 'image/png', title: 'Conference stage' },
  { fileName: 'speaker-portrait.png', contentType: 'image/png', title: 'Speaker portrait' },
  { fileName: 'recipe-plating.png', contentType: 'image/png', title: 'Plated dish' },
  { fileName: 'kitchen-prep.png', contentType: 'image/png', title: 'Kitchen prep' },
  { fileName: 'city-skyline.png', contentType: 'image/png', title: 'City skyline' },
  { fileName: 'brand-guidelines.pdf', contentType: 'application/pdf', title: 'Brand guidelines' },
] as const;

const DE_TITLES: Record<string, string> = {
  'Coastline at dawn': 'Küste im Morgengrauen',
  'Team offsite': 'Team-Offsite',
  'Architecture diagram': 'Architekturdiagramm',
  'Plated dish': 'Angerichtetes Gericht',
  'City skyline': 'Stadtsilhouette',
};

/** Gradient pairs for the placeholder images, one per image in turn. */
const PALETTE: readonly (readonly [
  readonly [number, number, number],
  readonly [number, number, number],
])[] = [
  [
    [14, 116, 144],
    [253, 186, 116],
  ],
  [
    [30, 64, 175],
    [167, 243, 208],
  ],
  [
    [88, 28, 135],
    [251, 207, 232],
  ],
  [
    [21, 128, 61],
    [254, 240, 138],
  ],
  [
    [154, 52, 18],
    [254, 215, 170],
  ],
  [
    [15, 23, 42],
    [148, 163, 184],
  ],
];

/**
 * The bytes for a demo file, generated (no fixtures): a gradient PNG for images, a one-page PDF
 * for documents. Videos stay metadata only: they live on the video host, not in blob storage.
 */
type DemoFile = (typeof FILES)[number];

function placeholderFor(file: DemoFile, i: number): string | Uint8Array | undefined {
  if (file.contentType === 'image/png') {
    const [from, to] = PALETTE[i % PALETTE.length] as (typeof PALETTE)[number];
    return placeholderPng(480, 300, from, to);
  }
  if (file.contentType === 'application/pdf') return placeholderPdf(file.title);
  return undefined;
}

/**
 * Twenty demo assets across image/video/pdf types. Images and documents get generated
 * placeholder bytes in blob storage (so the media library and transforms show real files);
 * videos stay metadata only. The last two stay drafts so the media library shows both statuses.
 * Returns published asset ids for links.
 */
export async function seedAssets(
  run: SeedRun,
  blob: BlobStore,
  files: readonly DemoFile[] = FILES,
): Promise<string[]> {
  const { ctx, scope, locale, hasDe } = run;

  const existing = (await listAssets(ctx, scope, { limit: files.length + 10 })).items;
  if (existing.length > 0) {
    return existing.filter((a) => a.status === 'published').map((a) => a.id);
  }

  const publishedIds: string[] = [];
  for (const [i, file] of files.entries()) {
    const de = hasDe ? DE_TITLES[file.title] : undefined;
    const { asset } = await createAsset(ctx, blob, scope, {
      fileName: file.fileName,
      contentType: file.contentType,
      title: localized(locale, file.title, de ? { 'de-DE': de } : undefined) as Record<
        string,
        string
      >,
      description: localized(locale, `${file.title}: sample media.`) as Record<string, string>,
    });
    const bytes = placeholderFor(file, i);
    if (bytes !== undefined) {
      await blob.put(assetObjectKey(scope, asset.id, file.fileName), bytes, file.contentType);
    }
    if (i % 2 === 0) {
      await setAssetMetadata(ctx, scope, asset.id, {
        altText: localized(
          locale,
          `${file.title} (alt text)`,
          de ? { 'de-DE': `${de} (Alternativtext)` } : undefined,
        ) as Record<string, string>,
        tags: [pick(['brand', 'press', 'product', 'event', 'editorial'] as const, i)],
        focalPoint: { x: 0.25 + (i % 3) * 0.25, y: 0.35 + (i % 2) * 0.3 },
      });
    }
    const publish = i < files.length - 2;
    if (publish) {
      await publishAsset(ctx, scope, asset.id);
      publishedIds.push(asset.id);
    }
  }
  logger.info({ assets: files.length }, 'seed: created assets');
  return publishedIds;
}
