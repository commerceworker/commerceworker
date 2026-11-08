import {
  createContentType,
  createEntry,
  getContentType,
  listPreviewEntries,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  setEntryMetadata,
  updateEntry,
} from '@commerceworker/application';
import type { ContentTypeDraft, EntryFields } from '@commerceworker/domain';
import { logger } from '@commerceworker/telemetry';
import type { SeedRun } from './types';

/** Deterministic pick — the seed never uses Math.random so demos reproduce. */
export function pick<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length]!;
}

export const WORDS = {
  adjectives: [
    'Practical',
    'Modern',
    'Essential',
    'Advanced',
    'Complete',
    'Effortless',
    'Scalable',
    'Resilient',
    'Composable',
    'Incremental',
    'Field-tested',
    'Opinionated',
    'Minimal',
  ],
  topics: [
    'content modeling',
    'localization',
    'publishing pipelines',
    'edge delivery',
    'agent workflows',
    'structured content',
    'preview environments',
    'release management',
    'semantic search',
    'API design',
    'multi-tenancy',
    'reference integrity',
    'draft workflows',
    'asset pipelines',
    'schema migrations',
    'cache invalidation',
    'webhooks at scale',
    'editorial review',
    'access control',
  ],
  verbs: [
    'Mastering',
    'Understanding',
    'Exploring',
    'Rethinking',
    'Debugging',
    'Scaling',
    'Migrating to',
    'Auditing',
    'Shipping',
  ],
  audiences: [
    'platform teams',
    'editorial teams',
    'solo developers',
    'agencies',
    'enterprise architects',
    'growth teams',
  ],
  outcomes: [
    'cut publish latency in half',
    'ship localized content without release trains',
    'let agents draft while humans decide',
    'keep every environment reproducible',
    'stop cache stampedes before they start',
    'roll out schema changes with zero downtime',
  ],
} as const;

/**
 * Deterministic multi-paragraph prose for entry bodies. Varies structure by
 * index (2–4 paragraphs, different sentence templates) so lists, search, and
 * AI summarization demos have realistic, non-repetitive material.
 */
export function prose(i: number): string {
  const topic = pick(WORDS.topics, i);
  const other = pick(WORDS.topics, i + 5);
  const audience = pick(WORDS.audiences, i);
  const outcome = pick(WORDS.outcomes, i);
  const paragraphs = [
    `${pick(WORDS.adjectives, i)} ${topic} is what separates teams that ship weekly from teams that ship quarterly. For ${audience}, the difference shows up the first time a launch spans more than one locale, one environment, or one approval chain.`,
    `The pattern that works: model ${topic} explicitly, keep ${other} out of the write path, and let the platform enforce the rules people forget under deadline. Teams that adopted this ${outcome}.`,
    'Start small — one content type, one environment, one workflow step. Measure publish latency and editorial cycle time before and after; the numbers make the case better than any architecture diagram.',
    `A note on ${other}: it interacts with ${topic} more than most teams expect. Budget a spike for it in the first sprint, not the last one.`,
  ];
  const count = 2 + (i % 3);
  return paragraphs.slice(0, count).join('\n\n');
}

/** Real-city coordinates for Location fields — plausible map pins in demos. */
export const CITIES = [
  { name: 'San Francisco', lat: 37.7749, lon: -122.4194 },
  { name: 'New York', lat: 40.7128, lon: -74.006 },
  { name: 'London', lat: 51.5074, lon: -0.1278 },
  { name: 'Berlin', lat: 52.52, lon: 13.405 },
  { name: 'Amsterdam', lat: 52.3676, lon: 4.9041 },
  { name: 'Tokyo', lat: 35.6762, lon: 139.6503 },
  { name: 'Singapore', lat: 1.3521, lon: 103.8198 },
  { name: 'Sydney', lat: -33.8688, lon: 151.2093 },
  { name: 'Toronto', lat: 43.6532, lon: -79.3832 },
  { name: 'São Paulo', lat: -23.5505, lon: -46.6333 },
  { name: 'Nairobi', lat: -1.2921, lon: 36.8219 },
  { name: 'Lisbon', lat: 38.7223, lon: -9.1393 },
] as const;

/** ISO date `daysOffset` days from `now` (negative = past), deterministic time. */
export function isoDate(now: Date, daysOffset: number, hour = 9): string {
  const d = new Date(now);
  d.setDate(d.getDate() + daysOffset);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

export function localized(
  defaultLocale: string,
  value: unknown,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { [defaultLocale]: value };
  if (extra) {
    for (const [loc, v] of Object.entries(extra)) out[loc] = v;
  }
  return out;
}

export const entryLink = (id: string) => ({ id, linkType: 'Entry' as const });
export const assetLink = (id: string) => ({ id, linkType: 'Asset' as const });

/** A minimal rich-text document: one paragraph of plain text. */
export function richTextDoc(text: string) {
  return {
    nodeType: 'document' as const,
    content: [
      {
        nodeType: 'paragraph' as const,
        content: [{ nodeType: 'text' as const, value: text, marks: [] as const }],
      },
    ],
  };
}

const text = (value: string, marks: readonly { type: string }[] = []) => ({
  nodeType: 'text',
  value,
  marks,
});
const paragraph = (...content: unknown[]) => ({ nodeType: 'paragraph', content });

/**
 * A structured guide document — heading, intro, subheadings, a list, and a
 * closing note with marks. Richer than `richTextDoc` without the kitchen
 * sink's embeds, so generated pages/recipes render like real authored content.
 */
export function richTextGuide(title: string, steps: readonly string[], i: number): unknown {
  const topic = pick(WORDS.topics, i);
  return {
    nodeType: 'document',
    content: [
      { nodeType: 'heading-2', content: [text(title)] },
      paragraph(
        text(`Everything here is deterministic demo content about ${topic}, written to look like `),
        text('real editorial material', [{ type: 'italic' }]),
        text(' rather than lorem ipsum.'),
      ),
      { nodeType: 'heading-3', content: [text('Steps')] },
      {
        nodeType: 'ordered-list',
        content: steps.map((s) => ({ nodeType: 'list-item', content: [paragraph(text(s))] })),
      },
      { nodeType: 'blockquote', content: [paragraph(text(pick(WORDS.outcomes, i)))] },
      paragraph(
        text('Questions? Check the '),
        text('documentation', [{ type: 'bold' }]),
        text(' or ask in the community.'),
      ),
    ],
  };
}

/**
 * One document exercising every node the admin's rich-text mapper supports:
 * headings 1–6, both list kinds, blockquote, code block, hr, a table with a
 * header row, all five marks, plain/entry/asset hyperlinks, and embedded
 * entry/asset blocks — so the editor's full round-trip renders against seeded
 * content.
 */
export function richTextKitchenSink(embeddedEntryId: string, embeddedAssetId: string) {
  const heading = (level: number) => ({
    nodeType: `heading-${level}`,
    content: [text(`Heading level ${level}`)],
  });
  return {
    nodeType: 'document',
    content: [
      ...[1, 2, 3, 4, 5, 6].map(heading),
      paragraph(
        text('Marks: '),
        text('bold', [{ type: 'bold' }]),
        text(', '),
        text('italic', [{ type: 'italic' }]),
        text(', '),
        text('underline', [{ type: 'underline' }]),
        text(', '),
        text('code', [{ type: 'code' }]),
        text(', '),
        text('strikethrough', [{ type: 'strikethrough' }]),
        text('.'),
      ),
      {
        nodeType: 'unordered-list',
        content: [
          { nodeType: 'list-item', content: [paragraph(text('First bullet'))] },
          { nodeType: 'list-item', content: [paragraph(text('Second bullet'))] },
        ],
      },
      {
        nodeType: 'ordered-list',
        content: [
          { nodeType: 'list-item', content: [paragraph(text('Step one'))] },
          { nodeType: 'list-item', content: [paragraph(text('Step two'))] },
        ],
      },
      { nodeType: 'blockquote', content: [paragraph(text('Structured content is a graph.'))] },
      {
        nodeType: 'code-block',
        data: { language: 'ts' },
        content: [text("const entry = await client.getEntry('id');")],
      },
      { nodeType: 'hr', content: [] },
      {
        nodeType: 'table',
        data: {},
        content: [
          ['Plan', 'Seats', 'Support'],
          ['Starter', '3', 'Community'],
          ['Team', '25', 'Email, next business day'],
        ].map((cells, r) => ({
          nodeType: 'table-row',
          data: {},
          content: cells.map((value) => ({
            nodeType: r === 0 ? 'table-header-cell' : 'table-cell',
            data: {},
            content: [paragraph(text(value))],
          })),
        })),
      },
      paragraph(
        text('A '),
        {
          nodeType: 'hyperlink',
          data: { uri: 'https://example.com/docs' },
          content: [text('plain link')],
        },
        text(', an '),
        {
          nodeType: 'entry-hyperlink',
          data: { target: entryLink(embeddedEntryId) },
          content: [text('entry link')],
        },
        text(', and an '),
        {
          nodeType: 'asset-hyperlink',
          data: { target: assetLink(embeddedAssetId) },
          content: [text('asset link')],
        },
        text('.'),
      ),
      { nodeType: 'embedded-entry-block', data: { target: entryLink(embeddedEntryId) } },
      { nodeType: 'embedded-asset-block', data: { target: assetLink(embeddedAssetId) } },
    ],
  };
}

export async function ensureContentType(run: SeedRun, draft: ContentTypeDraft): Promise<void> {
  const existed = await contentTypeExists(run, draft.apiId);
  // The starter never touches a type that's already there: on a retry it's its own, and otherwise
  // it's someone's model, which sample content has no business rewriting.
  if (existed && run.keepExistingTypes) return;
  await createContentType(run.ctx, SYSTEM_CALLER, run.scope, draft);
  await publishContentType(run.ctx, run.scope, draft.apiId);
  if (!existed) {
    logger.info({ apiId: draft.apiId }, 'seed: created content type');
  }
}

async function contentTypeExists(run: SeedRun, apiId: string): Promise<boolean> {
  try {
    await getContentType(run.ctx, run.scope, apiId);
    return true;
  } catch {
    return false;
  }
}

export async function findEntryByField(
  run: SeedRun,
  contentTypeApiId: string,
  field: string,
  value: string,
): Promise<string | null> {
  const rows = await listPreviewEntries(run.ctx, run.scope, {
    contentTypeApiId,
    filters: [{ field, op: 'eq', value }],
    locale: run.locale,
    limit: 1,
  });
  return rows[0]?.id ?? null;
}

export async function ensurePublishedEntry(
  run: SeedRun,
  contentTypeApiId: string,
  matchField: string,
  matchValue: string,
  fields: EntryFields,
): Promise<{ id: string; created: boolean }> {
  const existing = await findEntryByField(run, contentTypeApiId, matchField, matchValue);
  if (existing) return { id: existing, created: false };

  const view = await createEntry(run.ctx, run.scope, { contentTypeApiId, fields });
  await publishEntry(run.ctx, run.scope, view.entry.id);
  return { id: view.entry.id, created: true };
}

/** One generated entry: its identity, fields, and desired lifecycle state. */
export interface GeneratedEntry {
  /** Value of `matchField` in the default locale — must be unique per type. */
  readonly matchValue: string;
  readonly fields: EntryFields;
  /** draft = never published; changed = published then edited (diff view data). */
  readonly status: 'draft' | 'published' | 'changed';
  /** Applied before publish so it lands in the published snapshot. */
  readonly metadata?: { tags?: readonly string[]; concepts?: readonly string[] };
  /** For status 'changed': a field patch saved as a new draft after publish. */
  readonly patch?: EntryFields;
}

/**
 * Seeds `count` deterministic entries of one content type, skipping cheaply
 * when a previous run already completed the block (probe the last title: one
 * query). A partially-seeded block (first exists, last missing — a crashed
 * earlier run) falls back to per-entry existence checks so reruns never
 * duplicate. Returns the ids of all `count` entries, in index order.
 */
export async function seedGeneratedEntries(
  run: SeedRun,
  contentTypeApiId: string,
  matchField: string,
  count: number,
  make: (i: number) => GeneratedEntry,
): Promise<string[]> {
  const { ctx, scope } = run;
  if (count === 0) return [];

  const lastId = await findEntryByField(
    run,
    contentTypeApiId,
    matchField,
    make(count - 1).matchValue,
  );
  if (lastId) {
    // Block complete — collect the ids without touching anything.
    const rows = await listPreviewEntries(ctx, scope, {
      contentTypeApiId,
      locale: run.locale,
      limit: count + 50,
    });
    const byValue = new Map(
      rows.map((r) => [
        String((r.fields[matchField] as Record<string, unknown>)?.[run.locale]),
        r.id,
      ]),
    );
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = byValue.get(make(i).matchValue);
      if (id) ids.push(id);
    }
    return ids;
  }
  const partial =
    (await findEntryByField(run, contentTypeApiId, matchField, make(0).matchValue)) !== null;

  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const gen = make(i);
    if (partial) {
      const existing = await findEntryByField(run, contentTypeApiId, matchField, gen.matchValue);
      if (existing) {
        ids.push(existing);
        continue;
      }
    }
    const view = await createEntry(ctx, scope, { contentTypeApiId, fields: gen.fields });
    const id = view.entry.id;
    if (gen.metadata) await setEntryMetadata(ctx, scope, id, gen.metadata);
    if (gen.status !== 'draft') {
      await publishEntry(ctx, scope, id);
      if (gen.status === 'changed' && gen.patch) {
        await updateEntry(ctx, scope, id, { ...gen.fields, ...gen.patch });
      }
    }
    ids.push(id);
  }
  logger.info({ contentTypeApiId, count }, 'seed: generated entries');
  return ids;
}

/** Standard status mix by index: every 5th draft, else every 7th changed. */
export function statusFor(i: number): GeneratedEntry['status'] {
  if (i % 5 === 0) return 'draft';
  if (i % 7 === 0) return 'changed';
  return 'published';
}

/** Backdates `daysAgo` days (plus a deterministic time of day) off the clock. */
export function backdated(now: Date, daysAgo: number, hour: number, minute = 15): string {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}
