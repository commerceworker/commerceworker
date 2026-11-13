# CodeQL triage

The first triage of CodeQL's results on the merge-queue analysis of PR 118 (52 results, none triaged
before). Line numbers are those the analysis reported; the fixed ones moved. Each result is one of:

- **Fixed**: changed in code, with a test. The alert closes when the next analysis of `main` no
  longer reports it.
- **Dismiss**: not a vulnerability here. Dismiss it on GitHub with the reason given (`false_positive`
  or `won't fix`) and the one-line comment.
- **Open**: real, not fixed yet.

Read the alerts with `gh api 'repos/commerceworker/commerceworker/code-scanning/alerts?ref=<ref>&per_page=100'`.
Until a run of `main` itself reports, `<ref>` is the merge-queue branch of the analysis. The default
query returns nothing for `refs/heads/main` until then.

## Fixed in code

| Alert | Rule | File | Change |
|---|---|---|---|
| 37, 38 | `js/biased-cryptographic-random` | `apps/studio/app/lib/totp.ts:123`, `apps/web/app/lib/totp.ts:123` | Recovery codes draw by rejection sampling (`randomRecoveryChars`): a byte past the last whole multiple of the 31-character alphabet is redrawn, not folded onto the first characters. |
| 4, 15, 26 | `js/polynomial-redos` | `packages/adapters/src/email-cf/index.ts:84`, `packages/domain/src/auth/team.ts:132`, `packages/security/src/credentials.ts:158` | The email-shape check (`isEmail`, and the sender's `isAddress`) is a few `indexOf` calls, not a backtracking pattern. Same accepted and refused strings. |
| 2 | `js/polynomial-redos` | `apps/media/src/serve.ts:105` | The `Range` header is split at its dash by hand (`parseByteRange`). |
| 9 | `js/polynomial-redos` | `packages/core/src/intake.ts:53` | `splitAddress` takes the part inside `<…>` with `lastIndexOf` and `indexOf`. |
| 10, 30, 34 | `js/polynomial-redos`, `js/double-escaping`, `js/incomplete-multi-character-sanitization` | `packages/core/src/intake.ts:158` | `htmlToText` is a single scan: script and style go whole, every other tag goes, and entities decode in one pass (`&amp;lt;` is now `&lt;`, not `<`). |
| 5 | `js/polynomial-redos` | `packages/application/src/ai-prompt.ts:40` | The user-content delimiter pattern no longer has two adjacent `\s*`. |
| 3 | `js/polynomial-redos` | `packages/adapters/src/ai-workers/json.ts:9` | The fence pattern drops a `\s*` the next line's `trim()` made redundant. |
| 8 | `js/polynomial-redos` | `packages/core/src/credentials.ts:54` | PEM private keys are found by a bounded scan (`maskPrivateKeys`). A BEGIN with no END now masks to the end of the text instead of leaving the key body in the clear. |
| 16 | `js/polynomial-redos` | `packages/domain/src/auth/oauth.ts:158` | `parseUri` refuses a line break up front (never valid in a URI, and the only input the pattern could fail on). |
| 21 | `js/polynomial-redos` | `packages/domain/src/rich-text/rich-text-diff.ts:115` | Whitespace runs in a table cell fold with one `\s+` pass. |
| 22 | `js/polynomial-redos` | `packages/domain/src/seo/seo.ts:141` | The query or fragment is cut by position (`pathEnd`), not by `[?#].*$`. |
| 12 | `js/polynomial-redos` | `packages/core/src/redact.ts:55` | `EMAIL` and `PHONE` are single-pass scanners (`maskEmails`, `maskPhones`) that mask exactly what the old patterns did, held to them by an oracle test over 20,000 random strings; a 100k-character local part is masked whole. The same email pattern in `packages/guardrails` and its quadratic `system:` injection check were rewritten the same way. |

## Dismiss

Dismiss with `false_positive` unless the reason says "won't fix".

| Alert | Rule | File:line | Reason |
|---|---|---|---|
| 27 | `js/insufficient-password-hash` | `packages/http/src/api/oauth/routes.ts:171` | An HMAC-SHA-256 that binds a consent form to its person and parameters, keyed by a server secret. No password is hashed. |
| 28 | `js/insufficient-password-hash` | `packages/http/test/mcp/api-key-tools.test.ts:26` | A test hasher for API-key lookups (keys are 256-bit random, not passwords). |
| 1 | `js/polynomial-redos` | `apps/engine/src/ucp/identity-link.ts:28` | Trailing-slash trim of the operator's own `STOREFRONT_ORIGIN`; not attacker input (won't fix). |
| 6 | `js/polynomial-redos` | `packages/cli/src/session.ts:37` | Trailing-slash trim of the URL the user typed into their own CLI (won't fix). |
| 13 | `js/polynomial-redos` | `packages/core/src/shopper.ts:108` | Trailing-slash trim of the deployment's origin (won't fix). |
| 14 | `js/polynomial-redos` | `packages/core/src/ucp/identity-linking.ts:192` | Trailing-slash trim of the deployment's origin (won't fix). |
| 23 | `js/polynomial-redos` | `packages/sdk/catalog/src/urls.ts:50` | Trailing-slash trim of the origin the SDK caller passes in their own code (won't fix). |
| 24 | `js/polynomial-redos` | `packages/sdk/commerce/src/client.ts:120` | Same: the SDK caller's own `baseUrl` (won't fix). |
| 18, 25 | `js/polynomial-redos` | `packages/domain/src/redirect/redirect.ts:82`, `packages/sdk/core/src/redirects.ts:47` | The path is collapsed with `\/{2,}` first, so the trailing-slash pattern sees at most one slash. |
| 17 | `js/polynomial-redos` | `packages/domain/src/entry/position.ts:82` | Trims `-` from a position key this module generated; not external input. |
| 19, 20 | `js/polynomial-redos` | `packages/domain/src/redirect/redirect.ts:203`, `:481` | The `[…]` placeholder pattern runs on a destination capped at 2,048 characters (`MAX_REDIRECT_LENGTH`) and written by an admin (won't fix). |
| 35, 36 | `js/biased-cryptographic-random` | `apps/engine/src/plugin-cases.ts:57`, `:58` | Varies the id, title and date of a sample order so a draft rule can't key on them. Not a secret, and the bias is below one part in 40,000. |
| 40, 41 | `js/client-side-request-forgery` | `apps/studio/app/cms/lib/management.ts:1472`, `:2448` | The request root is `''`: same-origin paths on the studio's own API, carrying the signed-in user's session. No other host is reachable (won't fix). |
| 47, 48, 49, 50 | `js/remote-property-injection` | `apps/studio/app/cms/components/AssetDetailSheet.tsx:270`, `apps/studio/app/cms/lib/management.ts:1890`, `:2075`, `:2160` | A computed key in an object literal defines an own property, so a locale of `__proto__` can't reach a prototype. The locale is also one the space defines. |
| 42, 43 | `js/file-access-to-http` | `apps/web/scripts/seed-live.ts:34`, `:42` | A local developer script that posts to the origin its operator passed. |
| 51 | `js/http-to-file-access` | `packages/sdk/codegen/src/cli.ts:95` | The CLI writes where its own `--out` flag says; the operator chose the path (won't fix). |
| 44 | `js/file-system-race` | `packages/cli/src/credentials.ts:159` | The lockfile protocol itself: it reads the file to compare its own nonce before removing it, and `wx` creation is the atomic step. |
| 46 | `js/file-system-race` | `scripts/fleet.ts:2721` | A CI script that merges into a file it just chose; no other writer. |
| 45 | `js/file-system-race` | `scripts/turbo-cache.test.ts:62` | Test code on a temporary copy. |
| 29, 33 | `js/bad-tag-filter`, `js/incomplete-multi-character-sanitization` | `apps/storefront/tests/account-pages.test.ts:267`, `:266` | A test strips React's `<!-- -->` markers from rendered output before asserting. Nothing is served. |
| 31, 32 | `js/double-escaping` | `packages/http/test/api/cli.test.ts:116`, `packages/http/test/api/oauth-routes.test.ts:119` | Test helpers reading hidden inputs from the page the server just rendered. |
| 39 | `js/incomplete-hostname-regexp` | `packages/domain/test/rich-text-from-html.test.ts:431` | An unescaped `.` in a test's expected string for a known fixture. |
| 52 | `js/regex/missing-regexp-anchor` | `apps/storefront/e2e/checkout.spec.ts:168` | A test collects requests to `stripe.com`; it asserts, it doesn't allow. |
| 53 | `js/regex/missing-regexp-anchor` | `apps/studio/tests/plugins.test.tsx:330` | A test finds text on a rendered page. |
| 54 | `js/regex/missing-regexp-anchor` | `scripts/playwright-image.test.ts:20` | A pattern over `ci.yml` text, not a URL check. |

`gh api -X PATCH repos/commerceworker/commerceworker/code-scanning/alerts/<n> -f state=dismissed -f dismissed_reason=<false positive|won't fix> -f dismissed_comment='<reason>'`
dismisses one. The owner runs these; no change in this repository does.

## Owner steps

- Dismiss the alerts above on GitHub.
- Make the CodeQL check required in the `main` ruleset. It gates no merge today (`docs/deploy.md`),
  so a new alert only shows in the Security tab. Not changed here.
- After the next analysis of `main`, confirm every fixed alert closed and only the dismissals below remain.
