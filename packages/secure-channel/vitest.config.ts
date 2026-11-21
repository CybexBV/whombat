import { defineProject } from 'vitest/config';
import { withModuleCache } from '../../scripts/vitest-project.js';

export default defineProject(
  withModuleCache({
    test: {
      globalSetup: ['../../scripts/vitest-temp-root.ts'],
      name: '@whombat/secure-channel',
      include: ['test/**/*.test.ts'],
      exclude: ['test/**/*.browser.test.ts'],
      testTimeout: 30_000,
    },
  }),
);
