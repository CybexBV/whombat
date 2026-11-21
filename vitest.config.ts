import { defineConfig } from 'vitest/config';
import { LOCAL_RUN } from './scripts/vitest-project.ts';
import { LongestFirst } from './scripts/vitest-sequencer.ts';

// Unit tests for every workspace package. Server integration tests (Postgres) run via `pnpm test:server`; browser
// flows through Playwright (`pnpm e2e:managed`, `pnpm visual`).
export default defineConfig({
  test: {
    globalSetup: ['scripts/vitest-temp-root.ts'],
    projects: [
      'packages/*',
      'apps/*',
      'tools/*',
      'contracts/conformance',
      'scripts/package',
      'scripts/notices',
      'scripts/decision-ids',
      'apps/web/css-modules',
    ],
    // Locally the files that took longest last time start first; CI keeps Vitest's own order.
    ...(LOCAL_RUN ? { sequence: { sequencer: LongestFirst } } : {}),
  },
});
