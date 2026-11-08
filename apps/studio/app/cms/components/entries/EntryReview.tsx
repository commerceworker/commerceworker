/**
 * What publishing an entry would change, for every place that asks: the assistant's confirm card,
 * the page's own confirmation and the entries list's diff. All of them read `useEntryReview`, which
 * reads the version diff (`GET …/versions/diff`, the same read as MCP's `entries_diff_versions`), so
 * what they say can't drift, and nothing a model wrote can reach it.
 */

import type { DiffKind, FieldDiff, FieldType } from '@commerceworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { Collapsible, CollapsibleContent } from '@commerceworker/ui/collapsible';
import { cn } from '@commerceworker/ui/lib/utils';
import { TriangleAlert } from 'lucide-react';
import { type RefObject, useEffect, useId, useMemo, useRef, useState } from 'react';
import { humanize } from '../../lib/format';
import { ApiError, type ManagementClient, type PreviewEntry } from '../../lib/management';
import { entryRef, fetchEntriesById } from '../dashboard/entry-titles';
import { FieldValue, type LinkTitles, linkOf, valueText } from '../EntryDiff';
import { changeCount, KindBadge } from '../RevisionDiff';

/** One value's before and after, as words. A field holds one per locale that changed. */
interface ReviewRow {
  /** Named only when the field holds several locales. */
  readonly locale?: string;
  readonly before: string;
  readonly after: string;
}

/** One field of the entry, named for a person. */
export interface ReviewField {
  readonly field: string;
  readonly name: string;
  readonly kind: DiffKind;
  readonly rows: readonly ReviewRow[];
}

export type EntryReview =
  /** Nothing was asked: the card is for another kind of action. */
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  /** Never published: there is nothing to compare, and the whole entry goes live. */
  | { readonly status: 'first'; readonly title?: string }
  | {
      readonly status: 'ready';
      readonly fields: readonly ReviewField[];
      /** Fields that changed which this person may not read. */
      readonly hiddenChanges: number;
      readonly title?: string;
    }
  /** The diff couldn't be read, so nothing can be said about what changes. `retry` reads again. */
  | { readonly status: 'failed'; readonly retry?: () => void };

export interface ReviewTarget {
  readonly entryId: string;
  /** What would go live, when it isn't the current draft: the version a card is held to. */
  readonly version?: number;
  /** The diff, when the caller already has it (the editor, right after a save). */
  readonly changes?: readonly FieldDiff[];
  /** With `changes`: how many more changed that this person may not read. */
  readonly hiddenChanges?: number;
  /** Also read the entry's title, for a card nobody named (one the model proposed). */
  readonly named?: boolean;
}

/** The first publish, in the words every confirmation uses. */
export const FIRST_PUBLISH =
  'This entry hasn’t been published before, so the whole entry goes live.';
/** A publish that changes nothing. */
export const NO_CHANGES = 'The draft matches the published version; publishing re-confirms it.';
export const fieldsGoLive = (n: number) => `${n} ${n === 1 ? 'field goes' : 'fields go'} live:`;
/** Changes this person may not read go live with the rest, so nothing here may read as none. */
export const hiddenGoLive = (n: number, alone: boolean) =>
  `${n} ${n === 1 ? 'field' : 'fields'} you can’t read ${alone ? '' : 'also '}${
    n === 1 ? 'goes' : 'go'
  } live.`;

const isChanged = (f: ReviewField) => f.kind !== 'unchanged';
/** How many fields a person would see changed: a field added empty isn't one. */
export const changedCount = (fields: readonly ReviewField[]) => fields.filter(isChanged).length;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !('nodeType' in v) && !linkOf(v);

/**
 * A stored value as words: a group of fields (a component, a block, SEO, a location) as a line per
 * field, a list by its elements, the rest as `valueText` reads it. A JSON field's JSON is its value.
 */
function readable(v: unknown, type: FieldType | undefined, titles: LinkTitles): string {
  if (type === 'JSON') return valueText(v);
  if (Array.isArray(v) && v.some(isPlainObject))
    return v.map((x) => readable(x, undefined, titles)).join('\n');
  if (!isPlainObject(v)) return valueText(v, titles);
  return Object.entries(v)
    .filter(([k]) => !k.startsWith('_'))
    .map(
      ([k, x]) =>
        `${humanize(k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase())}: ${readable(x, undefined, titles) || 'Empty'}`,
    )
    .join('\n');
}

/** The diff as it reads for a person: each changed locale, or an unchanged field's one value. */
export function reviewFields(
  changes: readonly FieldDiff[],
  locale: string,
  titles: LinkTitles = new Map(),
): ReviewField[] {
  return changes.map((f) => {
    const changed = f.locales.filter((l) => l.kind !== 'unchanged');
    const same = f.locales.find((l) => l.locale === locale) ?? f.locales[0];
    const shown = changed.length ? changed : same ? [same] : [];
    return {
      field: f.field,
      name: f.name ?? humanize(f.field),
      kind: changed.length ? f.kind : 'unchanged',
      rows: shown.map((l) => ({
        ...(f.locales.length > 1 ? { locale: l.locale } : {}),
        before: readable(l.before, f.fieldType, titles),
        after: readable(l.after, f.fieldType, titles),
      })),
    };
  });
}

/** Every link a value holds, however deep (a list of them, a component's). */
function collectLinks(v: unknown, into: { entries: Set<string>; assets: Set<string> }) {
  const link = linkOf(v);
  if (link) (link.linkType === 'Asset' ? into.assets : into.entries).add(link.id);
  else if (Array.isArray(v)) for (const x of v) collectLinks(x, into);
  else if (v && typeof v === 'object' && !('nodeType' in v))
    for (const x of Object.values(v)) collectLinks(x, into);
}

/** More assets than this and the rest read "Linked asset": each one is a request of its own. */
const MAX_ASSET_TITLES = 20;

/** Assets by id, by their title in `locale`, else any locale's, else the file's name. */
async function assetTitles(client: ManagementClient, ids: readonly string[], locale: string) {
  const read = await Promise.allSettled(
    ids.slice(0, MAX_ASSET_TITLES).map((id) => client.getAsset(id)),
  );
  return read.flatMap((r): [string, string][] => {
    if (r.status !== 'fulfilled') return [];
    const { id, title, file } = r.value;
    const named = title[locale] ?? Object.values(title).find((t) => typeof t === 'string' && t);
    return [[id, typeof named === 'string' && named ? named : file.fileName]];
  });
}

async function readReview(
  client: ManagementClient,
  target: ReviewTarget,
  locale: string,
): Promise<EntryReview> {
  const { entryId, named } = target;
  let changes = target.changes;
  let hiddenChanges = target.hiddenChanges ?? 0;
  let entry: PreviewEntry | null = null;
  if (!changes) {
    try {
      const diff = await client.diffVersions(entryId, 'published', target.version ?? 'draft');
      changes = diff.changes;
      hiddenChanges = diff.hiddenChanges;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) return { status: 'failed' };
      // No published version, or no such entry: only the entry can say which.
      entry = await client.getEntry(entryId).catch(() => null);
      if (entry?.status !== 'draft') return { status: 'failed' };
    }
  }
  const links = { entries: new Set<string>(), assets: new Set<string>() };
  for (const f of changes ?? [])
    for (const l of f.locales) {
      collectLinks(l.before, links);
      collectLinks(l.after, links);
    }
  // Titles are a courtesy: one that can't be read stays out, and its link reads "Linked entry".
  const [types, linked, assets, self] = await Promise.all([
    named || links.entries.size ? client.listContentTypes().catch(() => []) : [],
    fetchEntriesById(client, [...links.entries]).catch(() => []),
    assetTitles(client, [...links.assets], locale),
    named && !entry ? client.getEntry(entryId).catch(() => null) : entry,
  ]);
  const title = named && self ? { title: entryRef(self, types, locale).title } : {};
  if (!changes) return { status: 'first', ...title };
  const titles = new Map([
    ...linked.map((e): [string, string] => [e.id, entryRef(e, types, locale).title]),
    ...assets,
  ]);
  const fields = reviewFields(changes, locale, titles);
  return { status: 'ready', fields, hiddenChanges, ...title };
}

const LOADING: EntryReview = { status: 'loading' };
const IDLE: EntryReview = { status: 'idle' };

/** Reads what publishing `target` would change; a read only, with no `target` nothing at all. */
export function useEntryReview(
  client: ManagementClient | undefined,
  target: ReviewTarget | null,
  locale: string,
): EntryReview {
  const [review, setReview] = useState(LOADING);
  const [attempt, setAttempt] = useState(0);
  const entryId = target?.entryId;
  const version = target?.version;
  const changes = target?.changes;
  const hiddenChanges = target?.hiddenChanges;
  const named = target?.named;
  useEffect(() => {
    // Nothing kept for later: a target that comes back (a switch back) reads afresh.
    setReview(LOADING);
    if (!entryId || !client) return;
    let live = true;
    readReview(
      client,
      {
        entryId,
        ...(version === undefined ? {} : { version }),
        ...(changes ? { changes } : {}),
        ...(hiddenChanges ? { hiddenChanges } : {}),
        ...(named ? { named } : {}),
      },
      locale,
    ).then(
      (r) => {
        if (live) setReview(r);
      },
      () => {
        if (live) setReview({ status: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [client, entryId, version, changes, hiddenChanges, named, locale, attempt]);
  if (!target) return IDLE;
  return review.status === 'failed'
    ? { status: 'failed', retry: () => setAttempt((n) => n + 1) }
    : review;
}

/** What a field review calls its two sides. */
export interface ReviewLabels {
  readonly before?: string;
  readonly after: string;
}
const PUBLISH_LABELS: ReviewLabels = { before: 'Published', after: 'Draft' };

/** Past this many a list of names stops and says how many more: Review changes has them all. */
const LIST_MAX = 6;

/** The changed fields by name, with how each changed. */
export function ChangedFields({ fields }: { fields: readonly ReviewField[] }) {
  const changed = fields.filter(isChanged);
  const more = changed.length - LIST_MAX;
  return (
    <ul aria-label="Changed fields" className="space-y-1 text-sm">
      {changed.slice(0, LIST_MAX).map((f) => (
        <li key={f.field} className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 break-words font-medium">{f.name}</span>
          <KindBadge kind={f.kind} />
        </li>
      ))}
      {more > 0 ? <li className="text-muted-foreground text-xs">and {more} more</li> : null}
    </ul>
  );
}

function FieldHeading({ field, locale }: { field: ReviewField; locale?: string }) {
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="min-w-0 break-words font-medium">{field.name}</span>
      {locale ? <span className="font-mono text-muted-foreground text-xs">{locale}</span> : null}
      {isChanged(field) ? <KindBadge kind={field.kind} /> : null}
    </span>
  );
}

/**
 * Each changed field's published value and its draft, side by side only where the space around them
 * allows (a container query, not the viewport: a dialog on a tablet and the assistant's column on a
 * desktop are as narrow as a phone). Each value carries its own label, so stacked they still read.
 * Unchanged fields wait behind a disclosure. `labels` name the two sides for a change that isn't
 * a publish (a draft save: what the draft holds now, and after); with no `before`, only the new
 * value shows (an entry that doesn't exist yet).
 */
export function FieldReview({
  fields,
  labels = PUBLISH_LABELS,
}: {
  fields: readonly ReviewField[];
  labels?: ReviewLabels;
}) {
  const changed = fields.filter(isChanged);
  const same = fields.filter((f) => !isChanged(f));
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="@container min-w-0 space-y-2 text-sm">
      {changed.length ? (
        <ul aria-label="Changes" className="divide-y">
          {changed.flatMap((f) =>
            f.rows.map((r) => (
              <li key={`${f.field}:${r.locale ?? ''}`} className="space-y-1 py-2 first:pt-0">
                <FieldHeading field={f} {...(r.locale ? { locale: r.locale } : {})} />
                <dl className={cn('grid gap-x-4 gap-y-1', labels.before && '@md:grid-cols-2')}>
                  {labels.before ? (
                    <div className="min-w-0">
                      <dt className="caption">{labels.before}</dt>
                      <dd>
                        <FieldValue value={r.before} muted />
                      </dd>
                    </div>
                  ) : null}
                  <div className="min-w-0">
                    <dt className="caption">{labels.after}</dt>
                    <dd>
                      <FieldValue value={r.after} />
                    </dd>
                  </div>
                </dl>
              </li>
            )),
          )}
        </ul>
      ) : null}
      {same.length ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          <Button
            type="button"
            variant="link"
            size="xs"
            className="px-0"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((o) => !o)}
          >
            {open
              ? 'Hide unchanged fields'
              : `Show ${same.length} unchanged ${same.length === 1 ? 'field' : 'fields'}`}
          </Button>
          <CollapsibleContent id={id}>
            <ul aria-label="Unchanged fields" className="divide-y">
              {same.map((f) => (
                <li key={f.field} className="space-y-1 py-2">
                  <FieldHeading field={f} />
                  <FieldValue value={f.rows[0]?.after} muted />
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

/** Changes this person can't read: never silent, because publishing puts them live too. */
export function HiddenChanges({ count, alone }: { count: number; alone: boolean }) {
  return (
    <Alert variant="warning">
      <TriangleAlert />
      <AlertDescription>{hiddenGoLive(count, alone)}</AlertDescription>
    </Alert>
  );
}

/** The diff couldn't be read: said as plainly as the decision beside it deserves. */
export function ReviewFailed({
  onRetry,
  next = 'Check the entry before you go on.',
}: {
  onRetry?: (() => void) | undefined;
  /** What to do about it, where that isn't to check the entry. */
  next?: string;
}) {
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>Couldn’t load what changed</AlertTitle>
      <AlertDescription>
        <p>{next}</p>
        {onRetry ? (
          <Button size="xs" variant="outline" className="mt-2" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Why a publish can't be confirmed yet, in words, for the control it describes (`aria-describedby`).
 * Always there, so a screen reader hears it fill; while the read runs, to a screen reader alone,
 * since the review already says it is comparing.
 */
export function ReviewHold(props: {
  id: string;
  /** What the control does: "confirm", "publish". */
  verb: string;
  pending: boolean;
  blocked: boolean;
  /** What the hold waits to show, and what it is doing meanwhile: a publish's by default. */
  shows?: string;
  reading?: string;
  /** Why it is blocked, when the read showed it can't go ahead rather than failing to show. */
  why?: string | undefined;
}) {
  const {
    id,
    verb,
    pending,
    blocked,
    shows = 'what goes live',
    reading = 'comparing with what’s live',
    why,
  } = props;
  return (
    <p
      id={id}
      role="status"
      className={cn('text-xs leading-snug empty:hidden', pending && !blocked && 'sr-only')}
    >
      {blocked
        ? (why ?? `You can’t ${verb} until this can show ${shows}.`)
        : pending
          ? `You can’t ${verb} yet: still ${reading}.`
          : null}
    </p>
  );
}

/**
 * A control can turn off with focus on it, which leaves focus nowhere: `to` takes it. `lost` says
 * whether focus that has fallen to the body was this surface's to look after.
 */
export function useHandFocus(
  off: boolean,
  from: RefObject<HTMLElement | null>,
  to: RefObject<HTMLElement | null>,
  lost: () => boolean,
) {
  const latest = useRef(lost);
  latest.current = lost;
  useEffect(() => {
    if (!off) return;
    const now = document.activeElement;
    if (now === from.current || (now === document.body && latest.current()))
      to.current?.focus({ preventScroll: true });
  }, [off, from, to]);
}

/**
 * An entry's draft against its published version, in full: it reads them and says how many.
 */
export function EntryDiff(props: {
  client: ManagementClient;
  entry: PreviewEntry;
  locale: string;
}) {
  const { client, entry, locale } = props;
  const target = useMemo(() => ({ entryId: entry.id }), [entry.id]);
  return <EntryDiffView review={useEntryReview(client, target, locale)} counted />;
}

/** A review in full, for whoever read it. `counted` says how many fields changed, above them. */
export function EntryDiffView({
  review,
  counted,
  onRetry,
}: {
  review: EntryReview;
  counted: boolean;
  /** Try again, where the caller has more to do than read again. */
  onRetry?: () => void;
}) {
  if (review.status === 'first')
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>No published version</AlertTitle>
        <AlertDescription>
          This entry hasn’t been published yet, so there’s nothing to compare against.
        </AlertDescription>
      </Alert>
    );
  if (review.status === 'failed') return <ReviewFailed onRetry={onRetry ?? review.retry} />;
  if (review.status !== 'ready') return <p className="text-muted-foreground text-sm">Comparing…</p>;
  const count = changedCount(review.fields);
  return (
    <div className="space-y-3">
      {counted ? (
        <p className="text-muted-foreground text-sm">{changeCount(count, review.hiddenChanges)}</p>
      ) : null}
      {review.hiddenChanges > 0 ? (
        <HiddenChanges count={review.hiddenChanges} alone={count === 0} />
      ) : null}
      <FieldReview fields={review.fields} />
    </div>
  );
}
