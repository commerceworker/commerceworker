/**
 * The in-memory wiring of the HTTP API, for the API tests and the docs build's OpenAPI generator.
 * It is a composition root, so it lives in `@commerceworker/platform`; this re-export keeps the docs
 * importing only `@commerceworker/http`.
 */
export { type InMemoryWired, wire } from '@commerceworker/platform/in-memory';
