import { defineProject } from 'vitest/config';
import { withModuleCache } from '../vitest-project.js';

// Decision ids stay findable: one file defines each, and every id cited in code is in the docs (`pnpm decision-ids`).
export default defineProject(
  withModuleCache({
    test: {
      globalSetup: ['../vitest-temp-root.ts'],
      name: 'decision-ids',
      include: ['*.test.ts'],
    },
  }),
);
