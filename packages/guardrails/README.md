# @commerceworker/guardrails

Tenant-configurable **content checks** for **merchant hook** paths (`before_request` / `after_response` in `apps/api-worker` `hookMiddleware`). Policies are stored in the control plane (`tenant_guardrail_policies.policy_json`) and loaded by api-worker via `GET /internal/guardrail-policy/:slug`.

## Policy JSON shape

```json
{
  "checks": [
    { "type": "pii", "target": "input" },
    { "type": "prompt-injection", "target": "both" },
    { "type": "regex", "target": "output", "pattern": "SECRET_KEY" }
  ],
  "defaultAction": "block"
}
```

- **`type`**: `pii` | `prompt-injection` | `regex`
- **`target`**: `input` | `output` | `both` — whether to scan the JSON-serialized request body, response body, or both
- **`defaultAction`**: `block` | `warn` | `log` | `none`
  - **`block`**: request fails with `400` (input) or response replaced with `502` (output)
  - **`warn`** / **`log`**: request continues; violations are recorded via **function-activation telemetry** (`errorMessage` prefix `guardrail_warn:` / `guardrail_log:`)
  - **`none`**: violations do not block or emit telemetry

`regex` checks require a non-empty **`pattern`** (see limits below).

## Limits (abuse / CPU)

| Constant | Default | Purpose |
|----------|---------|---------|
| `GUARDRAIL_MAX_CHECKS` | 64 | Max checks kept after parsing |
| `GUARDRAIL_MAX_REGEX_PATTERN_LENGTH` | 512 | Max regex source length |
| `GUARDRAIL_MAX_SCAN_BYTES` | 512 KiB | Max UTF-8 bytes scanned per input/output slice in `evaluateGuardrails` |

Custom regex can still exhibit **ReDoS**-style pathological behavior; keep patterns simple and test in staging.

## API

- **`parsePolicyJson(raw: unknown)`** — accepts JSON string or parsed object (e.g. control-plane jsonb). Invalid fragments are dropped.
- **`evaluateGuardrails(policy, { inputText?, outputText? })`** — runs checks on truncated text.
- **`guardrailPolicyRecordSchema` / `guardrailPolicyPutBodySchema`** (Zod) — used by control-worker for `PUT /tenants/:slug/guardrail-policy`.

## See also

- [Control DB ERD — `tenant_guardrail_policies`](../../docs/architecture/erd-control.md)
- [Guardrails architecture note](../../docs/architecture/guardrails.md)
