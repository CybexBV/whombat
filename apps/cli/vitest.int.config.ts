import { defineConfig } from 'vitest/config';
import { withModuleCache } from '../../scripts/vitest-project.js';

// `schema-check` and `migrate` against a throwaway database on the dev Postgres (DATABASE_URL, default :55432).
export default defineConfig(
  withModuleCache({
    test: {
      globalSetup: ['../../scripts/vitest-temp-root.ts'],
      name: '@whombat/cli:int',
      include: ['src/**/*.int.test.ts'],
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  }),
);
