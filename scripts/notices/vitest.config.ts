import { defineProject } from 'vitest/config';
import { withModuleCache } from '../vitest-project.js';

// Unit tests of what THIRD_PARTY_NOTICES.md says and requires (`pnpm notices`).
export default defineProject(
  withModuleCache({
    test: {
      globalSetup: ['../vitest-temp-root.ts'],
      name: 'notices',
      include: ['*.test.ts'],
    },
  }),
);
