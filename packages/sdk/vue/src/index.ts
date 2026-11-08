import {
  type DeliveredAsset,
  type DeliveredEntry,
  type DeliveryClient,
  type EntryQuery,
  type Fields,
  imageProps,
  type SearchHit,
} from '@commerceworker/sdk-core';
/**
 * @commerceworker/sdk-vue — Vue 3 composables over @commerceworker/sdk-core, mirroring @commerceworker/sdk-web's
 * React hooks. Install the client with `app.use(createCommerceworker(client))`
 * (in Nuxt: inside a plugin via `nuxtApp.vueApp.use(...)`), then call
 * `useEntry` / `useEntries` / `useAsset` / `useSemanticSearch` in setup, and render assets
 * with `<CwImage>`. Inputs accept
 * plain values, refs, or getters; changes re-fetch automatically.
 *
 * Fetching starts on mount (client-side), matching the React hooks' SSR
 * behavior — no request runs during server-side rendering. For server-fetched
 * Nuxt data, wrap the client's promise methods in `useAsyncData` instead.
 */
import {
  type App,
  defineComponent,
  getCurrentInstance,
  getCurrentScope,
  h,
  type InjectionKey,
  inject,
  type MaybeRefOrGetter,
  onMounted,
  onScopeDispose,
  type Plugin,
  type PropType,
  type Ref,
  ref,
  shallowRef,
  toValue,
  watchEffect,
} from 'vue';

export interface AsyncRefs<T> {
  readonly data: Ref<T | undefined>;
  readonly error: Ref<Error | undefined>;
  readonly loading: Ref<boolean>;
}

const CLIENT_KEY: InjectionKey<DeliveryClient> = Symbol('commerceworker-client');

/** App plugin supplying the Delivery client to the composables. */
export function createCommerceworker(client: DeliveryClient): Plugin {
  return {
    install(app: App) {
      app.provide(CLIENT_KEY, client);
    },
  };
}

export function useDeliveryClient(): DeliveryClient {
  const client = inject(CLIENT_KEY, null);
  if (!client) {
    throw new Error('useDeliveryClient requires app.use(createCommerceworker(client))');
  }
  return client;
}

/**
 * Reactive async state over a tracked fetch. `run` reads its reactive inputs
 * via `toValue`, so `watchEffect` re-runs it when any input changes; a version
 * counter discards stale settlements (rapid input changes never race).
 */
function useAsync<T>(
  client: DeliveryClient,
  run: (client: DeliveryClient) => Promise<T>,
): AsyncRefs<T> {
  const data = shallowRef<T | undefined>(undefined);
  const error = shallowRef<Error | undefined>(undefined);
  const loading = ref(true);
  let version = 0;
  let active = true;

  const start = () => {
    watchEffect(() => {
      const ticket = ++version;
      loading.value = true;
      error.value = undefined;
      // Parity with the React hooks: a re-fetch clears the previous data
      // rather than serving it stale alongside a new error.
      data.value = undefined;
      run(client).then(
        (value) => {
          if (active && ticket === version) {
            data.value = value;
            loading.value = false;
          }
        },
        (err) => {
          if (active && ticket === version) {
            error.value = err instanceof Error ? err : new Error(String(err));
            loading.value = false;
          }
        },
      );
    });
  };

  if (getCurrentInstance()) {
    // Component usage: fetch from mount (client-side only — SSR renders the
    // loading state, matching the React hooks).
    onMounted(start);
  } else if (typeof window !== 'undefined') {
    // Bare client-side usage (tests, stores): start immediately. On the
    // server (Nuxt plugins/stores during SSR) nothing fetches — the
    // documented no-request-during-SSR behavior holds in every branch.
    start();
  }
  // Cleanup keys on the enclosing effect scope (a component's own scope, a
  // pinia store scope, or an explicit effectScope), not just unmount.
  if (getCurrentScope()) {
    onScopeDispose(() => {
      active = false;
    });
  }
  return { data, error, loading };
}

/** Fetches a single published entry; re-fetches when inputs change. */
export function useEntry<F extends Fields = Fields>(
  id: MaybeRefOrGetter<string>,
  opts: {
    locale?: MaybeRefOrGetter<string | undefined>;
    include?: MaybeRefOrGetter<number | undefined>;
  } = {},
): AsyncRefs<DeliveredEntry<F>> {
  const client = useDeliveryClient();
  return useAsync(client, (c) =>
    c.getEntry<F>(toValue(id), { locale: toValue(opts.locale), include: toValue(opts.include) }),
  );
}

/** Fetches a single published asset (from a preview client: as it is now); re-fetches on change. */
export function useAsset(
  id: MaybeRefOrGetter<string>,
  opts: { locale?: MaybeRefOrGetter<string | undefined> } = {},
): AsyncRefs<DeliveredAsset> {
  const client = useDeliveryClient();
  return useAsync(client, (c) => c.getAsset(toValue(id), { locale: toValue(opts.locale) }));
}

/**
 * An `<img>` for a delivered asset, with `imageProps` applied: the width ladder as `srcset`,
 * `sizes`, intrinsic `width`/`height`, `alt` (alt text, else the title, else decorative), lazy
 * loading unless `priority`, the focal point as `object-position` (shown once CSS gives the image
 * `object-fit: cover`) and the dominant colour as the background while it loads. Other attributes
 * fall through, and an `alt`, `class` or `style` given here wins or merges. Renders nothing while
 * `asset` is unset or for an asset with no image to show (audio, a document).
 *
 * ```vue
 * <CwImage :asset="hero" sizes="(min-width: 960px) 960px, 100vw" priority class="hero" />
 * ```
 */
export const CwImage = defineComponent({
  name: 'CwImage',
  props: {
    asset: { type: Object as PropType<DeliveredAsset | null | undefined>, default: undefined },
    sizes: { type: String, default: undefined },
    width: { type: Number, default: undefined },
    rendition: { type: String, default: undefined },
    locale: { type: String, default: undefined },
    priority: { type: Boolean, default: false },
  },
  setup(props) {
    return () => {
      if (!props.asset) return null;
      const image = imageProps(props.asset, {
        sizes: props.sizes,
        width: props.width,
        rendition: props.rendition,
        locale: props.locale,
        priority: props.priority,
      });
      if (!image) return null;
      return h('img', {
        src: image.src,
        srcset: image.srcSet,
        sizes: image.sizes,
        width: image.width,
        height: image.height,
        alt: image.alt,
        loading: image.loading,
        decoding: image.decoding,
        fetchpriority: image.fetchPriority,
        style: image.style,
      });
    };
  },
});

/**
 * Lists published entries; re-fetches when the query changes. Tracking is
 * top-level: replace the query (or nested `filters`/`order` arrays), or pass
 * a getter — mutating a nested array element in place is not observed.
 */
export function useEntries<F extends Fields = Fields>(
  query: MaybeRefOrGetter<EntryQuery> = {},
): AsyncRefs<{ items: DeliveredEntry<F>[]; total: number }> {
  const client = useDeliveryClient();
  return useAsync(client, (c) => c.listEntries<F>({ ...toValue(query) }));
}

/** Semantic search over published content; an empty query yields []. */
export function useSemanticSearch(
  query: MaybeRefOrGetter<string>,
  opts: { topK?: MaybeRefOrGetter<number | undefined> } = {},
): AsyncRefs<SearchHit[]> {
  const client = useDeliveryClient();
  return useAsync(client, (c) => {
    const q = toValue(query);
    return q ? c.search(q, { topK: toValue(opts.topK) }) : Promise.resolve([]);
  });
}

export type {
  AssetPage,
  AssetQuery,
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
