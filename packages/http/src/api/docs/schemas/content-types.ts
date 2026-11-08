import {
  ARRAY_ITEM_TYPES,
  CONTENT_TYPE_LIMITS,
  DATE_FORMATS,
  FIELD_GUIDANCE_LIMITS,
  LAYOUT_LIMITS,
  MAX_FIELD_RULES,
  MAX_PREVIEW_TEMPLATE_LENGTH,
  PATTERN_PRESETS,
  RULE_ACTIONS,
  RULE_OPERATORS,
} from '@commerceworker/domain';
import { z } from 'zod';

/**
 * A field definition. Recursive (a component's nested fields are field
 * definitions too), so the nested shapes are described as open objects rather
 * than repeating this one: `z.lazy` would emit a `$ref` cycle the reference
 * renderer does not draw well, and the domain validates the deep shape anyway.
 */
const nestedFields = z
  .array(z.object({}).loose())
  .describe('Nested field definitions (this same shape), for a component');

const option = z
  .union([
    z.string().min(1),
    z.number(),
    z.object({
      value: z
        .union([z.string().min(1), z.number()])
        .describe('What an entry stores and is checked against'),
      label: z
        .string()
        .max(FIELD_GUIDANCE_LIMITS.optionLabel)
        .describe('What an editor picks it by'),
    }),
  ])
  .describe('An allowed value, bare or labelled, listed once');

const range = z.object({ min: z.number().optional(), max: z.number().optional() });

/** A field's validation rules. Every rule is optional; an absent rule is not enforced. */
export const fieldValidations = z
  .object({
    in: z
      .array(option)
      .optional()
      .describe(
        'Allowed values (Symbol, Text, Integer, Number). A labelled option stores its `value`',
      ),
    regexp: z
      .object({
        pattern: z.string().optional().describe('Required unless a preset is named'),
        flags: z.string().optional(),
        preset: z
          .enum(Object.keys(PATTERN_PRESETS) as [keyof typeof PATTERN_PRESETS])
          .optional()
          .describe(
            `A named pattern: ${Object.entries(PATTERN_PRESETS)
              .map(([k, p]) => `\`${k}\` (${p.name})`)
              .join(', ')}. Saved with its pattern and flags filled in`,
          ),
      })
      .optional()
      .describe('A pattern a Symbol or Text value must match'),
    range: range.optional().describe('Inclusive bounds of an Integer or Number'),
    size: range
      .optional()
      .describe('Inclusive length of a Symbol, Text or Slug, or item count of an Array'),
    linkContentTypes: z
      .array(z.string())
      .optional()
      .describe('The content types a Link may point at'),
    dateRange: z
      .object({ min: z.string().optional(), max: z.string().optional() })
      .optional()
      .describe('Inclusive bounds of a Date, written in its format'),
    assetMimeTypes: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'MIME types an asset Link (or Array of them) accepts, exact (`application/pdf`) or by family (`image/*`); checked against the asset on write',
      ),
    messages: z
      .object({
        in: z.string().optional(),
        regexp: z.string().optional(),
        range: z.string().optional(),
        size: z.string().optional(),
        dateRange: z.string().optional(),
        assetMimeTypes: z.string().optional(),
      })
      .optional()
      .describe(
        `Error text a broken rule reports instead of the default, keyed by rule (at most ${FIELD_GUIDANCE_LIMITS.message} characters). Only for a rule the field declares`,
      ),
  })
  .loose();

/** A conditional rule: hide or disable the field while a sibling's value matches. */
export const fieldRule = z.object({
  action: z
    .enum(RULE_ACTIONS)
    .describe(
      '`hide`: not shown and not required. `disable`: read-only, keeping its stored value; a write that changes it is refused',
    ),
  when: z.object({
    field: z
      .string()
      .describe(
        'The sibling read: another field at the same level, or a dot path into a sibling component (`hero.style`)',
      ),
    operator: z
      .enum(RULE_OPERATORS)
      .describe('`gt` and `lt` compare a number sibling; `empty` and `notEmpty` take no value'),
    value: z
      .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
      .optional()
      .describe('What the sibling is compared with: a list for `in`'),
  }),
});

export const field = z.object({
  apiId: z.string(),
  name: z.string(),
  help: z
    .string()
    .max(FIELD_GUIDANCE_LIMITS.help)
    .optional()
    .describe('How to fill the field: shown under the input in the editor and given to a model'),
  placeholder: z
    .string()
    .max(FIELD_GUIDANCE_LIMITS.placeholder)
    .optional()
    .describe('An example shown in the empty input; never stored'),
  description: z
    .string()
    .max(FIELD_GUIDANCE_LIMITS.description)
    .optional()
    .describe('What the field means, for agents and API readers'),
  type: z
    .string()
    .describe(
      'Field type: Symbol, Slug, Text, RichText, Integer, Number, Boolean, Date, Location, Seo, JSON, Link, Component or Array (of Symbol, Text, Integer, Number, Date, Link or Component). RichText values are a document tree (`nodeType`/`content`), never HTML; external media is an `embed` node holding structured data',
    ),
  format: z
    .enum(DATE_FORMATS)
    .optional()
    .describe(
      'Date: `date` (YYYY-MM-DD), `datetime` (YYYY-MM-DDThh:mm, optional seconds and offset) or `time` (hh:mm). Absent, any ISO-8601 string',
    ),
  localized: z.boolean(),
  required: z.boolean(),
  position: z.int(),
  unique: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  validations: fieldValidations.optional(),
  rules: z
    .array(fieldRule)
    .max(MAX_FIELD_RULES)
    .optional()
    .describe(
      'Hide or disable the field while a sibling matches; any matching rule applies. Rules read the values being written, on every surface',
    ),
  linkType: z.enum(['Entry', 'Asset']).optional(),
  fields: nestedFields.optional().describe('Component: the nested field definitions'),
  items: z
    .object({
      type: z.enum(ARRAY_ITEM_TYPES),
      format: z.enum(DATE_FORMATS).optional().describe('For a list of Dates'),
      linkType: z.enum(['Entry', 'Asset']).optional(),
      validations: fieldValidations.optional(),
      fields: nestedFields.optional().describe('Array of Component: the shape of every element'),
      variants: z
        .array(
          z.object({
            apiId: z.string().describe('Stored on each element as `_type`'),
            name: z.string(),
            fields: nestedFields,
          }),
        )
        .optional()
        .describe(
          'Array of Component: a blocks field. Each element is one of these shapes, stored as ' +
            '`{ "_type": <variant apiId>, "_key": <stable id, assigned on write>, ...values }`. ' +
            'Declared instead of `fields`, never with it.',
        ),
    })
    .optional()
    .describe('Array: the element definition'),
});

/** The entry form's tabs and field groups: editor-only, never delivered. */
export const contentTypeLayout = z
  .object({
    tabs: z
      .array(
        z.object({
          apiId: z.string().describe('Stable tab id, unique in the layout'),
          name: z.string().max(LAYOUT_LIMITS.name),
          groups: z
            .array(
              z.object({
                name: z
                  .string()
                  .max(LAYOUT_LIMITS.name)
                  .optional()
                  .describe('Shown as the group’s heading; without one, fields in order'),
                fields: z.array(z.string()).describe('Top-level field apiIds, each placed once'),
                collapsed: z.boolean().optional().describe('A named group drawn closed'),
              }),
            )
            .max(LAYOUT_LIMITS.groupsPerTab),
        }),
      )
      .min(1)
      .max(LAYOUT_LIMITS.tabs),
  })
  .describe(
    'How the admin’s entry form arranges the fields into tabs and groups. Editor-only: it changes nothing stored or validated, and Delivery never serves it. Fields it does not place follow on the first tab',
  );

/** A content type's group, description and icon: what the admin files and draws it by. */
export const contentTypeDetails = {
  group: z
    .string()
    .max(CONTENT_TYPE_LIMITS.group)
    .describe('The admin’s sidebar lists types under their group'),
  description: z
    .string()
    .max(CONTENT_TYPE_LIMITS.description)
    .describe('What the type is for, for editors and agents'),
  icon: z
    .string()
    .max(CONTENT_TYPE_LIMITS.icon)
    .describe('A kebab-case icon name the admin draws beside the type, e.g. newspaper'),
  agentInstructions: z
    .string()
    .max(CONTENT_TYPE_LIMITS.agentInstructions)
    .describe('How an agent should write this type’s entries. Plain text, never delivered'),
};

/** Where the admin previews a type's entries on the customer's frontend. Never delivered. */
export const contentTypePreview = z
  .object({
    urlTemplate: z
      .string()
      .max(MAX_PREVIEW_TEMPLATE_LENGTH)
      .describe(
        'An https URL on a plain host (http to localhost or 127.0.0.1 on a local stack only), e.g. ' +
          'https://site.example/__preview?entry={id}#token={token}. Placeholders, each filled ' +
          'URL-encoded: {id}, {token} (required), {locale}, {space}, {environment} and ' +
          '{field:<apiId>} (a Symbol, Slug, Integer, Number or Date field), never in the host',
      ),
  })
  .describe(
    'Where the admin previews the type’s entries on your frontend; a preview link returns it ' +
      'filled as frontendUrl. Editor-only, never delivered',
  );

export const contentType = z.object({
  apiId: z.string(),
  name: z.string(),
  displayField: z.string(),
  fields: z.array(field),
  urlPattern: z
    .string()
    .optional()
    .describe('Where its entries live on the site, e.g. /blog/{slug}'),
  singleton: z
    .literal(true)
    .optional()
    .describe('Holds at most one entry, served at GET …/singletons/:apiId; absent otherwise'),
  group: contentTypeDetails.group.optional(),
  description: contentTypeDetails.description.optional(),
  icon: contentTypeDetails.icon.optional(),
  agentInstructions: contentTypeDetails.agentInstructions.optional(),
  layout: contentTypeLayout.optional(),
  preview: contentTypePreview.optional(),
  version: z.int(),
  status: z.enum(['draft', 'published']),
  warnings: z
    .array(
      z.object({
        field: z.string(),
        entries: z.int().describe('Entries holding a value the new rule refuses'),
        message: z.string(),
      }),
    )
    .optional()
    .describe(
      'On a save only: fields whose new format, dateRange or assetMimeTypes refuses values ' +
        'entries already hold. The save went ahead; each such entry is refused on its next ' +
        'save until the value is changed.',
    ),
});

/** A published content type's place on the site, as Delivery serves it (`GET …/routes`). */
export const deliveredRoute = z.object({
  contentType: z.string().describe('Content type apiId'),
  urlPattern: z
    .string()
    .describe('Where its entries live, e.g. /blog/{slug}: {id}, {locale} or a Slug field apiId'),
});

export const deliveredRouteList = z.object({
  items: z.array(deliveredRoute),
  total: z.int(),
});

export const contentTypeEntryCounts = z.object({
  items: z.array(
    z.object({
      contentType: z.string().describe('Content type apiId'),
      total: z.int().describe('Live entries: draft, changed and published (not the trash)'),
      draft: z.int(),
      changed: z.int().describe('Published, with unpublished edits'),
      published: z.int(),
      archived: z.int().describe('In the trash'),
    }),
  ),
});

export const fieldValuesPage = z.object({
  items: z.array(
    z.object({
      value: z.union([z.string(), z.number(), z.boolean()]),
      count: z.int().describe('Entries (not in the trash) whose current version holds the value'),
    }),
  ),
  nextCursor: z.string().optional().describe('Pass back as cursor for the next page'),
});

/** What still depends on a content type (`GET …/content-types/:apiId/dependents`). */
export const contentTypeDependents = z.object({
  contentType: z.string(),
  entries: z.object({
    live: z.int().describe('Outside the trash'),
    trashed: z.int().describe('In the trash'),
  }),
  linkedFrom: z
    .array(
      z.object({
        contentType: z.string(),
        field: z.string().describe('Path, e.g. body.cta.target'),
      }),
    )
    .describe('Other types’ fields whose links are restricted to it'),
  menus: z
    .array(z.object({ id: z.string(), handle: z.string() }))
    .describe('Menus with an item linking one of its entries'),
  redirects: z
    .array(z.object({ id: z.string(), source: z.string() }))
    .describe('Redirects made by a slug change of one of its entries'),
  urlPattern: z.string().optional().describe('Its URL pattern, served as a site route'),
});

/** A content type deleted at once, or a job deleting its entries first. */
export const contentTypeDeletion = z.object({
  deleted: z.boolean().describe('true when the type is gone; false while the job runs'),
  job: z
    .object({
      id: z.string(),
      action: z.literal('content_type_delete'),
      status: z.string(),
      totalItems: z.int(),
      config: z
        .object({
          contentType: z.string(),
          typeDeletion: z
            .object({ deleted: z.boolean(), reason: z.string().optional() })
            .optional()
            .describe(
              'What became of the type, once decided (the job completed or was stopped); ' +
                'absent until then. Also on `GET …/bulk/jobs/:id`.',
            ),
        })
        .loose()
        .optional(),
    })
    .loose()
    .optional()
    .describe('The bulk job deleting its entries; the type goes when it completes cleanly'),
});
