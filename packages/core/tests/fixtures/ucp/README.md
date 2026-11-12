# UCP schemas and service specs

The Universal Commerce Protocol's JSON Schemas (`schemas/`, from `source/schemas/`) and its shopping
service specs (`services/shopping/rest.openapi.json` and `mcp.openrpc.json`, from
`source/services/shopping/`), copied unchanged from https://github.com/Universal-Commerce-Protocol/ucp
at commit `cd78fb3`, under the Apache License 2.0 (`LICENSE`).

That commit is what the tag `v2026-08-25` named when these were vendored. The tag has since moved
five commits later (`87dd4b1`, which changed the media schemas), so the media schemas here are the
earlier ones. The two service specs are byte-identical at both commits. The specs' `$ref`s
(`../../schemas/...`) resolve to `schemas/` from `services/shopping/`.

`tests/ucp.test.ts` validates what CommerceWorker serves (the business profile, checkout and order
responses) against the schemas; `tests/ucp-catalog.test.ts` does the same for catalog search and
lookup, and checks that the service specs expose the catalog operations and that their request and
response refs resolve to the schemas it conforms to.

To move to a new UCP version, replace `schemas/` and `services/shopping/` with that tag's
`source/schemas/` and the two files in `source/services/shopping/` (check the commit the tag names,
not only its date), update this README's commit and `UCP_VERSION` in `src/ucp/errors.ts`, and run
the core tests.
