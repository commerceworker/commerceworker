import {
  type ContentRef,
  type DeliveredAsset,
  type DeliveredEntry,
  type DeliveryClient,
  type EntryQuery,
  type Fields,
  type ImagePropsOptions,
  imageProps,
  type SearchHit,
} from '@commerceworker/sdk-core';
import { mountInlineEditor } from '@commerceworker/sdk-core/inline-edit';
/**
 * @commerceworker/sdk-web — React hooks over @commerceworker/sdk-core. Provide a client via
 * `CommerceworkerProvider`, then call `useEntry` / `useEntries` / `useAsset` /
 * `useSemanticSearch`, and render assets with `<Image>`. SSR-safe (no fetch on the server unless invoked).
 */
import {
  type CSSProperties,
  createContext,
  createElement,
  type ImgHTMLAttributes,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';

export interface AsyncState<T> {
  readonly data?: T;
  readonly error?: Error;
  readonly loading: boolean;
}

const ClientContext = createContext<DeliveryClient | null>(null);

/** Supplies a Delivery client to the hook tree. */
export function CommerceworkerProvider(props: { client: DeliveryClient; children: ReactNode }) {
  return createElement(ClientContext.Provider, { value: props.client }, props.children);
}

export function useDeliveryClient(): DeliveryClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error('useDeliveryClient must be used within a <CommerceworkerProvider>');
  return client;
}

function useAsync<T>(run: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ loading: true });
  useEffect(() => {
    let active = true;
    setState({ loading: true });
    run().then(
      (data) => active && setState({ data, loading: false }),
      (error) => active && setState({ error: error as Error, loading: false }),
    );
    return () => {
      active = false;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` is the caller's own dependency array, forwarded verbatim — this hook cannot know what is in it, which is the point of taking one.
  }, deps);
  return state;
}

/** Fetches a single published entry. */
export function useEntry<F extends Fields = Fields>(
  id: string,
  opts: { locale?: string; include?: number } = {},
): AsyncState<DeliveredEntry<F>> {
  const client = useDeliveryClient();
  return useAsync(() => client.getEntry<F>(id, opts), [id, opts.locale, opts.include]);
}

/** Fetches a single published asset (from a preview client: as it is now). */
export function useAsset(id: string, opts: { locale?: string } = {}): AsyncState<DeliveredAsset> {
  const client = useDeliveryClient();
  return useAsync(() => client.getAsset(id, opts), [id, opts.locale]);
}

export interface ImageComponentProps
  extends ImagePropsOptions,
    Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'sizes' | 'width'> {
  /** The delivered asset; nothing renders while it's `null` or `undefined` (still loading). */
  readonly asset: DeliveredAsset | null | undefined;
}

/**
 * An `<img>` for a delivered asset, with {@link imageProps} applied: the width ladder as
 * `srcSet`, `sizes`, intrinsic `width`/`height`, `alt` (alt text, else the title, else decorative),
 * lazy loading unless `priority`, the focal point as `object-position` (it shows once CSS gives
 * the image `object-fit: cover` in a box of another shape) and the dominant colour as the
 * background while it loads. Other `<img>` attributes pass through; `alt` and `style` given
 * here win. Renders nothing for an asset with no image to show (audio, a document).
 *
 * ```tsx
 * <Image asset={hero} sizes="(min-width: 960px) 960px, 100vw" priority className="hero" />
 * ```
 */
export function Image(props: ImageComponentProps): ReactElement | null {
  const { asset, sizes, width, rendition, locale, priority, style, ...rest } = props;
  if (!asset) return null;
  const image = imageProps(asset, { sizes, width, rendition, locale, priority });
  if (!image) return null;
  return createElement('img', {
    ...image,
    ...rest,
    alt: rest.alt ?? image.alt,
    style: { ...image.style, ...style } satisfies CSSProperties,
  });
}

/** Lists published entries. */
export function useEntries<F extends Fields = Fields>(
  query: EntryQuery = {},
): AsyncState<{ items: DeliveredEntry<F>[]; total: number }> {
  const client = useDeliveryClient();
  return useAsync(
    () => client.listEntries<F>(query),
    [query.contentType, query.locale, query.include, query.limit, query.skip],
  );
}

/** Semantic search over published content. */
/**
 * Marks rendered values as the fields they came from:
 *
 * ```tsx
 * const editable = useEditable();
 * <h1 {...editable(entry, 'title')}>{entry.fields.title}</h1>
 * ```
 *
 * Returns nothing to spread unless the client is in preview mode, so the same
 * component ships to production without emitting edit metadata.
 */
export function useEditable() {
  const client = useDeliveryClient();
  return useCallback(
    (entry: Pick<DeliveredEntry, 'id' | 'contentType'>, field: string, locale?: string) =>
      client.editable(entry, field, { locale }),
    [client],
  );
}

/**
 * Mounts the click-to-edit overlay for as long as it is rendered.
 *
 * Renders no markup of its own — the overlay attaches to the document — so it
 * can sit anywhere in the tree. It is inert during SSR and mounts on the client.
 */
export function InlineEditor(props: {
  adminUrl?: string;
  onEdit?: (ref: ContentRef) => void;
  defaultEnabled?: boolean;
  toggle?: boolean;
}): null {
  const { adminUrl, onEdit, defaultEnabled, toggle } = props;
  useEffect(() => {
    const editor = mountInlineEditor({ adminUrl, onEdit, defaultEnabled, toggle });
    return () => editor.destroy();
  }, [adminUrl, onEdit, defaultEnabled, toggle]);
  return null;
}

export function useSemanticSearch(
  query: string,
  opts: { topK?: number } = {},
): AsyncState<SearchHit[]> {
  const client = useDeliveryClient();
  return useAsync(
    () => (query ? client.search(query, opts) : Promise.resolve([])),
    [query, opts.topK],
  );
}

export type {
  AssetPage,
  AssetQuery,
  ContentRef,
  DeliveredAsset,
  DeliveredEntry,
  DeliveryClient,
  EntryQuery,
  ImageProps,
  ImagePropsOptions,
  SearchHit,
} from '@commerceworker/sdk-core';
export {
  assetUrl,
  createDeliveryClient,
  DeliveryError,
  imageProps,
  localizedText,
  srcset,
} from '@commerceworker/sdk-core';
