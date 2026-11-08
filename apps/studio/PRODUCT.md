# Product

## Register

product

## Users

Content editors first: writers, marketers, and content ops people who live in entries,
assets, releases, and publishing workflows for hours at a stretch. They are not
necessarily technical; they need the state machine (draft → published, releases,
workflows, branch merges) to feel legible without reading docs.

Developers second: they model content types, wire webhooks and functions, connect
API keys and MCP clients, and inspect delivery behavior. They visit the same admin
but in shorter, tool-shaped sessions.

Context: a browser tab that stays open all day, usually alongside the site or app
whose content is being edited. It also runs on an iPad and an iPhone, in a tab or added
to the Home Screen as its own app: a phone is for keeping up and deciding (the overview,
content, releases, approvals and quick edits through a bottom tab bar); the full editor
and building workflows are for wider screens. The theme follows the system until the
reader picks light or dark.

## Product Purpose

The admin UI for CommerceWorker, an API-first, AI-agentic-first headless CMS. It is
the human surface over the same application use-cases the HTTP API and MCP tools
call: content modeling, entry editing (rich text via TipTap), publishing and
releases, assets, taxonomy, workflows, webhooks, functions, AI generation and
enrichment review. Success looks like an editor shipping content changes quickly
and confidently, and trusting what the AI agents did on their behalf.

## Brand Personality

Calm, precise, fast. Quiet confidence: dense but legible, keyboard-friendly,
nothing decorative. The interface should feel like a well-made tool that gets out
of the way; the content being edited is the star, not the chrome around it.

## Anti-references

- Legacy enterprise CMS admin: crowded chrome, nested settings mazes, visual noise.
- SaaS-gradient startup aesthetic: gradient heroes, glassmorphism, marketing energy
  leaking into a work tool.
- The unthemed gray shadcn default that reads as a template rather than a product.
  The admin's look is Ledger (DESIGN.md), a named system with its own status tokens,
  shared across the owner's products through `packages/design` and `packages/ui`.
- AI-everything clutter: sparkle icons and "AI" buttons on every surface. AI is
  woven into flows (generation dialogs, enrichment review, assist panel), never
  shouting for attention.

## Design Principles

1. **Content is the interface.** Chrome recedes; the entry, the asset, the diff is
   what gets visual weight. Density serves reading, never decoration.
2. **State is always legible.** Draft/changed/published, release membership,
   workflow stage, agent proposals: an editor should never wonder what will happen
   when they hit publish.
3. **AI earns trust through review.** Agent output arrives as reviewable proposals
   with clear provenance, not silent mutations. Human-in-the-loop is the default
   posture of the UI.
4. **Fast hands, fast feedback.** Keyboard-friendly flows, optimistic-feeling
   interactions, no spinner where a skeleton or instant response is possible.
5. **One system, no snowflakes.** New surfaces compose the existing token/component
   system (Ledger: shadcn's base-maia preset on the project's tokens, see DESIGN.md);
   a screen should never look like it came from a different product.

## Accessibility & Inclusion

WCAG 2.1 AA: body text ≥4.5:1 against its background (including the dark theme and
muted/placeholder text), full keyboard navigation, visible focus states, and
`prefers-reduced-motion` alternatives for every animation. Status must never be
conveyed by color alone (badges pair color with text).
