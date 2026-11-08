import { z } from 'zod';

// --- redirects ----------------------------------------------------------------

const redirectStatus = z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]);

export const redirect = z.object({
  id: z.uuid(),
  source: z
    .string()
    .describe('A path: exact, or a pattern of [param] segments and a trailing [...splat]'),
  destination: z.string().describe('A path or an https:// URL; may use the source’s [captures]'),
  status: redirectStatus,
  locale: z.string().optional().describe('Applies to this locale only; absent, to every locale'),
  enabled: z.boolean(),
  note: z.string().optional(),
  origin: z.enum(['manual', 'import', 'slug']),
  entryId: z.string().optional().describe('The entry whose slug change made it'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const redirectChain = z.object({
  id: z.string().describe('The redirect whose destination is redirected again'),
  via: z.array(z.string()).describe('The hops after it, in order'),
  destination: z.string().describe('Where the chain ends: what it can point at directly'),
});

export const redirectPage = z.object({
  items: z.array(redirect),
  nextCursor: z.string().optional(),
});

export const redirectWrite = z.object({
  redirect,
  chains: z.array(redirectChain).describe('Chains it takes part in (allowed; collapsible)'),
});

export const redirectMatch = z.object({
  redirect,
  status: redirectStatus,
  location: z
    .string()
    .describe('The destination with captures filled in (and the query, when it has none)'),
});

export const redirectAnalysis = z.object({
  loops: z.array(z.array(z.string())).describe('Cycles, as the ids around each'),
  chains: z.array(redirectChain),
  duplicates: z.array(z.object({ key: z.string(), ids: z.array(z.string()) })),
  count: z.int(),
  max: z.int(),
});

export const redirectImportReport = z.object({
  dryRun: z.boolean(),
  created: z.int(),
  updated: z.int(),
  unchanged: z.int(),
  chains: z.array(redirectChain),
});

export const redirectCollapse = z.object({
  updated: z.int().describe('Redirects pointed straight at where their chain ended'),
});

export const deliveredRedirect = z.object({
  id: z.uuid(),
  source: z.string(),
  destination: z.string(),
  status: redirectStatus,
  locale: z.string().optional(),
});

export const deliveredRedirectList = z.object({
  items: z.array(deliveredRedirect),
  total: z.int(),
});

export const deliveredRedirectMatch = z.object({
  redirect: deliveredRedirect,
  status: redirectStatus,
  location: z.string(),
});
