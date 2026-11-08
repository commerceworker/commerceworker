---
paths:
  - docs/content/**
  - apps/docs/**
---

# Documentation

- Two doc sets. `docs/*.md` are the maintainer docs: unpublished, indexed by `docs/README.md`; the
  content stack's (`docs/content/*.md`) are embedded into `packages/docs-index/src/generated.ts` for the MCP and HTTP docs tools. The embed is
  gitignored and rebuilt by `pnpm install` and turbo's `generate` task before every check-types,
  test, build and dev; never commit or hand-edit it. `apps/docs`
  (`@commerceworker/docs`, Starlight) is the one public site at `docs.commerceworker.com`: commerce at the root, content management
  under `/content/` (pages in `src/content/content/`, components in `src/components/content/`).
- The site's reference pages render from `@commerceworker/core` (flow nodes, events),
  `@commerceworker/domain` (content node catalog, workflow templates, scopes) and both APIs'
  OpenAPI documents at build time: fix the source, not the rendered page.
  Its theme is generated from `packages/design/src/tokens.ts` (`pnpm sync:theme`). Verify with
  `pnpm docs:build` (fails on broken links).
- A new site page goes in `sidebar` in `apps/docs/astro.config.mjs`; a new maintainer page in
  `docs/README.md`; both get rows in `.claude/skills/docs-sync/references/surface-map.tsv`
  (`docs-page` skill).
- Document only behaviour verified in the code; planned work goes in `ROADMAP.md`, phrased as
  planned.
- Never name a competing platform; say "the surveyed platform" or describe the behaviour.
- Code fences must run: real `@commerceworker/*` package names, real env vars, real commands.
