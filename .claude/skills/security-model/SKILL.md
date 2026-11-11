---
name: security-model
description: CommerceWorker's trust boundaries and what to check at each, for security review of a diff or a design. Covers the signed principal header between the web app and the engine, UCP platform envelopes, MCP and A2A as separate OAuth resources, API tokens and sessions, webhook signing, outbound URLs, secrets and encryption at rest, prompt injection into model nodes, personal data, the public catalog read edge and the supply chain. Preloaded by the security-reviewer agent; use it directly when a change touches auth, roles, signing, secrets, webhooks, external fetches or model prompts.
license: MIT
metadata:
  repo: commerceworker
---

# CommerceWorker security model

CommerceWorker is one dedicated deployment per customer (no multi-tenancy across customers), so the
boundaries that matter are *inside* a deployment: the public internet → the web Worker → the
engine Worker, between people of different roles, between API tokens and integrations of
different scopes, and between UCP platforms. Read
[references/checklist.md](references/checklist.md) for the per-boundary checks; this page is the
map.

## The boundaries

```
browser / API client / MCP / A2A client / UCP platform / channel webhook / Stripe
        │  sessions, cmw_live_ API tokens, OAuth tokens (per resource), HMAC webhooks
        ▼
apps/web  (public; resolves the caller, strips any caller-sent principal header)
        │  x-commerceworker-principal: v1 (person/token),
        │  HMAC over {principal, path, exp} under PRINCIPAL_KEY, TTL 60 s
        │                          apps/storefront  (public; holds NO PRINCIPAL_KEY, no D1, no DOCS)
        │                              │  g1 (cart buyer) / u1 (UCP platform) / guest a1 actor,
        │                              │  the same HMAC under storefrontKey(PRINCIPAL_KEY), TTL 60 s,
        │                              │  to the engine's StorefrontApi entrypoint only
        ▼                              ▼
apps/engine  (reachable only through those service bindings; still verifies)
        │  connectors, Stripe, carriers, webhooks out, A2A push, AI Gateway
        ▼
outside world
```

`apps/delivery`'s catalog entrypoint (`src/catalog/`) is public and read-only and serves only what the
catalog publisher wrote; the Worker deployed at `catalog.<domain>` binds no content stack. `apps/catalog` is reached through its RPC binding (`ProductCatalogRpc`).

## The rules a change must keep

1. **The engine trusts a principal only when it is signed for that path and unexpired.**
   `signPrincipal` / `verifyPrincipal` in `packages/core/src/roles.ts`; the web side signs in
   `apps/web/app/lib/principal.server.ts`, the engine checks in `apps/engine/src/principal.ts`.
   Credentials (passwords, session cookies, API tokens, OAuth tokens) never reach the engine.
2. **A UCP platform is its own envelope.** `signPlatform` / `verifyPlatform` (`u1`) are accepted
   only on `/ucp/*`, never by `verifyPrincipal`, and the reverse. A platform acts only on the
   checkouts and orders it started.
   **The public storefront holds a derived key, never `PRINCIPAL_KEY`.** `storefrontKey` (an HMAC
   of the principal key under its own label) signs everything the storefront sends: the cart
   buyer's `g1`, the platform's `u1`, a guest's `a1` actor and its own `gs1` cookie. The engine
   verifies those under the storefront key only, and `v1` principals and staff `a1` actors under
   `PRINCIPAL_KEY` only (`storefrontKeysOf`, `rpcActor`, `guestActor` in
   `apps/engine/src/principal.ts`), so every envelope kind has exactly one key. The storefront is
   bound to `StorefrontApi` (`StorefrontRpc`), not `EngineApi`: no method without an actor, and
   its `fetch` serves only `/agents/cart-agent/*` and `/ucp/*`. A new method on it must take a
   buyer signed for the cart and admit them only to that cart (`buyerOf`); a new envelope the
   storefront signs goes under the storefront key.
3. **`/mcp`, `/a2a` and `/api/v1` are separate OAuth resources** (RFC 8707, `apps/web/app/lib/oauth.server.ts`):
   a token works only at the endpoint it was granted for. An OAuth grant at `/api/v1` carries its `grant`
   and is never a `person` (no step-up, no confirmation of what a person confirms), as over MCP. A consent grants a role no higher than
   the approver's own. The device grant (`/oauth/device_authorization`, `oauth-device.server.ts`) is
   the same grant minted on approval: only clients registered for it, never a URL client id (no borrowed
   publisher name), the person types the code even from a link, and its return address
   (`DEVICE_REDIRECT`) is refused by the consent page. Check that a change keeps the OAuth 2.1 and
   security-BCP hardening (`docs/architecture.md`, "OAuth conformance"; `oauth-bcp.test.ts`):
   - an issued token is honoured only while its grant's own record exists (`validateToken`'s
     `grantExists`), so a revoked grant stops at once at all three resources, not when the token expires;
   - a client's RFC 7009 revocation at `/oauth/token` drops the app's A2A push configs and audits
     `oauth.grant.revoke` (`via: 'client'`);
   - the consent answer is a `303`, and only the consent page's `form-action` names the validated return
     origin (`CONSENT_HEADER`), never another page's, never an unvalidated URI;
   - `max_age` and `prompt=login` are honoured from the raw URL before any consent is begun, and the
     request the person returns to no longer carries them;
   - registration refuses a `software_statement` (nothing verifies one), more than ten return addresses
     and a non-https `client_uri`, `logo_uri`, `policy_uri` or `tos_uri`;
   - the provider's internal refusal reasons are audited per client and window (`reportRefusals`), never
     with a token, so a client can't flood the trail;
   - PKCE is required of every client, and a missing challenge on a validated request redirects with
     `invalid_request` and `iss`.
4. **Roles are checked on live data.** `atLeast(role, min)`; viewer < approver < operator < admin.
   Separation of duties (`ownOrderRefusal`) applies when the workspace setting is on. MCP and
   assistant actions preview first and run only with a single-use `cfm_` confirmation code bound
   to the person, tool and input.
5. **Inbound webhooks are verified before they are parsed into anything that acts:**
   `verifyWebhook` (timestamped HMAC with a replay tolerance, either of two secrets during a
   rotation), `verifyStripeSignature`, the Shopify HMAC. Comparisons are constant-time.
6. **Outbound URLs are https** (`isWebhookUrl`; plain http only for localhost) for webhooks and A2A
   push. Outbound deliveries are signed.
7. **Secrets at rest are encrypted** with `DATA_KEY` (`encryptSecret` / `decryptSecret`,
   `packages/core/src/encryption.ts`), bound to their row by context, with key rotation. Neither
   `PRINCIPAL_KEY` nor `DATA_KEY` is ever written to disk or logged.
8. **Untrusted text reaches a model only inside a data block** (`dataBlock`, `DATA_RULES`,
   `packages/core/src/untrusted.ts`), and a model's answer is bounded before it acts
   (`boundExtractedLines`, `boundText`, `clampNumber`).
9. **Personal data sent to a model follows the workspace mode** (`redact` or `send`,
   `packages/core/src/redact.ts`), and erasure (`eraseOrderState`) keeps amounts and statuses but
   removes the subject.

## How to review

1. Classify each changed file by boundary (the rules map's trust-boundary row lists the files).
2. For each, run the matching checks in [references/checklist.md](references/checklist.md).
3. Report only what you can tie to a line and a concrete attacker: who they are (anonymous, a
   viewer, another platform, a compromised integration), what they send, and what they get.
   Severity follows impact × preconditions; a finding that needs `PRINCIPAL_KEY` is not a finding.
4. Name the test that would have caught it (`roles.test.ts`, `principal.test.ts`, `mcp.test.ts`,
   `ucp.test.ts`, `injection.test.ts`, `webhooks.test.ts`, `integrations.test.ts`) and whether it
   exists.

Vulnerabilities in the deployed service are reported privately (SECURITY.md); a review finding
in a PR never includes a working exploit against a live deployment.
