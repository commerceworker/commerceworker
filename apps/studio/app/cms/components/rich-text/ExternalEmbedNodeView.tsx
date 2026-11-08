import { EMBED_PROVIDERS, type EmbedData, type EmbedKind } from '@commerceworker/domain';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper } from '@tiptap/react';
import { ExternalLink, Globe, MessageSquareText, Music, Video } from 'lucide-react';

const KIND_ICONS: Record<EmbedKind, typeof Video> = {
  video: Video,
  post: MessageSquareText,
  audio: Music,
  other: Globe,
};

/** The provider's display name for its stored id (the id itself for one this build doesn't know). */
export const providerName = (id: string): string =>
  EMBED_PROVIDERS.find((p) => p.id === id)?.name ?? id;

/**
 * The card an external embed shows: what it is (a kind icon), its title or URL, the provider
 * and author, and a link out. Never the provider's player: the admin loads no third-party frame
 * or script, and its CSP serves images from this origin only, so the thumbnail a renderer would
 * show is left to the channel.
 */
export function EmbedCard(props: { embed: EmbedData }) {
  const { embed } = props;
  const Icon = KIND_ICONS[embed.kind ?? 'other'] ?? Globe;
  const provider = providerName(embed.provider);
  return (
    <div className="flex items-center gap-3 rounded-md border bg-muted/40 p-2">
      <div className="flex size-10 shrink-0 items-center justify-center rounded bg-muted">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-sm">{embed.title ?? embed.url}</p>
        <p className="truncate text-muted-foreground text-xs">
          {[provider, embed.authorName].filter(Boolean).join(' · ')}
        </p>
      </div>
      <a
        href={embed.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open on ${provider}`}
        className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
      >
        <ExternalLink className="size-4" aria-hidden />
      </a>
    </div>
  );
}

/** Node view for the `externalEmbed` atom. */
export function ExternalEmbedNodeView(props: NodeViewProps) {
  const embed = props.node.attrs.embed as EmbedData | null;
  return (
    <NodeViewWrapper
      data-testid="embed-external"
      className={props.selected ? 'my-2 rounded-md ring-2 ring-ring' : 'my-2'}
    >
      <div data-drag-handle contentEditable={false}>
        {embed ? (
          <EmbedCard embed={embed} />
        ) : (
          <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
            Embed with no URL
          </span>
        )}
      </div>
    </NodeViewWrapper>
  );
}
