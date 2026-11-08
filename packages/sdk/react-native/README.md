# @commerceworker/sdk-react-native

> A private workspace package. It ships on npm inside [`@commerceworker/sdk`](../sdk/README.md) as `@commerceworker/sdk/react-native`; the examples below use that name.

Delivery for React Native over `@commerceworker/sdk`: an offline entry cache with
delta sync (`createOfflineDelivery`, `useOfflineEntries`) and image helpers for delivered assets.

```sh
npm install @commerceworker/sdk
```

```tsx
import { Image, PixelRatio } from 'react-native';
import { imageProps, imageSource } from '@commerceworker/sdk/react-native';

// The width step at or above 320 × the screen's density, sized 320 dp wide with the image's
// aspect ratio; a hosted video gives its thumbnail, a document undefined.
const source = imageSource(asset, { width: 320, dpr: PixelRatio.get() });
{
  // alt: the alt text, else the title, else '' (decorative), as on the web.
  source && <Image source={source} alt={imageProps(asset)?.alt ?? ''} />;
}
```

`imageUrl(asset, { width, dpr, rendition })` gives the URL alone. Neither ever adds parameters to
a URL: delivered URLs are signed.

```ts
import { createDeliveryClient, createOfflineDelivery } from '@commerceworker/sdk/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const store = createOfflineDelivery({ client, storage: AsyncStorage, contentType: 'article' });
await store.sync(); // entries published since the last sync
```

**Local development.** A local stack has no media origin, so assets have no width ladder and no
renditions: `imageSource` gives the original's signed, short-lived URL.

## Docs

- [SDKs guide](https://docs.commerceworker.com/content/guides/sdks/)
- [Build an image component](https://docs.commerceworker.com/content/guides/delivering-assets/#build-an-image-component)
