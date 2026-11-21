import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';
import { withModuleCache } from '../../scripts/vitest-project.js';

export default defineProject(
  withModuleCache({
    plugins: [react()],
    test: {
      globalSetup: ['../../scripts/vitest-temp-root.ts'],
      name: '@whombat/web',
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['./src/test/setup.ts'],
      css: { modules: { classNameStrategy: 'non-scoped' } },
      // Headroom above the raised `asyncUtilTimeout` (src/test/setup.ts) so a slow CI runner has room to
      // finish a test that itself waits on a couple of sequential async state changes, without masking a
      // truly hung test (still finite, still fails).
      testTimeout: 15000,
    },
  }),
);
