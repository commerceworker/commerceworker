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
   bound to `StorefrontApi` (`StorefrontRpc`), not `EngineApi`: no method without an actor (bar the one exception below), and
   its `fetch` serves only `/agents/cart-agent/*` and `/ucp/*`. A new method on it must take a
   buyer signed for the cart and admit them only to that cart (`buyerOf`); a new envelope the
   storefront signs goes under the storefront key. A hosted checkout's buyer is named twice, because
   the storefront's key alone must never mint one: by a cookie secret the engine minted when the
   one-time start link was redeemed (the storefront carries it; the engine stores and compares only
   its SHA-256, the session's owner `hosted:<hash>`, in constant time, so a stored owner is no
   credential; the link's own `hosted-start:<hash>` is a different owner, so a link is never a
   cookie) and by a guest `a1` actor signed for `checkout:<id>` (`apps/engine/src/checkout/hosted.ts`
   `buyerOf`). A UCP platform's session, or anyone else's, is `null`; with the `storefront` setting
   off every method refuses; a buyer's patch is strict, so no price, owner or status can be set, and a buyer is shown an explicit
   projection (`hostedView`), never the stored session. A start link redeems only by POST; a GET
   spends nothing. The hosted checkout pages (start, page, placed) send
   `Referrer-Policy: same-origin`, never `no-referrer`: under `no-referrer` a browser posts their own forms with
   `Origin: null`, which React Router and the Worker's `crossOrigin` refuse, and `same-origin` still sends no
   Referer to another origin, so the link's token can't leak. (The order receipt has no form, so it keeps `no-referrer`.) A hosted buyer pays with their own instrument: never on-account, never the
   customer's credit or saved cards, unless the operator explicitly allows it. `completeCheckout`
   completes only in test mode (`PAYMENTS_MODE` `mock`: a payment is recorded, none is taken), with the
   same cookie-secret and actor checks as every call; with real payments it completes nothing. With them `payCheckout` takes a card: Stripe's confirmation
   token from the buyer's browser becomes a manual-capture PaymentIntent for the *quote's* total (no customer,
   saved method or `off_session`), which the order adopts; `confirmCheckoutPayment` finishes one the bank
   authenticated; the engine's sweep settles holds nothing finished (`apps/engine/src/checkout/hosted.ts`).
   Each completes only the version and total the buyer's page showed (else `changed`, no order), and
   re-checks the flow it loads with `checkoutFlowProblem` (no card authorization, or an order carried on
   account, is refused); a payment-less authorizer throws outside test mode.
   **A shopper's sign-in follows the same rule: the engine owns every credential, the storefront presents a
   secret it never mints.** A shopper is a verified email address (never a `customers` row; guest checkout
   stays on). Redeeming an emailed code or link makes the engine mint a 32-byte session secret and keep only its
   SHA-256 (`shopper_sessions`); the storefront carries it in `__Host-cw_shop` (`HttpOnly`, `Secure`,
   `SameSite=Lax`) and presents it with each call; every one of `startShopperSignIn`, `redeemShopperCode`,
   `redeemShopperLink`, `shopper` and `shopperSignOut` also takes a guest `a1` actor signed for `shopper` as
   `guest:shopper` (`apps/engine/src/shopper.ts` `fromStorefront`), so the storefront key alone mints no
   shopper, a secret alone reaches no method, an actor signed for a cart or a checkout opens none of it, and a
   stored hash presented as the secret matches nothing (`apps/engine/tests/shopper.test.ts`). The code is
   stored only as an HMAC under `shopperCodeKey(PRINCIPAL_KEY)`, which the storefront never holds; it lives ten
   minutes, is capped at five counted tries (counted before they are compared, in constant time) and used once
   by one guarded `UPDATE ... RETURNING`, as the link is, which opens only by POST and still works after the
   code is locked; failures count per address across codes (never five a code), the fifth locks the address out
   of new codes for fifteen minutes from its last try, and at most twenty codes go to an address a day; the
   confirm page names the address (masked) and asks before replacing a signed-in shopper (login CSRF); the
   cookie is `__Host-` everywhere but localhost, and no session is set over plain http elsewhere. Asking never reads orders, so its answer can't show whether an
   address has any; it is Turnstile-checked (`shop_sign_in`) and budgeted per address and per client. Erasure
   and export of the address cover `shopper_*` (ending every session), and retention sweeps them.
   REST exception, once: the settings routes `POST /api/v1/ucp/settings` and
   `POST /api/v1/storefront/settings` accept an admin API token with no person-confirm, though their
   tools are in `PERSON_CONFIRMS_TOOLS` (over MCP, A2A and the app a person confirms on a card). They
   are hand-written REST like the rest of the admin routes: the call is the admin's own deliberate
   write (an admin token can already create integrations and revoke platforms the same way), and each is
   audited (`ucp.settings`, `checkout.settings`) with the token as actor. `runOperation` (the generic
   REST path) does refuse a token a person-confirmed tool; keep any new settings route consistent with
   `set_ucp_settings`, whichever path it takes.
   **The other exception is `orderReceipt`:** a bearer-token read with no signed buyer actor, guarded by
   an order-view token the engine minted (random, stored only as a hash, expiring in 30 days, compared
   in constant time over the order's live hashes, revoked by erasure), answering only the buyer-safe
   `BuyerOrderView` (`null` alike for unknown, wrong and expired); its page is `no-store`,
   `no-referrer` and `noindex`. Don't add another such method without the same guards. The mail that
   carries the token is triggered only by the engine's own `hosted:` idempotency key (reserved), never
   by anything a caller sets in `meta`.
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
