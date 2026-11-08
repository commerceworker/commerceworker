import { z } from 'zod';

const workflowTrigger = z.object({
  type: z.string().describe('Trigger node type, e.g. trigger.manual or trigger.entry_published'),
  label: z.string().describe('The node catalog’s name for it, e.g. "Submit for review"'),
});

export const workflowList = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      contentTypes: z.array(z.string()).describe('Content type apiIds; empty covers every type'),
      graph: z
        .object({ nodes: z.array(z.unknown()), edges: z.array(z.unknown()) })
        .describe('The DRAFT graph (what the editor shows), not necessarily what runs'),
      steps: z.array(z.unknown()).describe('Legacy steps, derived from the graph'),
      gatesPublish: z.boolean(),
      latestVersion: z.int().nullable().describe('Highest published version; null if never'),
      legacy: z.boolean(),
      updatedAt: z.iso.datetime().nullable(),
      publishedTrigger: workflowTrigger
        .nullable()
        .describe('What starts the latest PUBLISHED version; null when never published'),
      startsAlongside: z
        .array(z.string())
        .nullable()
        .describe(
          'Ids of the other published workflows that start on the same trigger for an ' +
            'overlapping content type (each of them starts too; for trigger.manual the editor ' +
            'chooses). Null when never published',
        ),
    }),
  ),
});
