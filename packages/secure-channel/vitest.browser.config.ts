import { defineProject } from 'vitest/config';
import { withModuleCache } from '../../scripts/vitest-project.js';

// Browser <-> Node interop: bundles the package with esbuild, loads it in Playwright browsers and connects
// through a splice relay to a Node responder. Needs Playwright browsers in ~/.cache/ms-playwright.
export default defineProject(
  withModuleCache({
    test: {
      globalSetup: ['../../scripts/vitest-temp-root.ts'],
      name: '@whombat/secure-channel:browser',
      include: ['test/**/*.browser.test.ts'],
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  }),
);
