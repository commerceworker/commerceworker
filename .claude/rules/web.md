---
paths:
  - apps/studio/**
  - packages/ui/**
  - packages/design/**
---

# apps/studio (the admin: React Router 8 SSR + human auth)

- Read `PRODUCT.md` and `DESIGN.md` ("Ledger", shared through `packages/design` and
  `packages/ui`) before designing or restyling anything. Compose the existing tokens and
  components; never paste stock shadcn defaults. DESIGN.md's named rules and do's and don'ts are
  binding.
- The web Worker fronts the api over the `API` service binding (`app/lib/gateway.server.ts`): it
  strips a caller-sent `x-cw-principal` and signs one for a same-origin request with a live
  session. Changes there, to sign-in (`auth`, `passkeys`, `sso`, `scim`, `two-factor`, `setup`) or
  to `csp.ts`, `origin.ts`, `next-path.ts` get a `security-reviewer` pass.
- No business rules in screens: anything an admin can do already exists as an api/MCP use-case.
- Tests: server and library code → `apps/studio/tests/*.test.ts` (vitest project `node`); screens and
  components → `apps/studio/tests/*.test.tsx` (project `dom`, jsdom + Testing Library); a new or
  changed route, flow or dialog → `apps/studio/e2e/*.spec.ts` (Playwright: WebKit device projects,
  Desktop Chrome for the CMS specs and the axe sweep in `accessibility.spec.ts`). See the `testing`
  skill.
- Accessible names: a Radix `Checkbox`/`Switch` inside a wrapping `<label>` gets no accessible name
  in a real browser; give it `aria-label`. jsdom can't detect this; only the axe sweep can.
- A "flaky" e2e is a real bug (usually a race or a missing await on UI state) until the trace proves
  otherwise. Never add retries or `waitForTimeout` to make it pass.
- A token change in `app/app.css` is mirrored in `packages/design/src/tokens.ts`, then
  `pnpm sync:theme` (the design test holds them together).
- Review UI changes with the `admin-ui-reviewer` agent before committing.
