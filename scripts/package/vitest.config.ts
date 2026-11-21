import { defineProject } from 'vitest/config';
import { withModuleCache } from '../vitest-project.js';

// Unit tests of the runtime bundle's build: its bundles load, its manifest, its signing. `pnpm bundle:runtime` builds it.
export default defineProject(
  withModuleCache({
    test: {
      globalSetup: ['../vitest-temp-root.ts'],
      name: '@whombat/package',
      include: ['src/**/*.test.ts'],
    },
  }),
);
