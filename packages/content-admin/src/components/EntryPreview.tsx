import type {
  ContentType,
  EmbedData,
  EntryFields,
  FieldDefinition,
  LocaleConfig,
  RichTextNode,
} from '@commerceworker/domain';
import {
  embedDataIssues,
  isRichTextDocument,
  isWellFormedTable,
  resolveLocalizedValue,
  SEO_FIELDS,
  variantOf,
} from '@commerceworker/domain';
import { Badge } from '@commerceworker/ui/badge';
import { cn } from '@commerceworker/ui/lib/utils';
import type { ReactNode } from 'react';
import type { Pickers } from './EntryForm';
import { EmbedCard } from './rich-text/ExternalEmbedNodeView';

/**
 * The entry as it stands in the form, saved or not, read as a document: the display field as its
 * title, then every field in the content type's order, in the locale the form is on (a localized
 * field falls back as delivery would). Nothing here fetches: references are named from the
 * editor's pickers, and a link's target is shown, never followed, so a draft can't navigate the
 * editor away or carry a script URL into it.
 */
export function EntryPreview({
  contentType,
  fields,
  locale,
  localeConfig,
  direction,
  pickers,
}: {
  contentType: ContentType;
  fields: EntryFields;
  locale: string;
  localeConfig: LocaleConfig;
  /** `locale`'s text direction, as the form writes it; absent until the space config has said. */
  direction?: 'ltr' | 'rtl';
  pickers: Pickers;
}) {
  // The values read in the form's locale and its direction; the captions stay the admin's.
  const writing = direction ? { lang: locale, dir: direction } : { lang: locale };
  const shownValue = (f: FieldDefinition) => {
    const byLocale = (fields[f.apiId] ?? {}) as Record<string, unknown>;
    return f.localized
      ? resolveLocalizedValue(byLocale, localeConfig, locale)
      : byLocale[localeConfig.defaultLocale];
  };
  const titleField = contentType.fields.find((f) => f.apiId === contentType.displayField);
  const title = titleField ? shownValue(titleField) : undefined;
  const rest = contentType.fields.filter((f) => f !== titleField);
  return (
    <article aria-label="Preview" className="min-w-0 space-y-5">
      <header className="space-y-1">
        <p className="caption">
          {contentType.name}
          {localeConfig.locales.length > 1 ? ` · ${locale}` : null}
        </p>
        <h2 {...writing} className="break-words font-semibold text-xl tracking-title">
          {isFilled(title) ? (
            String(title)
          ) : (
            <span className="text-muted-foreground">Untitled</span>
          )}
        </h2>
      </header>
      {rest.length === 0 ? null : (
        <dl className="space-y-4">
          {rest.map((f) => (
            <div key={f.apiId} className="min-w-0 space-y-1">
              <dt className="caption">{f.name}</dt>
              <dd {...writing} className="min-w-0 text-sm">
                <FieldValue field={f} value={shownValue(f)} pickers={pickers} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}

const isFilled = (v: unknown) =>
  v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);

const Empty = () => <span className="text-muted-foreground">Empty</span>;

function refLabel(value: unknown, pickers: Pickers): string | null {
  const ref = value as { id?: unknown; linkType?: unknown } | null;
  if (!ref || typeof ref.id !== 'string') return null;
  const list = ref.linkType === 'Asset' ? pickers.assets : pickers.entries;
  return list.find((o) => o.id === ref.id)?.label ?? ref.id;
}

function FieldValue({
  field,
  value,
  pickers,
}: {
  field: Pick<FieldDefinition, 'type' | 'items' | 'fields'>;
  value: unknown;
  pickers: Pickers;
}): ReactNode {
  if (!isFilled(value)) return <Empty />;
  switch (field.type) {
    case 'Text':
      return <p className="whitespace-pre-wrap break-words">{String(value)}</p>;
    case 'Slug':
      return <span className="break-all font-mono text-xs">{String(value)}</span>;
    case 'Boolean':
      return value ? 'Yes' : 'No';
    case 'Integer':
    case 'Number':
      return <span className="tabular">{String(value)}</span>;
    case 'Date':
      return <time dateTime={String(value)}>{String(value)}</time>;
    case 'Location': {
      const l = value as { lat?: unknown; lon?: unknown };
      return (
        <span className="tabular">
          {String(l.lat)}, {String(l.lon)}
        </span>
      );
    }
    case 'JSON':
      return (
        <pre className="max-h-48 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
          {JSON.stringify(value, null, 2)}
        </pre>
      );
    case 'Link':
      return <RefChip label={refLabel(value, pickers)} />;
    case 'RichText':
      return isRichTextDocument(value) ? (
        <div className="space-y-2 break-words">
          {value.content.map((n, i) => (
            <RichNode key={i} node={n} pickers={pickers} />
          ))}
        </div>
      ) : (
        <Empty />
      );
    case 'Component':
      return <Nested fields={field.fields ?? []} value={value} pickers={pickers} />;
    case 'Seo':
      return <Nested fields={SEO_FIELDS} value={value} pickers={pickers} />;
    case 'Array': {
      const items = Array.isArray(value) ? value : [];
      const of = field.items;
      if (of?.type === 'Component' && of.variants)
        return (
          <ol className="space-y-3">
            {items.map((item, i) => {
              const variant = variantOf(of.variants ?? [], item);
              const type = (item as Record<string, unknown> | null)?._type;
              return (
                <li key={i} className="space-y-1 border-l-2 pl-3">
                  <p className="caption">
                    {variant?.name ?? `Unknown block “${typeof type === 'string' ? type : ''}”`}
                  </p>
                  {variant && <Nested fields={variant.fields} value={item} pickers={pickers} />}
                </li>
              );
            })}
          </ol>
        );
      if (of?.type === 'Component')
        return (
          <ol className="space-y-3">
            {items.map((item, i) => (
              <li key={i} className="border-l-2 pl-3">
                <Nested fields={of.fields ?? []} value={item} pickers={pickers} />
              </li>
            ))}
          </ol>
        );
      if (of?.type === 'Link')
        return (
          <ul className="flex flex-wrap gap-1.5">
            {items.map((item, i) => (
              <li key={i}>
                <RefChip label={refLabel(item, pickers)} />
              </li>
            ))}
          </ul>
        );
      return (
        <ul className="flex flex-wrap gap-1.5">
          {items.map((item, i) => (
            <li key={i}>
              <Badge variant="secondary">{String(item)}</Badge>
            </li>
          ))}
        </ul>
      );
    }
    default:
      return <span className="break-words">{String(value)}</span>;
  }
}

function Nested({
  fields,
  value,
  pickers,
}: {
  fields: readonly FieldDefinition[];
  value: unknown;
  pickers: Pickers;
}) {
  const v = (value ?? {}) as Record<string, unknown>;
  return (
    <dl className="space-y-2">
      {fields.map((f) => (
        <div key={f.apiId} className="min-w-0">
          <dt className="text-muted-foreground text-xs">{f.name}</dt>
          <dd className="min-w-0">
            <FieldValue field={f} value={v[f.apiId]} pickers={pickers} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function RefChip({ label }: { label: string | null }) {
  return label ? <Badge variant="outline">{label}</Badge> : <Empty />;
}

const HEADINGS: Record<string, string> = {
  'heading-1': 'text-lg font-semibold',
  'heading-2': 'text-base font-semibold',
  'heading-3': 'text-sm font-semibold',
  'heading-4': 'text-sm font-semibold',
  'heading-5': 'text-sm font-medium',
  'heading-6': 'text-sm font-medium',
};

/** One rich-text node, drawn with the admin's type rather than a site's. */
function RichNode({ node, pickers }: { node: RichTextNode; pickers: Pickers }): ReactNode {
  const kids = (node.content ?? []).map((n, i) => <RichNode key={i} node={n} pickers={pickers} />);
  const t = node.nodeType;
  if (t === 'text') {
    let out: ReactNode = node.value ?? '';
    for (const m of node.marks ?? []) {
      if (m.type === 'bold') out = <strong>{out}</strong>;
      else if (m.type === 'italic') out = <em>{out}</em>;
      else if (m.type === 'underline') out = <u>{out}</u>;
      else if (m.type === 'strikethrough') out = <s>{out}</s>;
      else if (m.type === 'code') out = <code className="font-mono text-xs">{out}</code>;
    }
    return out;
  }
  if (t === 'paragraph') return <p>{kids}</p>;
  if (t in HEADINGS) return <p className={HEADINGS[t]}>{kids}</p>;
  if (t === 'unordered-list') return <ul className="list-disc space-y-1 pl-5">{kids}</ul>;
  if (t === 'ordered-list') return <ol className="list-decimal space-y-1 pl-5">{kids}</ol>;
  if (t === 'list-item') return <li>{kids}</li>;
  if (t === 'blockquote')
    return <blockquote className="border-l-2 pl-3 text-muted-foreground">{kids}</blockquote>;
  if (t === 'hr') return <hr className="border-border" />;
  // Only a sound table is drawn as a grid, its rows and cells from here alone:
  // a row or cell anywhere else would be invalid markup, so a malformed table
  // (and a stray row or cell) falls through to its text, below.
  if (t === 'table' && isWellFormedTable(node)) return <RichTable node={node} pickers={pickers} />;
  // External media as the editor shows it, a card linking out; never the provider's player.
  // Only an embed the domain accepts (an https URL on an allowed provider) gets a link.
  if (t === 'embed' && embedDataIssues(node.data).length === 0) {
    return (
      <div className="my-1">
        <EmbedCard embed={node.data as unknown as EmbedData} />
      </div>
    );
  }
  if (t === 'hyperlink') {
    const uri = typeof node.data?.uri === 'string' ? node.data.uri : undefined;
    return (
      <span className="text-link underline underline-offset-2" title={uri}>
        {kids}
      </span>
    );
  }
  const target = node.data?.target;
  if (target) {
    const label = refLabel(target, pickers);
    return t.endsWith('-block') ? (
      <div>
        <RefChip label={label} />
      </div>
    ) : (
      <RefChip label={label} />
    );
  }
  // Anything newer: its text, so nothing typed goes missing.
  return <div>{kids}</div>;
}

/** A well-formed table (see `isWellFormedTable`), its spans kept. */
function RichTable({ node, pickers }: { node: RichTextNode; pickers: Pickers }) {
  const span = (cell: RichTextNode, k: 'colspan' | 'rowspan') =>
    Number.isInteger(cell.data?.[k]) ? (cell.data?.[k] as number) : undefined;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <tbody>
          {(node.content ?? []).map((row, r) => (
            <tr key={r}>
              {(row.content ?? []).map((cell, c) => {
                const Cell = cell.nodeType === 'table-header-cell' ? 'th' : 'td';
                return (
                  <Cell
                    key={c}
                    colSpan={span(cell, 'colspan')}
                    rowSpan={span(cell, 'rowspan')}
                    className={cn(
                      'space-y-1 border border-border px-2 py-1 align-top',
                      Cell === 'th' && 'bg-muted font-semibold',
                    )}
                  >
                    {(cell.content ?? []).map((n, i) => (
                      <RichNode key={i} node={n} pickers={pickers} />
                    ))}
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
