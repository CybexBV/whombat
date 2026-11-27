import { defineProject } from 'vitest/config';
import { withModuleCache } from '../vitest-project.js';

// Every co-located i18n catalog keeps English and translated keys, placeholders, CLDR plurals and source hashes in step.
export default defineProject(
  withModuleCache({
    test: {
      globalSetup: ['../vitest-temp-root.ts'],
      name: 'i18n',
      include: ['*.test.ts'],
    },
  }),
);
