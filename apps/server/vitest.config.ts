import { defineProject } from 'vitest/config';
import { withModuleCache } from '../../scripts/vitest-project.js';

// Unit tests only. Tests that need Postgres are named *.int.test.ts and run via `pnpm test:server`.
export default defineProject(
  withModuleCache({
    test: {
      globalSetup: ['../../scripts/vitest-temp-root.ts'],
      name: '@whombat/server',
      include: ['src/**/*.test.ts'],
      exclude: ['src/**/*.int.test.ts'],
    },
  }),
);
