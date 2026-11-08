/**
 * The shape of a CommerceWorker rich-text value, as the Delivery and Preview APIs return it.
 * Redeclared here (SDKs never import the CMS's own packages).
 */

export interface RichTextMark {
  readonly type: string;
}

/**
 * What a reference node points at. Delivery embeds the target when it can (an entry with its
 * `fields`, an asset with its `url`); otherwise it's a stub `{ id, linkType }`.
 */
export interface RichTextTarget {
  readonly id: string;
  readonly linkType?: 'Entry' | 'Asset';
  readonly contentType?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly url?: string;
  readonly [key: string]: unknown;
}

export interface RichTextNode {
  readonly nodeType: string;
  readonly content?: readonly RichTextNode[];
  readonly value?: string;
  readonly marks?: readonly RichTextMark[];
  readonly data?: Readonly<Record<string, unknown>> & {
    readonly uri?: string;
    readonly target?: RichTextTarget;
  };
}

export interface RichTextDocument {
  readonly nodeType: 'document';
  readonly content: readonly RichTextNode[];
  readonly data?: Readonly<Record<string, unknown>>;
}

/** A delivered asset, as Delivery embeds it in a reference node. */
export interface DeliveredAsset extends RichTextTarget {
  readonly url: string;
  readonly altText?: string | null;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly srcset?: readonly { readonly width: number; readonly url: string }[];
}

export function isRichTextDocument(value: unknown): value is RichTextDocument {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { nodeType?: unknown }).nodeType === 'document' &&
    Array.isArray((value as { content?: unknown }).content)
  );
}
