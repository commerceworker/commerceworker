import { defineConfig } from 'vitest/config';

/**
 * Two projects: the server and library tests (`*.test.ts`) in node, and the CMS screens and
 * components (`*.test.tsx`) in jsdom with React Testing Library.
 */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['tests/**/*.test.tsx'],
          setupFiles: ['tests/setup-dom.ts'],
          // A file's first test pays for loading its screen (the workflow editor, the rich-text
          // editor) in jsdom: ~300 ms locally, but over the 5 s default on a busy CI runner.
          testTimeout: 15_000,
        },
      },
    ],
  },
});
