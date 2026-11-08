/** Max number of checks kept after normalization (policy abuse / CPU). */
export const GUARDRAIL_MAX_CHECKS = 64;

/** Max regex pattern source length (ReDoS / memory mitigation). */
export const GUARDRAIL_MAX_REGEX_PATTERN_LENGTH = 512;

/** Max UTF-8 bytes scanned per input/output slice in `evaluateGuardrails`. */
export const GUARDRAIL_MAX_SCAN_BYTES = 512 * 1024;
