import { z } from 'zod';

export const spaceRef = z.object({ id: z.string(), name: z.string() });

export const createdSpace = spaceRef.extend({
  starter: z.enum(['empty', 'sample', 'enterprise']),
  installed: z
    .object({
      contentTypes: z.number().int(),
      entries: z.number().int(),
      assets: z.number().int(),
      tags: z.number().int(),
      concepts: z.number().int(),
      releases: z.number().int(),
    })
    .optional()
    .describe('What the sample starter holds once installed (absent for `empty`)'),
  installing: z
    .object({
      install: z.string().describe('Follow it at GET …/starter-installs/{install}'),
      jobId: z.string().describe("The first phase's bulk job"),
      steps: z.int().describe('How many phases the install runs, one job each'),
    })
    .optional()
    .describe('A background install that has started (the `enterprise` starter only)'),
});

export const starterList = z.object({
  items: z.array(
    z.object({
      id: z.enum(['empty', 'sample', 'enterprise']),
      title: z.string(),
      description: z.string(),
      background: z
        .boolean()
        .describe('Installs in the background after the space is created, not before it returns'),
    }),
  ),
});

export const starterInstall = z.object({
  install: z.string(),
  starter: z.string(),
  step: z.int().describe('The phase running now, or the last to run (1-based)'),
  steps: z.int(),
  phase: z.string(),
  title: z.string(),
  jobId: z.string().describe("That phase's bulk job (its report: GET …/bulk/jobs/{id}/report)"),
  status: z.enum(['running', 'completed', 'failed']),
  failures: z
    .array(z.object({ id: z.string(), error: z.string(), name: z.string().optional() }))
    .optional()
    .describe('What failed in the phase that stopped the install'),
});
