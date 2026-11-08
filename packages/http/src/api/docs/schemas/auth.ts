import { z } from 'zod';

export const principal = z.object({
  spaceId: z.string().describe('Space id, or `*` for the admin token'),
  kind: z.enum(['cma', 'cda', 'cpa', 'admin', 'user']),
  scopes: z.array(z.string()),
  restricted: z.boolean().optional().describe('The role carries per-content-type grants'),
});

export const spacePrincipal = principal.extend({
  bulkJobs: z
    .array(z.enum(['publish', 'unpublish', 'trash', 'restore', 'purge']))
    .describe('The bulk jobs over entries this role may start in the space'),
});

export const apiKeyCreated = z.object({
  id: z.uuid(),
  kind: z.enum(['cma', 'cda', 'cpa']),
  token: z.string().describe('Shown once — only its SHA-256 hash is stored'),
});
