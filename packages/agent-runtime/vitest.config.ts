import { defineProject } from 'vitest/config';
import { withModuleCache } from '../../scripts/vitest-project.js';

export default defineProject(
  withModuleCache({
    test: {
      globalSetup: ['../../scripts/vitest-temp-root.ts'],
      name: '@whombat/agent-runtime',
      include: ['src/**/*.test.ts'],
    },
  }),
);
