---
paths:
  - packages/sdk/**
---

# Public SDK (`packages/sdk/*`)

- These ship to customers' browsers, apps and Workers as one npm package, `@commerceworker/sdk`
  (`packages/sdk/sdk`), which bundles the private workspace packages (`@commerceworker/sdk-core`,
  `sdk-web`, `sdk-vue`, `sdk-react-native`, `sdk-edge`, `sdk-management`, `sdk-codegen`,
  `sdk-rich-text`) and the CLI, one subpath each. A new workspace SDK module adds a subpath there
  (`package.json` exports and publishConfig, `src/`, `tsup.config.ts`, `scripts/types.ts`, the
  subpath test). They import only
  other `@commerceworker/sdk-*` packages (framework SDKs build on `sdk-core`), never domain, ports,
  application, http, platform or adapters. Types mirroring server shapes are redeclared here, not
  imported.
- Public exports are an API contract: don't rename or remove an export, or narrow a parameter type,
  without calling it out as a breaking change.
- Keep `sdk-core`, `sdk-edge` and `sdk-rich-text` runtime-agnostic (`fetch`, no `node:*`), so they run in browsers
  and on workerd.
- A new management route in `packages/http/src/api/routes` usually needs a matching
  `sdk-management` method and test.
- Docs: `apps/docs/src/content/content/guides/sdks.mdx` and `docs/sdks.md`; user-facing docs name the
  published import (`@commerceworker/sdk/react`), never a workspace package.
