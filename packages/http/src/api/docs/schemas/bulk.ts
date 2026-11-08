import { z } from 'zod';

/** A bulk field edit job as it starts (follow it at GET /bulk/jobs/{id}). */
export const setFieldsJob = z.looseObject({
  id: z.string(),
  action: z.literal('set_fields'),
  status: z.enum(['running', 'completed', 'cancelled']),
  totalItems: z.int(),
  totalChunks: z.int(),
  completedChunks: z.int(),
  succeeded: z.int(),
  failed: z.int(),
  config: z
    .looseObject({
      contentTypeApiId: z.string(),
      fieldNames: z
        .array(z.string())
        .describe('The fields it sets; their values are not read back'),
    })
    .describe('The type and the fields the job sets'),
});
