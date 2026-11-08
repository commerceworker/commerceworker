# @commerceworker/sdk-vue

> A private workspace package. It ships on npm inside [`@commerceworker/sdk`](../sdk/README.md) as `@commerceworker/sdk/vue`; the examples below use that name.

Vue 3 composables and components over `@commerceworker/sdk`: `useEntry`,
`useEntries`, `useAsset`, `useSemanticSearch` and `<CwImage>` for delivered assets. Inputs take
plain values, refs or getters and re-fetch on change; fetching starts on mount, never during SSR.

```sh
npm install @commerceworker/sdk vue
```

```ts
// main.ts (Nuxt: inside a plugin, nuxtApp.vueApp.use(...))
import { createCommerceworker, createDeliveryClient } from '@commerceworker/sdk/vue';

app.use(createCommerceworker(createDeliveryClient({ baseUrl, space, environment: 'main', token })));
```

```vue
<script setup lang="ts">
import { CwImage, useAsset } from '@commerceworker/sdk/vue';
const props = defineProps<{ id: string }>();
const { data } = useAsset(() => props.id, { locale: 'en-US' });
</script>

<template>
  <!-- srcset, sizes, width/height, alt, lazy loading, focal point and placeholder colour -->
  <CwImage :asset="data" :width="320" class="card-image" />
</template>
```

The focal point arrives as `object-position`; give the image `object-fit: cover` in a box of
another shape to use it. `alt`, `class` and `style` fall through and win or merge.

**Local development.** A local stack has no media origin, so assets have an empty `srcset` and no
renditions, and `<CwImage>` renders the one signed `src`.

## Docs

- [SDKs guide](https://docs.commerceworker.com/content/guides/sdks/)
- [Build an image component](https://docs.commerceworker.com/content/guides/delivering-assets/#build-an-image-component)
