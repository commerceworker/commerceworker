import { defineConfig } from 'vitest/config';

// The HTTP API and MCP surfaces, exercised through `app.request()` and an in-memory MCP
// transport against @commerceworker/test-kit fakes. Plain request/response: no bindings, so it
// runs in Node for speed. Durable Objects and Workflows are tested in apps/pipeline (workerd); the
// D1 store in packages/store (workerd).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
