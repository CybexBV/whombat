import { defineProject } from 'vitest/config';
import { withModuleCache } from '../../../scripts/vitest-project.js';

// Every CSS-module class the web and widget code reads exists in its stylesheet (classes.ts).
export default defineProject(
  withModuleCache({
    test: {
      globalSetup: ['../../../scripts/vitest-temp-root.ts'],
      name: 'css-modules',
      include: ['*.test.ts'],
      testTimeout: 60_000,
    },
  }),
);
