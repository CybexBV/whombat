import { defineProject } from 'vitest/config';
import { withModuleCache } from '../../scripts/vitest-project.js';

// Unit tests only. The tests against a real Postgres are *.int.test.ts (`pnpm test:cli`).
export default defineProject(
  withModuleCache({
    test: {
      globalSetup: ['../../scripts/vitest-temp-root.ts'],
      name: '@whombat/cli',
      include: ['src/**/*.test.ts'],
      exclude: ['src/**/*.int.test.ts'],
    },
  }),
);
