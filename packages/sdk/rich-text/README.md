# @commerceworker/sdk-rich-text

> A private workspace package. It ships on npm inside [`@commerceworker/sdk`](../sdk/README.md) as `@commerceworker/sdk/rich-text`; the examples below use that name.

Render CommerceWorker rich text to HTML, Markdown or plain text. CommerceWorker delivers rich text
as a document tree (`RichTextDocument`), never as HTML, so every channel renders it for itself.
This package does it for the web and for text, with no dependencies, in any framework or runtime.

```sh
npm install @commerceworker/sdk
```

```ts
import { toHtml } from '@commerceworker/sdk/rich-text';

const html = toHtml(entry.fields.body, {
  entryHref: (target) => `/${target.fields?.slug}`, // links to other entries
  renderEntry: (target) => renderMyBlock(target), // embedded entries, as your components
});
```

- **Safe by default:** text is escaped, and only http, https, mailto, tel and relative links are
  emitted, checked the way browsers read them.
- **Embedded images** come out sized and lazy, with the delivered `srcset`.
- **Overrides:** replace any node (`nodes: { paragraph: (node, next) => … }`) or mark
  (`marks: { bold: (html) => … }`); return `undefined` to keep the default.
- **`toMarkdown`, `toPlainText`, `excerpt`:** for agents, feeds, search and meta descriptions.

## Docs

- [SDKs guide](https://docs.commerceworker.com/content/guides/sdks/)
