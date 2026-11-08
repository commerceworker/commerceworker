# 0003: Converge on a hexagonal architecture

**Status:** accepted, 2026-11-07

**Decision.** CommerceWorker moves, phase by phase (ROADMAP P1–P2), to a hexagonal layering:
- `domain` depends on nothing, `ports` holds interfaces, and `application` holds use-cases.
- Adapters are bound only at the composition root.
- Every use-case is exposed identically over REST and MCP.

The code is taken from the platform packages, not rewritten.

**Why.** The dependency rule and one-use-case-two-surfaces are what make "an agent can do exactly what an API client can" true by construction rather than by review.

**Consequences.**
- New capabilities land as pure core logic, with storage behind an interface, from now on.
- The agents and skills (`hexagonal-guardian`, `new-use-case`, `new-adapter`) are already in `.claude/`, marked as converging.
- Cloudflare primitives stay the adapters behind every port.
