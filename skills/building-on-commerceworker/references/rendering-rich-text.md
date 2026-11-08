# Rendering rich text

A `RichText` value is a tree, `{ nodeType: 'document', content: [...] }`. Every node has a
`nodeType`; containers have `content`; `text` nodes have `value` and `marks`; links and references
keep their target in `data`. The API refuses any other node type on write, so a renderer that
covers this list covers everything stored. Docs:
https://docs.commerceworker.com/content/reference/field-types/#rich-text

## Node types

| `nodeType`                                   | Holds                                       | Render as                               |
| -------------------------------------------- | ------------------------------------------- | --------------------------------------- |
| `paragraph`                                  | inline nodes                                | `<p>`                                   |
| `heading-1` … `heading-6`                    | inline nodes                                | `<h1>` … `<h6>`                         |
| `blockquote`                                 | blocks                                      | `<blockquote>`                          |
| `code-block`                                 | text                                        | `<pre><code>`                           |
| `hr`                                         | nothing                                     | `<hr>`                                  |
| `unordered-list`, `ordered-list`             | `list-item` nodes                           | `<ul>`, `<ol>`                          |
| `list-item`                                  | blocks                                      | `<li>`                                  |
| `table` → `table-row` → `table-header-cell`, `table-cell` | rows, then cells holding blocks | `<table>`, `<tr>`, `<th>`, `<td>`       |
| `embedded-entry-block`, `embedded-entry-inline` | `data.target`: `{ id, linkType: 'Entry' }` | your component for that entry           |
| `embedded-asset-block`                       | `data.target`: `{ id, linkType: 'Asset' }`  | an image or file (`imageProps`)         |
| `embed`                                      | `data`: external media metadata             | a link card, or a player you build      |
| `text`                                       | `value`, `marks` (`bold`, `italic`, `code`, …) | text, wrapped per mark              |
| `hard-break`                                 | nothing                                     | `<br>`                                  |
| `hyperlink`                                  | inline nodes; `data.uri`                    | `<a href>`                              |
| `entry-hyperlink`, `asset-hyperlink`         | inline nodes; `data.target`                 | a link to your route for that entry or asset |

Read with `include` (1 or more) and a reference's `data.target` becomes the linked entry or asset
itself; without it, or past the depth, or when the target isn't published, it stays
`{ id, linkType }`. Handle both.

## A renderer

Switch on `nodeType`, recurse into `content`, and render nothing for a type you don't know, so a
node type added later never breaks a page:

```tsx
import { embedCard } from '@commerceworker/sdk';

type Node = { nodeType: string; content?: Node[]; value?: string; marks?: { type: string }[]; data?: Record<string, unknown> };

export function RichText({ node }: { node: Node }): JSX.Element | null {
  const children = node.content?.map((child, i) => <RichText key={i} node={child} />);
  switch (node.nodeType) {
    case 'document': return <>{children}</>;
    case 'paragraph': return <p>{children}</p>;
    case 'heading-2': return <h2>{children}</h2>;
    case 'unordered-list': return <ul>{children}</ul>;
    case 'list-item': return <li>{children}</li>;
    case 'hyperlink': return <a href={String(node.data?.uri)}>{children}</a>;
    case 'text': {
      let out: JSX.Element = <>{node.value}</>;
      for (const mark of node.marks ?? []) {
        if (mark.type === 'bold') out = <strong>{out}</strong>;
        if (mark.type === 'italic') out = <em>{out}</em>;
        if (mark.type === 'code') out = <code>{out}</code>;
      }
      return out;
    }
    case 'embed': {
      const card = embedCard(node);
      return card ? <a href={card.href} target="_blank" rel="noopener noreferrer">{card.title} ({card.providerName})</a> : null;
    }
    // …the remaining types from the table above
    default: return null;
  }
}
```

## Embeds

An `embed` node holds a video, post or track from an allowed provider (`youtube`, `vimeo`, `x`,
`bluesky`, `mastodon`, `spotify`, `soundcloud`) as metadata, never the provider's HTML:
`{ url, provider, kind?, title?, authorName?, thumbnail?, width?, height?, aspectRatio? }`. Only
`url` (https) and `provider` are always there.

- **Safe default:** `embedCard(node)` returns `{ href, title, provider, providerName, kind,
  authorName?, thumbnail? }` with an https `href` and lazy, referrer-free thumbnail attributes, or
  `undefined` for any other node.
- **A player:** build it from `provider` and `url` yourself, for example an `<iframe>` of
  `https://www.youtube-nocookie.com/embed/<id>`, sized by `aspectRatio` so the box is reserved
  before it loads.
- A `mastodon` embed's host is whatever instance the author named: show the link card unless the
  host is on your own allow list.

## Writing rich text

Send a document, not markup. To turn existing HTML into a document (an import), map it to a
`RichText` field in `commerceworker import`: the import converts HTML on the way in. Validation
caps a document at 512 KiB and 64 levels, and only allows `http`, `https`, `mailto`, `tel` and
relative link targets.
