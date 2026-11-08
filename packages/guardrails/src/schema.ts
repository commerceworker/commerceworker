import { z } from 'zod';
import { GUARDRAIL_MAX_CHECKS, GUARDRAIL_MAX_REGEX_PATTERN_LENGTH } from './constants';

const guardrailCheckSchema = z
  .object({
    type: z.enum(['pii', 'prompt-injection', 'regex']),
    target: z.enum(['input', 'output', 'both']),
    pattern: z.string().max(GUARDRAIL_MAX_REGEX_PATTERN_LENGTH).optional(),
  })
  .superRefine((check, ctx) => {
    if (check.type === 'regex') {
      const p = check.pattern?.trim();
      if (!p) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'regex checks require a non-empty pattern',
          path: ['pattern'],
        });
      }
    }
  });

/** Validated policy object (matches persisted `policy_json` / api-worker usage). */
export const guardrailPolicyRecordSchema = z.object({
  checks: z.array(guardrailCheckSchema).max(GUARDRAIL_MAX_CHECKS),
  defaultAction: z.enum(['block', 'warn', 'log', 'none']),
});

/** Body for `PUT /tenants/:slug/guardrail-policy`. */
export const guardrailPolicyPutBodySchema = z.object({
  policyJson: guardrailPolicyRecordSchema,
});
