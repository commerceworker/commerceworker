import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper } from '@tiptap/react';
import { FileText, Image } from 'lucide-react';
import { createContext, useContext, useId } from 'react';
import { EntityPicker } from '~/cms/components/EntityPicker';
import type { Pickers } from '../EntryForm';

/** Picker options reach embed NodeViews through context (they render in portals). */
export const RichTextPickersContext = createContext<Pickers>({ entries: [], assets: [] });

/** Card for an embedded entry/asset atom: icon, label, and a target picker. */
export function EmbedNodeView(props: NodeViewProps) {
  const pickers = useContext(RichTextPickersContext);
  const pickerId = useId();
  const isAsset = props.node.type.name === 'embeddedAssetBlock';
  const options = isAsset ? pickers.assets : pickers.entries;
  const targetId = (props.node.attrs.targetId as string) ?? '';
  const label = isAsset ? 'asset' : 'entry';

  return (
    <NodeViewWrapper data-testid={`embed-${label}`} className="my-2">
      <div
        data-drag-handle
        className="flex items-center gap-2 rounded-md border bg-muted/40 p-2"
        contentEditable={false}
      >
        {isAsset ? (
          <Image className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <FileText className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="text-muted-foreground text-xs">Embedded {label}</span>
        <div className="min-w-0 flex-1">
          <EntityPicker
            id={pickerId}
            ariaLabel={`Pick an ${label}`}
            options={options}
            value={targetId}
            placeholder={`Search for an ${label}…`}
            onChange={(v) => props.updateAttributes({ targetId: v ?? '' })}
          />
        </div>
      </div>
    </NodeViewWrapper>
  );
}

/** Inline chip for an entry embedded mid-sentence (targetId picked on insert). */
export function InlineEmbedNodeView(props: NodeViewProps) {
  const pickers = useContext(RichTextPickersContext);
  const targetId = (props.node.attrs.targetId as string) ?? '';
  const label = pickers.entries.find((o) => o.id === targetId)?.label ?? (targetId || '?');
  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      <span
        data-testid="embed-inline-entry"
        className="mx-0.5 inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-primary text-xs"
      >
        <FileText className="size-3" />
        {label}
      </span>
    </NodeViewWrapper>
  );
}

/** Muted chip for a stored node the editor doesn't model (kept losslessly). */
export function UnknownNodeView(props: NodeViewProps) {
  const raw = props.node.attrs.raw as { nodeType?: string } | null;
  const inline = props.node.isInline;
  return (
    <NodeViewWrapper
      as={inline ? 'span' : 'div'}
      className={inline ? 'inline' : 'my-2'}
      contentEditable={false}
    >
      <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
        Unsupported {inline ? 'content' : 'block'}: {raw?.nodeType ?? 'unknown'}
      </span>
    </NodeViewWrapper>
  );
}
