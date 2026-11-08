/**
 * External media in the editor: the `externalEmbed` atom (stored as an `embed`
 * node, see `~/cms/lib/rich-text-mapper.ts`) and the two ways one arrives,
 * pasting a provider URL on an empty line and the toolbar's embed row.
 *
 * An embed goes in at once with what its URL says (url, provider, kind), which
 * is already a valid node; the api's resolve then fills in the title, author
 * and thumbnail when the provider answers. The editor never loads the
 * provider's player: the card is all an editor needs to see what is there.
 */

import { type EmbedData, embedDataIssues, matchEmbedProvider } from '@commerceworker/domain';
import { type Editor, Node } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { embedDataOf } from '~/cms/lib/rich-text-mapper';
import { ExternalEmbedNodeView } from './ExternalEmbedNodeView';

/** Asks the api for an embed's metadata; `undefined` when it can't be had. */
export type EmbedResolver = (url: string) => Promise<EmbedData | undefined>;

export interface ExternalEmbedOptions {
  /** Read at use, so the editor's extensions stay stable while the client changes. */
  readonly resolver: () => EmbedResolver | undefined;
}

/** The embed data a URL alone gives, or `undefined` when no allowed provider serves it. */
export function embedFromUrl(raw: string): EmbedData | undefined {
  const match = matchEmbedProvider(raw.trim());
  return match
    ? { url: match.url.href, provider: match.provider.id, kind: match.provider.kind }
    : undefined;
}

/**
 * Inserts an embed for `raw` at the selection, then resolves its metadata.
 * False (and nothing inserted) when the URL is not one an embed may hold.
 */
export function insertExternalEmbed(
  editor: Editor,
  raw: string,
  resolve: EmbedResolver | undefined,
): boolean {
  const embed = embedFromUrl(raw);
  if (!embed) return false;
  editor.chain().focus().insertContent({ type: 'externalEmbed', attrs: { embed } }).run();
  void resolve?.(embed.url).then(
    (resolved) => {
      if (resolved) fillEmbed(editor, embed.url, resolved);
    },
    // The bare node is valid on its own; a provider that doesn't answer costs a card title.
    () => undefined,
  );
  return true;
}

/**
 * Writes resolved metadata onto every embed of `url` that has none yet. Found
 * by URL rather than position: the document may have moved on while the
 * provider answered.
 */
function fillEmbed(editor: Editor, url: string, resolved: EmbedData): void {
  if (editor.isDestroyed) return;
  const { tr } = editor.state;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'externalEmbed') return;
    const current = node.attrs.embed as EmbedData | null;
    if (current?.url !== url || current.title) return;
    // The node's URL and provider stay as inserted; only metadata is added.
    const embed = embedDataOf({ ...resolved, url: current.url, provider: current.provider });
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, embed });
  });
  if (tr.docChanged) editor.view.dispatch(tr);
}

/** The single URL a paste consists of, if it is nothing else. */
function pastedUrl(event: ClipboardEvent): string | undefined {
  const text = event.clipboardData?.getData('text/plain')?.trim();
  return text && /^https?:\/\/\S+$/.test(text) ? text : undefined;
}

export const ExternalEmbed = Node.create<ExternalEmbedOptions>({
  name: 'externalEmbed',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addOptions() {
    return { resolver: () => undefined };
  },
  addAttributes() {
    return {
      embed: {
        default: null,
        // Copy and paste goes through HTML, so the data rides as JSON on the element; read
        // back, it keeps only embed keys, and the api validates it on save like any write.
        parseHTML: (element) => {
          try {
            const parsed = JSON.parse(element.getAttribute('data-embed') ?? 'null');
            if (!parsed || typeof parsed !== 'object') return null;
            // Clipboard HTML is anyone's: only an embed the domain accepts becomes one.
            const embed = embedDataOf(parsed);
            return embedDataIssues({ ...embed }).length === 0 ? embed : null;
          } catch {
            return null;
          }
        },
        renderHTML: (attrs) => (attrs.embed ? { 'data-embed': JSON.stringify(attrs.embed) } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-node="externalEmbed"]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    // Pasted elsewhere, the node reads as a link to its URL.
    const url = (node.attrs.embed as EmbedData | null)?.url ?? '';
    return ['div', { ...HTMLAttributes, 'data-node': 'externalEmbed' }, ['a', { href: url }, url]];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ExternalEmbedNodeView);
  },
  addProseMirrorPlugins() {
    const { editor, options } = this;
    return [
      new Plugin({
        props: {
          // A provider URL pasted on an empty line becomes an embed, as it does in most
          // editors; pasted into text, it stays text (the link control makes it a link).
          handlePaste: (view, event) => {
            const url = pastedUrl(event);
            const { $from, empty } = view.state.selection;
            if (!url || !empty || $from.parent.type.name !== 'paragraph') return false;
            if ($from.parent.content.size > 0) return false;
            return insertExternalEmbed(editor, url, options.resolver());
          },
        },
      }),
    ];
  },
});
