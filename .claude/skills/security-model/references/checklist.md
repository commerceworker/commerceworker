# Security checklist, by boundary

Run the sections the diff touches. Each item is a question with the place to look; a "no" is a
candidate finding that still needs a concrete attacker before it is reported.

## Web → engine (principal header)

- Does every new forwarded route set the header with `signPrincipal(key, p, path)` for **its own
  path**, after deleting any copy the caller sent? (`apps/web/app/lib/principal.server.ts`,
  `apps/storefront/app/lib/ucp.server.ts` `ucpFetch`, `principal.server.ts` `setGuestHeader`; the
  storefront signs with `storefrontKey`, never `PRINCIPAL_KEY`.)
- Does every new engine entry point call `verifyPrincipal` (or `verifyPlatform` on `/ucp/*`) with
  the current and previous keys, and refuse on null, rather than reading the header raw?
  `grep -rn "PRINCIPAL_HEADER" apps/engine/src`.
- Is the path the engine verifies the path it was actually called on (not a value from the body)?
- Is each envelope checked under exactly one key? v1 and staff `a1` under `PRINCIPAL_KEY`; `g1`,
  `u1`, guest `a1` and `gs1` under the storefront key (`storefrontKeysOf`). A new storefront
  envelope or method belongs on `StorefrontApi`, with the buyer checked against the cart
  (`buyerOf`; a hosted checkout's also by the cookie secret, `hosted.ts`), and the storefront still binds no D1, `DOCS` or `EngineApi`
  (`scripts/composition-root.test.ts`, `scripts/fleet.test.ts`). The one exception is
  `orderReceipt`, a bearer-token read: check it keeps the hashed, expiring, constant-time token,
  the buyer-safe view only, `no-store` / `no-referrer` / `noindex`, and that mail is triggered by
  the reserved `hosted:` key, not by `meta`.
- UCP identity linking (`apps/engine/src/ucp/identity-link.ts`, `packages/application/src/commerce/ucp-links.ts`,
  `apps/storefront/app/lib/ucp-link.server.ts`, `routes/identity-authorize.tsx`): is it still separate from staff
  OAuth (own issuer, tables, tokens)? Is the client the registered platform (key hash looked up in the engine, the
  `client_id` compared), the return address an exact string registered on the platform, PKCE `S256` required, the code spent once by a
  guarded update, a replayed code or reused or foreign refresh token ending the link, scope only narrowed, and
  `linkedShopper` binding a token to its platform and scope? Does a new `ucp_link_*` column reach export, erasure
  and the sweep, and is any rate-limit key the public `client_id` (it must not be)? does a new route that takes the user token check the platform's envelope first?
- A shopper's sign-in (`apps/engine/src/shopper.ts`, `packages/application/src/commerce/shopper.ts`): does
  every method still take the guest actor signed for `shopper` (and refuse anything else) *and* a secret the
  engine hashes, so a stored hash presented as a secret finds nothing? Is the code still stored only as the
  HMAC under `shopperCodeKey`, the attempt counted before it is compared, the use one guarded write (a race of
  two redemptions mints one session), and the link redeemed only by POST? Does asking still never read orders
  (same answer for any address), pass Turnstile before the engine, keep the per-address cooldown, the failures
  counted across codes and the daily cap, leave the link usable after a lockout, ask before one link replaces a
  signed-in shopper, set the unprefixed cookie only on localhost,
  and send only escaped text? Does a new `shopper_*` column reach export, erasure and the retention sweep?
- A shopper's account (`packages/application/src/commerce/shopper-account.ts`, `apps/engine/src/shopper.ts`,
  the storefront's `account*` and `checkout` routes): does every account method still re-verify the session and
  scope by *its* email, with no id, email or customer from the storefront widening it? Does an order of another
  address, an erased one and an unknown id still answer the same `null` (`placedUnder` before any read)? Do the
  addresses still exclude business customers and company members (`kind = 'consumer'`), and `forgetAddress`
  still delete only a book entry of the session's own email, in one statement? Does the checkout fill still
  read the shopper's details from the engine and take only an id from the form? Do the pages stay `no-store`,
  `same-origin`, noindex and free of a credential in the URL?
- Does anything widen `PRINCIPAL_TTL_MS`, accept a missing `exp`, or fall back to
  `DEV_PRINCIPAL_KEY` outside local dev?
- Does a new socket method re-check the principal or session it needs, rather than trusting the
  one from connect time for an action the role can't take?
- Does any credential (cookie, `cmw_live_` token, OAuth token, password) get forwarded to the
  engine? It must not.

## People, roles, sessions, tokens

- New action: which role does it need, and is `atLeast` checked server-side on live data (not on
  a role from the client or from a cached principal that could be revoked)?
- Approvals: is `ownOrderRefusal` applied where a person decides on an order?
- Sessions: idle and absolute limits (`SESSION_IDLE_MS`, `SESSION_MAX_MS`); is the session id
  kept out of the browser and out of logs?
- API tokens: is a revoked or expired token refused (`livePrincipal`), and does an
  integration-scoped key reach only its channel and flows (`integrations.test.ts`)?
- Sign-in flows (passkeys, TOTP, SSO, SCIM): rate limits and throttles applied
  (`rate-limit.ts`, `throttle.ts`); errors don't reveal whether an account exists.

## MCP, A2A, assistant

- Is a token granted for `/mcp` refused at `/a2a` and the reverse (RFC 8707 resource)?
- Does a new tool run as the caller within their role, and does an action preview first and need
  a `cfm_` code bound to person, tool and input (single use, `CONFIRMATION_TTL_MS`)?
- Does each caller see only their own A2A tasks and push configs?
- A2A push URL: `isWebhookUrl` checked; token sent only to the URL it was registered with.

## UCP (agentic checkout)

- Can platform A read, update, complete or cancel platform B's checkout or order? Every lookup is
  scoped by the calling platform's id.
- Is a platform header refused on `/mcp` and `/a2a`, and a principal header refused on `/ucp/*`?
- Is `complete` idempotent on `Idempotency-Key`, and refused for the same key with another body?
- Is the amount at completion the one `quoteNodes` priced (no client-supplied totals)?
- Are outbound order webhooks signed (RFC 9421, `Content-Digest`)?

## Inbound webhooks and channels

- Is the signature verified on the **raw** body before parsing, with a timestamp tolerance
  (`verifyWebhook`, `verifyStripeSignature`, Shopify HMAC)?
- Is a delivery deduplicated (receipts by delivery or event id) so a replay inside the tolerance
  doesn't act twice?
- Email intake: sender matched to a customer or allowlist, and a passing DMARC, DKIM or SPF
  required; never a webmail domain alone.

## Outbound requests

- Is every user-configurable URL validated (`isWebhookUrl`, `shippingConfigSchema` refusing http
  carriers)? Can a workspace admin point a connector at the deployment's own origin or another
  CommerceWorker Worker and have it act with the engine's authority?
- Are secrets for outbound calls read from encrypted storage at call time, not copied into order
  state, step output or logs (step outputs are persisted)?

## Secrets and data at rest

- New stored secret: encrypted with `encryptSecret` under the right `secretContext`, and readable
  through a rotation (`sealedWithCurrent`)?
- Does anything log, return in an API response, or put in an error message a secret, a token, a
  session id, or a full card or bank detail?
- New column with personal data: covered by erasure (`eraseOrderState`, subjects) and retention?
- New wrangler `vars`: no secrets there (secrets are set by CI from the GitHub environment).

## Models and untrusted input

- Does new text from a customer, email, document, channel payload or web page reach a prompt
  only through `dataBlock`, under `DATA_RULES`?
- Is the model's answer bounded before it changes anything (`boundExtractedLines`, `clampNumber`,
  allow-listed routes)? `apps/engine/tests/injection.test.ts` gets a case for a new model node.
- Is personal data sent to the model only as the workspace's mode allows (`modelOrder`,
  `modelContext`)?

## Web app surface

- CSP (`csp.ts`) unchanged or tightened; no new inline script or `unsafe-*`.
- State-changing routes check origin (`origin.ts`) and the session; no GET with side effects.
- User content rendered as text, never as HTML.
- Redirects go only to same-origin paths (`next-path.ts`).

## Catalog and edge

- delivery's catalog entrypoint stays read-only: no binding that can write, no route that reaches the catalog's
  RPC write methods.
- Cache keys are the canonical URL, so a query string or header can't poison another product's
  entry.

## Supply chain and CI

- New dependency: needed, maintained, and does `pnpm audit --prod --audit-level high` stay clean?
- Workflows: actions pinned by full SHA, `permissions` minimal, no secrets in `pull_request` jobs
  from forks, no untrusted input interpolated into `run:` (`${{ github.event.* }}`).
- Does a hosted checkout's payment use the buyer's own instrument? Never on-account, never the
  customer's credit or saved cards, unless the operator explicitly allows it
  (`apps/engine/src/checkout/complete.ts`; `completeHosted` in `hosted.ts` completes only in test mode, with a
  test authorizer that holds and takes nothing; a card is taken by `payHosted`). Taking a card (S3), done:
  - [x] a live hosted authorizer returns the buyer's own `payment.intentId` for the order to adopt, and a
    live completion without one is refused (`holdsNothingOnlyInTestMode` throws; `holdCard` returns the
    intent of a PaymentIntent made from the buyer's confirmation token, `paymentIntents.confirmWithToken`
    having no customer, saved-method or `off_session` parameter);
  - [x] a flow that carries the order on account (`commerce.invoice` with `onAccount`, `commerce.charge`) is
    refused, as one that doesn't authorize a card is (`checkoutFlowProblem`);
  - [x] the flow is loaded and re-checked at completion, not trusted from when the setting was saved
    (`payHosted`, `confirmHostedPayment` and the sweep via `flowFor`; `completeHosted`; UCP's
    `completeCheckout`);
  - [x] completion is for the version and total the buyer saw (`payHosted`'s `version` and `total`), so an
    order is never placed at a price they were not shown, and the amount charged is the server's quote,
    never the page's;
  - [x] the amount, the PaymentIntent's `checkout_id` and `requires_capture` are checked again before an
    authenticated payment becomes an order (`settle`), and the order's authorize node checks the intent
    once more (`adoptProblem`);
  - [x] card testing: five attempts per session (`HOSTED_PAY_ATTEMPTS`), `PAY_LIMIT` per cookie and per
    address, Turnstile (`checkout_pay`) before the engine is asked, and Radar left on (an owner step);
  - [x] a hold an unfulfilled UCP or hosted order never took is released once by its OrderAgent
    (`releaseUnusedHold`), a session whose order exists is never reopened over it (`completeFromOrder`),
    and a session the sweep can't settle is let go of after `MAX_FAILED_SWEEPS`;
  - [x] a hosted order's authorize step takes only the adopted intent, and `adoptProblem` checks its
    `checkout_id`; `meta.hosted` and `hosted:` keys can't be set from outside;
  - [x] Stripe.js, its frames and its API are in the policy of a checkout page that takes a card and no
    other page (`STRIPE_HEADER`), and the browser's payment request is allowed there alone.
