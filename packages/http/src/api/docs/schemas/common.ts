import { z } from 'zod';

/**
 * OpenAPI payload schemas for the documented routes, one file per area. These describe the wire
 * shapes (zod 4 → JSON Schema via hono-openapi's resolver); they are not used
 * for runtime validation, so they stay deliberately permissive where the
 * domain model is dynamic (localized fields are `locale → value` maps whose
 * value type depends on the content type).
 */

export const errorResponse = z
  .object({
    error: z.object({
      code: z.string().describe('Machine-readable error code'),
      message: z.string(),
      details: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'What a 409 conflicts with, when it says: e.g. `variantsInUse` / `fieldsInUse`, each location with the entries still holding it',
        ),
    }),
  })
  .describe('Error envelope');
