import { defineProject } from 'vitest/config';
import { withModuleCache } from '../../scripts/vitest-project.js';

export default defineProject(
  withModuleCache({
    test: {
      globalSetup: ['../../scripts/vitest-temp-root.ts'],
      name: '@whombat/runner',
      include: ['src/**/*.test.ts'],
      // A temporary directory of each file's own: turns in tests never share the machine's runner scratch space (DG-49).
      setupFiles: ['src/test-setup.ts'],
    },
  }),
);
