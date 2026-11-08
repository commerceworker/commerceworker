import type { FieldDefinition } from '@commerceworker/domain';
import { ensureContentType } from './helpers';
import type { SeedRun } from './types';

/**
 * The demo content model. Eight types that together cover every field type
 * (Symbol, Text, RichText, Integer, Number, Boolean, Date, Location, JSON,
 * Link, Array, and Components as a repeater and as blocks) and every
 * validation rule (in, regexp, range, size, linkContentTypes), plus
 * localized/non-localized and required/optional mixes.
 */
export async function seedContentModel(run: SeedRun): Promise<void> {
  await ensureContentType(run, {
    apiId: 'author',
    name: 'Author',
    displayField: 'name',
    fields: [
      {
        apiId: 'name',
        name: 'Name',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
      {
        apiId: 'role',
        name: 'Role',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 1,
      },
      { apiId: 'bio', name: 'Bio', type: 'Text', localized: true, required: false, position: 2 },
    ],
  });

  await ensureContentType(run, {
    apiId: 'category',
    name: 'Category',
    displayField: 'name',
    fields: [
      { apiId: 'name', name: 'Name', type: 'Symbol', localized: true, required: true, position: 0 },
      {
        apiId: 'slug',
        name: 'Slug',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 1,
        validations: { regexp: { pattern: '^[a-z0-9-]+$' } },
      },
      {
        apiId: 'parent',
        name: 'Parent category',
        type: 'Link',
        linkType: 'Entry',
        localized: false,
        required: false,
        position: 2,
        validations: { linkContentTypes: ['category'] },
      },
    ],
  });

  await ensureContentType(run, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: true,
        required: true,
        position: 0,
      },
      { apiId: 'body', name: 'Body', type: 'Text', localized: false, required: false, position: 1 },
      {
        apiId: 'summary',
        name: 'Summary',
        type: 'Symbol',
        localized: true,
        required: false,
        position: 2,
      },
      {
        apiId: 'author',
        name: 'Author',
        type: 'Link',
        linkType: 'Entry',
        localized: false,
        required: false,
        position: 3,
        validations: { linkContentTypes: ['author'] },
      },
      {
        apiId: 'views',
        name: 'Views',
        type: 'Integer',
        localized: false,
        required: false,
        position: 4,
      },
      {
        apiId: 'featured',
        name: 'Featured',
        type: 'Boolean',
        localized: false,
        required: false,
        position: 5,
      },
      {
        apiId: 'publishedDate',
        name: 'Published date',
        type: 'Date',
        localized: false,
        required: false,
        position: 6,
      },
      {
        apiId: 'keywords',
        name: 'Keywords',
        type: 'Array',
        localized: false,
        required: false,
        position: 7,
        items: { type: 'Symbol' },
        validations: { size: { max: 5 } },
      },
      {
        apiId: 'heroImage',
        name: 'Hero image',
        type: 'Link',
        linkType: 'Asset',
        localized: false,
        required: false,
        position: 8,
      },
      {
        apiId: 'category',
        name: 'Category',
        type: 'Link',
        linkType: 'Entry',
        localized: false,
        required: false,
        position: 9,
        validations: { linkContentTypes: ['category'] },
      },
      {
        apiId: 'readingTime',
        name: 'Reading time (min)',
        type: 'Integer',
        localized: false,
        required: false,
        position: 10,
        validations: { range: { min: 1, max: 60 } },
      },
      // A repeater, so the seeded model exercises the shape components exist
      // for — and so the admin's nested editor has something to render.
      {
        apiId: 'callouts',
        name: 'Callouts',
        type: 'Array',
        localized: false,
        required: false,
        position: 11,
        validations: { size: { max: 4 } },
        items: {
          type: 'Component',
          fields: [
            {
              apiId: 'heading',
              name: 'Heading',
              type: 'Symbol',
              localized: false,
              required: true,
              position: 0,
            },
            {
              apiId: 'body',
              name: 'Body',
              type: 'Text',
              localized: false,
              required: false,
              position: 1,
            },
            {
              apiId: 'image',
              name: 'Image',
              type: 'Link',
              linkType: 'Asset',
              localized: false,
              required: false,
              position: 2,
            },
          ],
        },
      },
    ],
  });

  await ensureContentType(run, {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: true,
        required: true,
        position: 0,
      },
      {
        apiId: 'slug',
        name: 'Slug',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 1,
      },
      {
        apiId: 'body',
        name: 'Body',
        type: 'RichText',
        localized: true,
        required: false,
        position: 2,
      },
      {
        apiId: 'seoDescription',
        name: 'SEO description',
        type: 'Text',
        localized: true,
        required: false,
        position: 3,
      },
    ],
  });

  await ensureContentType(run, {
    apiId: 'product',
    name: 'Product',
    displayField: 'name',
    fields: [
      { apiId: 'name', name: 'Name', type: 'Symbol', localized: true, required: true, position: 0 },
      {
        apiId: 'description',
        name: 'Description',
        type: 'Text',
        localized: true,
        required: false,
        position: 1,
      },
      {
        apiId: 'price',
        name: 'Price',
        type: 'Number',
        localized: false,
        required: false,
        position: 2,
      },
      {
        apiId: 'inStock',
        name: 'In stock',
        type: 'Boolean',
        localized: false,
        required: false,
        position: 3,
      },
      {
        apiId: 'sku',
        name: 'SKU',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 4,
        validations: { regexp: { pattern: '^[A-Z]{2}-\\d{4}$' } },
      },
      {
        apiId: 'images',
        name: 'Images',
        type: 'Array',
        localized: false,
        required: false,
        position: 5,
        items: { type: 'Link', linkType: 'Asset' },
      },
      {
        apiId: 'specs',
        name: 'Specs',
        type: 'JSON',
        localized: false,
        required: false,
        position: 6,
      },
      {
        apiId: 'availability',
        name: 'Availability',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 7,
        validations: { in: ['in-stock', 'backorder', 'discontinued'] },
      },
    ],
  });

  await ensureContentType(run, {
    apiId: 'event',
    name: 'Event',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: true,
        required: true,
        position: 0,
      },
      {
        apiId: 'startDate',
        name: 'Starts',
        type: 'Date',
        localized: false,
        required: true,
        position: 1,
      },
      {
        apiId: 'endDate',
        name: 'Ends',
        type: 'Date',
        localized: false,
        required: false,
        position: 2,
      },
      {
        apiId: 'venue',
        name: 'Venue',
        type: 'Location',
        localized: false,
        required: false,
        position: 3,
      },
      {
        apiId: 'capacity',
        name: 'Capacity',
        type: 'Integer',
        localized: false,
        required: false,
        position: 4,
        validations: { range: { min: 10, max: 100000 } },
      },
      {
        apiId: 'status',
        name: 'Status',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 5,
        validations: { in: ['scheduled', 'sold-out', 'cancelled'] },
      },
      {
        apiId: 'speakers',
        name: 'Speakers',
        type: 'Array',
        localized: false,
        required: false,
        position: 6,
        items: { type: 'Link', linkType: 'Entry', validations: { linkContentTypes: ['author'] } },
      },
    ],
  });

  await ensureContentType(run, {
    apiId: 'recipe',
    name: 'Recipe',
    displayField: 'name',
    fields: [
      {
        apiId: 'name',
        name: 'Name',
        type: 'Symbol',
        localized: true,
        required: true,
        position: 0,
        validations: { size: { min: 3, max: 80 } },
      },
      {
        apiId: 'instructions',
        name: 'Instructions',
        type: 'RichText',
        localized: true,
        required: false,
        position: 1,
      },
      {
        apiId: 'nutrition',
        name: 'Nutrition facts',
        type: 'JSON',
        localized: false,
        required: false,
        position: 2,
      },
      {
        apiId: 'servings',
        name: 'Servings',
        type: 'Number',
        localized: false,
        required: false,
        position: 3,
        validations: { range: { min: 1, max: 24 } },
      },
      {
        apiId: 'relatedProducts',
        name: 'Related products',
        type: 'Array',
        localized: false,
        required: false,
        position: 4,
        items: { type: 'Link', linkType: 'Entry', validations: { linkContentTypes: ['product'] } },
      },
    ],
  });

  await ensureContentType(run, {
    apiId: 'landingPage',
    name: 'Landing page',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: true,
        required: true,
        position: 0,
      },
      {
        apiId: 'slug',
        name: 'Slug',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 1,
        validations: { regexp: { pattern: '^[a-z0-9-]+$' } },
      },
      {
        apiId: 'body',
        name: 'Body',
        type: 'RichText',
        localized: true,
        required: false,
        position: 2,
      },
      {
        apiId: 'sections',
        name: 'Sections',
        type: 'Array',
        localized: false,
        required: false,
        position: 3,
        items: {
          type: 'Link',
          linkType: 'Entry',
          validations: { linkContentTypes: ['article', 'page'] },
        },
      },
      {
        apiId: 'hero',
        name: 'Hero asset',
        type: 'Link',
        linkType: 'Asset',
        localized: false,
        required: false,
        position: 4,
      },
      {
        // Blocks: the page body as an ordered list of mixed sections.
        apiId: 'blocks',
        name: 'Blocks',
        type: 'Array',
        localized: true,
        required: false,
        position: 5,
        items: {
          type: 'Component',
          variants: [
            {
              apiId: 'hero',
              name: 'Hero',
              fields: [
                nested({ apiId: 'heading', name: 'Heading', type: 'Symbol', required: true }),
                nested({ apiId: 'subheading', name: 'Subheading', type: 'Text', position: 1 }),
                nested({
                  apiId: 'image',
                  name: 'Image',
                  type: 'Link',
                  linkType: 'Asset',
                  position: 2,
                }),
              ],
            },
            {
              apiId: 'richText',
              name: 'Rich text',
              fields: [nested({ apiId: 'body', name: 'Body', type: 'RichText', required: true })],
            },
            {
              apiId: 'callToAction',
              name: 'Call to action',
              fields: [
                nested({ apiId: 'label', name: 'Label', type: 'Symbol', required: true }),
                nested({
                  apiId: 'target',
                  name: 'Target',
                  type: 'Link',
                  linkType: 'Entry',
                  position: 1,
                  validations: { linkContentTypes: ['article', 'page'] },
                }),
                nested({
                  apiId: 'style',
                  name: 'Style',
                  type: 'Symbol',
                  position: 2,
                  defaultValue: 'primary',
                  validations: { in: ['primary', 'secondary'] },
                }),
              ],
            },
          ],
        },
      },
    ],
  });
}

/** A field inside a component or block: never localized on its own. */
function nested(
  f: Pick<FieldDefinition, 'apiId' | 'name' | 'type'> & Partial<FieldDefinition>,
): FieldDefinition {
  return { localized: false, required: false, position: 0, ...f };
}
