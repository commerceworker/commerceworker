# Field shapes, in full

Field definitions as `model apply` and `POST /spaces/{space}/environments/{env}/content-types`
take them. Docs: https://docs.commerceworker.com/content/reference/field-types/#blocks

## A landing page with blocks

```ts
import type { ContentTypeDraft } from '@commerceworker/sdk/management';

export default [
  {
    apiId: 'landingPage',
    name: 'Landing page',
    displayField: 'title',
    fields: [
      { apiId: 'title', name: 'Title', type: 'Symbol', required: true, localized: true },
      { apiId: 'slug', name: 'Slug', type: 'Slug', required: true, unique: true },
      {
        apiId: 'seo',
        name: 'SEO',
        type: 'Component',
        localized: true,
        fields: [
          { apiId: 'description', name: 'Description', type: 'Text', validations: { size: { max: 160 } } },
          { apiId: 'image', name: 'Image', type: 'Link', linkType: 'Asset' },
        ],
      },
      {
        apiId: 'body',
        name: 'Body',
        type: 'Array',
        localized: true,
        items: {
          type: 'Component',
          variants: [
            {
              apiId: 'hero',
              name: 'Hero',
              fields: [
                { apiId: 'heading', name: 'Heading', type: 'Symbol', required: true },
                { apiId: 'image', name: 'Image', type: 'Link', linkType: 'Asset' },
              ],
            },
            {
              apiId: 'richText',
              name: 'Text',
              fields: [{ apiId: 'text', name: 'Text', type: 'RichText', required: true }],
            },
            {
              apiId: 'cta',
              name: 'Call to action',
              fields: [
                { apiId: 'label', name: 'Label', type: 'Symbol', required: true },
                { apiId: 'target', name: 'Target', type: 'Link', linkType: 'Entry', validations: { linkContentTypes: ['landingPage'] } },
              ],
            },
          ],
        },
      },
      {
        apiId: 'faq',
        name: 'FAQ',
        type: 'Array',
        localized: true,
        validations: { size: { max: 20 } },
        items: {
          type: 'Component',
          fields: [
            { apiId: 'question', name: 'Question', type: 'Symbol', required: true },
            { apiId: 'answer', name: 'Answer', type: 'Text', required: true },
          ],
        },
      },
    ],
  },
] satisfies ContentTypeDraft[];
```

`seo` is a component (one group of fields), `body` a blocks field (a list whose items take one of
three shapes), `faq` a repeater (a list of one shape). Localization is set on the outer field; the
nested fields inherit it.

## Stored values

```json
{
  "body": {
    "en-US": [
      { "_type": "hero", "_key": "0192f4a1-…", "heading": "Spring launch", "image": { "id": "…", "linkType": "Asset" } },
      { "_type": "cta", "_key": "0192f4a2-…", "label": "Read more", "target": { "id": "…", "linkType": "Entry" } }
    ]
  }
}
```

Send existing blocks back with their `_key` and they keep it; omit it on a new block and the server
assigns one. Generated types narrow a blocks item on `_type`.

## Value per type

| Type        | Value                                   |
| ----------- | --------------------------------------- |
| `Symbol`, `Slug`, `Text` | string                     |
| `RichText`  | `{ nodeType: 'document', content: [...] }` |
| `Integer`, `Number` | number                          |
| `Boolean`   | boolean                                 |
| `Date`      | ISO 8601 string                         |
| `Location`  | `{ lat, lon }`                          |
| `JSON`      | any JSON value                          |
| `Link`      | `{ id, linkType }`                      |
| `Component` | object of nested field values           |
| `Array`     | array of the item type's values         |

`unique` is allowed on `Symbol`, `Slug`, `Text`, `Integer`, `Number` and `Date`, never inside a
component.
