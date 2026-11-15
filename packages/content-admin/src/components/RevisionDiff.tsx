import { ToneBadge } from '@commerceworker/content-admin/components/status';
import { humanize, type Tone } from '@commerceworker/content-admin/lib/format';
import type {
  ContentType,
  DiffKind,
  FieldDiff,
  LinkRef,
  ListItemDiff,
  NestedFieldDiff,
  RichTextBlockDiff,
  TextSegment,
  ValueDiff,
} from '@commerceworker/domain';
import { Button } from '@commerceworker/ui/button';
import { useState } from 'react';
import type { VersionDiff } from '../lib/management';
import { valueText } from './EntryDiff';

/** As the environment compare reads a change (`BranchMerge`): added, changed, removed. */
const KIND_TONE: Record<DiffKind, Tone> = {
  added: 'ok',
  changed: 'wait',
  removed: 'bad',
  unchanged: 'idle',
};

export function KindBadge({ kind, moved }: { kind: DiffKind; moved?: boolean }) {
  if (moved && kind === 'unchanged') return <ToneBadge tone="idle" label="Moved" />;
  return (
    <span className="inline-flex items-center gap-1">
      <ToneBadge tone={KIND_TONE[kind]} label={humanize(kind)} />
      {moved ? <ToneBadge tone="idle" label="Moved" /> : null}
    </span>
  );
}

/**
 * Text as a word diff, read in one line: removed words struck through, added words underlined,
 * each tinted and announced in words, so the change never rests on colour alone.
 */
export function DiffText({ segments }: { segments: readonly TextSegment[] }) {
  if (segments.length === 0) return <span className="text-muted-foreground italic">Empty</span>;
  return (
    <span className="whitespace-pre-wrap break-words">
      {segments.map((s, i) =>
        s.kind === 'removed' ? (
          <del key={i} className="rounded-xs bg-bad/10 text-foreground decoration-bad line-through">
            <span className="sr-only">Removed: </span>
            {s.text}
          </del>
        ) : s.kind === 'added' ? (
          <ins key={i} className="rounded-xs bg-ok/10 text-foreground decoration-ok underline">
            <span className="sr-only">Added: </span>
            {s.text}
          </ins>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </span>
  );
}

const linkText = (l: LinkRef | null) =>
  l ? (
    <span>
      {l.linkType === 'Asset' ? 'Asset' : 'Entry'} <span className="font-mono text-xs">{l.id}</span>
    </span>
  ) : (
    <span className="text-muted-foreground italic">None</span>
  );

/** Before and after side by side, stacked on a phone. */
function BeforeAfter(props: { before: React.ReactNode; after: React.ReactNode }) {
  return (
    <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
      <div className="min-w-0">
        <dt className="caption text-muted-foreground">Before</dt>
        <dd className="text-muted-foreground">{props.before}</dd>
      </div>
      <div className="min-w-0">
        <dt className="caption text-muted-foreground">After</dt>
        <dd>{props.after}</dd>
      </div>
    </dl>
  );
}

const plain = (v: unknown) => {
  const text = valueText(v);
  return text ? (
    <span className="whitespace-pre-wrap break-words">{text}</span>
  ) : (
    <span className="italic">Empty</span>
  );
};

/** What a block of rich text is, in words ("Heading 2", "List item"). */
const blockName = (nodeType: string) =>
  humanize(nodeType.replace(/^heading-(\d)$/, 'heading $1').replace(/^embed$/, 'embedded media'));

function RichTextBlocks({ blocks }: { blocks: readonly RichTextBlockDiff[] }) {
  const shown = blocks.filter((b) => b.kind !== 'unchanged' || b.moved);
  const quiet = blocks.length - shown.length;
  return (
    <div className="space-y-2">
      <ol className="space-y-2">
        {shown.map((b, i) => (
          <li
            key={i}
            className="space-y-1 border-l pl-3"
            style={{ marginInlineStart: `${b.depth * 0.75}rem` }}
          >
            <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
              <span>
                {b.beforeNodeType ? `${blockName(b.beforeNodeType)} → ` : ''}
                {blockName(b.nodeType)}
              </span>
              <KindBadge kind={b.kind} moved={b.moved} />
              {b.formattingChanged ? <span>Formatting changed</span> : null}
            </div>
            {b.target || b.beforeTarget ? (
              b.beforeTarget ? (
                <BeforeAfter before={linkText(b.beforeTarget)} after={linkText(b.target ?? null)} />
              ) : (
                <p className="text-sm">{linkText(b.target ?? null)}</p>
              )
            ) : (
              <p className="text-sm">
                <DiffText segments={b.text} />
              </p>
            )}
          </li>
        ))}
      </ol>
      {quiet > 0 ? (
        <p className="text-muted-foreground text-xs">
          {quiet} unchanged {quiet === 1 ? 'block' : 'blocks'} not shown
        </p>
      ) : null}
    </div>
  );
}

function ListItems(props: { items: readonly ListItemDiff[]; variantName: (v: string) => string }) {
  const shown = props.items.filter((i) => i.kind !== 'unchanged' || i.moved);
  const quiet = props.items.length - shown.length;
  return (
    <div className="space-y-2">
      <ol className="space-y-2">
        {shown.map((item) => {
          const value = item.after ?? item.before;
          const title = item.variant
            ? props.variantName(item.variant)
            : item.link
              ? null
              : typeof value === 'string'
                ? value
                : null;
          return (
            <li
              key={`${item.beforeIndex}:${item.afterIndex}`}
              className="space-y-1 border-l pl-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                {item.link ? linkText(item.link) : title ? <span>{title}</span> : null}
                <KindBadge kind={item.kind} moved={item.moved} />
                <span className="text-muted-foreground text-xs">
                  {positionText(item.beforeIndex, item.afterIndex)}
                </span>
              </div>
              {item.detail ? (
                <ValueDetail detail={item.detail} variantName={props.variantName} />
              ) : null}
            </li>
          );
        })}
      </ol>
      {quiet > 0 ? (
        <p className="text-muted-foreground text-xs">
          {quiet} unchanged {quiet === 1 ? 'item' : 'items'} not shown
        </p>
      ) : null}
    </div>
  );
}

const positionText = (before: number | null, after: number | null) =>
  before === null
    ? `at ${(after ?? 0) + 1}`
    : after === null
      ? `was ${before + 1}`
      : before === after
        ? `at ${after + 1}`
        : `${before + 1} → ${after + 1}`;

function NestedFields(props: {
  fields: readonly NestedFieldDiff[];
  variantName: (v: string) => string;
}) {
  const changed = props.fields.filter((f) => f.kind !== 'unchanged');
  if (changed.length === 0) return null;
  return (
    <ul className="space-y-2">
      {changed.map((f) => (
        <li key={f.field} className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="font-medium">{f.name ?? humanize(f.field)}</span>
            <KindBadge kind={f.kind} />
          </div>
          {f.detail ? <ValueDetail detail={f.detail} variantName={props.variantName} /> : null}
        </li>
      ))}
    </ul>
  );
}

/** One value's change, drawn by its kind. */
export function ValueDetail(props: { detail: ValueDiff; variantName?: (v: string) => string }) {
  const variantName = props.variantName ?? humanize;
  const d = props.detail;
  switch (d.type) {
    case 'text':
      return (
        <p className="text-sm">
          <DiffText segments={d.segments} />
        </p>
      );
    case 'value':
      return <BeforeAfter before={plain(d.before)} after={plain(d.after)} />;
    case 'link':
      return <BeforeAfter before={linkText(d.before)} after={linkText(d.after)} />;
    case 'component':
      return <NestedFields fields={d.fields} variantName={variantName} />;
    case 'list':
      return <ListItems items={d.items} variantName={variantName} />;
    case 'richText':
      return <RichTextBlocks blocks={d.blocks} />;
  }
}

/** Names a blocks field's variant from the content type, else from its API id. */
function variantNames(contentType?: ContentType) {
  const names = new Map<string, string>();
  const walk = (fields: ContentType['fields']) => {
    for (const f of fields) {
      for (const v of f.items?.variants ?? []) {
        names.set(v.apiId, v.name);
        walk(v.fields);
      }
      walk(f.items?.fields ?? []);
      walk(f.fields ?? []);
    }
  };
  if (contentType) walk(contentType.fields);
  return (apiId: string) => names.get(apiId) ?? humanize(apiId);
}

function FieldRow(props: {
  change: FieldDiff;
  showLocales: boolean;
  variantName: (v: string) => string;
}) {
  const { change } = props;
  const locales = change.locales.filter((l) => l.kind !== 'unchanged');
  return (
    <li className="space-y-2 border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="font-medium text-sm">{change.name ?? humanize(change.field)}</h4>
        <span className="font-mono text-muted-foreground text-xs">{change.field}</span>
        <KindBadge kind={change.kind} />
      </div>
      <ul className="space-y-2">
        {locales.map((l) => (
          <li key={l.locale} className="space-y-1">
            {props.showLocales ? (
              <p className="flex items-center gap-1.5 text-xs">
                <span className="font-mono text-muted-foreground">{l.locale}</span>
                {l.kind !== change.kind ? <KindBadge kind={l.kind} /> : null}
              </p>
            ) : null}
            {l.detail ? <ValueDetail detail={l.detail} variantName={props.variantName} /> : null}
          </li>
        ))}
      </ul>
    </li>
  );
}

/**
 * A readable diff of two versions of an entry: each field that changed, named as the content type
 * names it, with its change drawn by kind (words in text, blocks in rich text, elements in a list,
 * a link's target). Unchanged fields are counted, not shown. Every change is said in words as well
 * as tinted.
 */
/** Fields that changed which this person may not read: never "No field changes". */
const hiddenChanged = (n: number) => `${n} ${n === 1 ? 'field' : 'fields'} you can’t read changed`;

/** How many fields changed, the ones this person can't read included. */
export function changeCount(changed: number, hidden: number): string {
  if (changed === 0) return hidden > 0 ? hiddenChanged(hidden) : 'No field changes';
  const count = `${changed} ${changed === 1 ? 'field' : 'fields'} changed`;
  return hidden > 0 ? `${count} · ${hiddenChanged(hidden)}` : count;
}

export function RevisionDiff(props: {
  diff: VersionDiff;
  contentType?: ContentType;
  /** What the two sides are called ("v2", "Current draft", "Live"). */
  fromLabel: string;
  toLabel: string;
}) {
  const { diff } = props;
  const [showAll, setShowAll] = useState(false);
  const changed = diff.changes.filter((c) => c.kind !== 'unchanged');
  const unchanged = diff.changes.length - changed.length;
  const showLocales = new Set(diff.changes.flatMap((c) => c.locales.map((l) => l.locale))).size > 1;
  const variantName = variantNames(props.contentType);
  return (
    <section
      aria-label={`Changes from ${props.fromLabel} to ${props.toLabel}`}
      className="space-y-3"
    >
      <p className="text-muted-foreground text-xs">
        <span className="font-mono">{props.fromLabel}</span> →{' '}
        <span className="font-mono">{props.toLabel}</span> ·{' '}
        {changeCount(changed.length, diff.hiddenChanges)}
      </p>
      {changed.length > 0 ? (
        <ul className="space-y-3">
          {changed.map((c) => (
            <FieldRow
              key={c.field}
              change={c}
              showLocales={showLocales}
              variantName={variantName}
            />
          ))}
        </ul>
      ) : null}
      {unchanged > 0 ? (
        <div className="space-y-1">
          <Button
            variant="link"
            size="xs"
            className="px-0"
            aria-expanded={showAll}
            onClick={() => setShowAll((s) => !s)}
          >
            {showAll ? 'Hide' : 'Show'} {unchanged} unchanged {unchanged === 1 ? 'field' : 'fields'}
          </Button>
          {showAll ? (
            <ul className="text-muted-foreground text-sm">
              {diff.changes
                .filter((c) => c.kind === 'unchanged')
                .map((c) => (
                  <li key={c.field}>{c.name ?? humanize(c.field)}</li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
