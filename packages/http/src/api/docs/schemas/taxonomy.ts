import { z } from 'zod';

// --- taxonomy -----------------------------------------------------------------

const termUsage = z
  .object({
    count: z.int().describe('Published entries carrying the term'),
    byContentType: z.record(z.string(), z.int()).describe('The same count per content type'),
  })
  .describe('Published usage, kept as entries publish, unpublish, archive and trash');

const termFields = {
  slug: z.string().describe('Unique among the environment’s tags, or within the scheme'),
  description: z.string().nullable(),
  labels: z
    .record(z.string(), z.string())
    .describe('Labels in the space’s other locales; the term’s own label is the default’s'),
};

export const tag = z.object({ id: z.string(), name: z.string(), ...termFields });
export const tagWithUsage = tag.extend({ usage: termUsage });
export const tagList = z.object({ items: z.array(tagWithUsage) });

export const concept = z.object({
  id: z.string(),
  schemeId: z.string(),
  prefLabel: z.string(),
  broaderId: z.string().nullable(),
  ...termFields,
});
export const conceptWithUsage = concept.extend({ usage: termUsage });
export const conceptList = z.object({ items: z.array(conceptWithUsage) });

export const taxonomyRepair = z.object({
  slugsAssigned: z.int().describe('Terms that had no slug and now have one'),
});

export const deliveredTag = z.object({
  id: z.string(),
  slug: z.string(),
  label: z.string().describe('In the requested locale (with fallbacks), or the default’s'),
  labels: z
    .record(z.string(), z.string())
    .optional()
    .describe('Every locale’s label; only without ?locale='),
  description: z.string().nullable(),
  count: z.int().describe('Published entries carrying it (of content_type, when given)'),
  countsByContentType: z.record(z.string(), z.int()),
});
export const deliveredConcept = deliveredTag.extend({
  schemeId: z.string(),
  broaderId: z.string().nullable(),
});
export const deliveredTagList = z.object({ items: z.array(deliveredTag) });
export const deliveredConceptList = z.object({ items: z.array(deliveredConcept) });
