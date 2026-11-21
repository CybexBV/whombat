import { defineConfig } from 'vitest/config';
import { withModuleCache } from '../../scripts/vitest-project.js';

// Integration tests against a real Postgres: each test file gets a throwaway database (src/test/db.ts).
export default defineConfig(
  withModuleCache({
    test: {
      globalSetup: ['../../scripts/vitest-temp-root.ts'],
      name: '@whombat/server:int',
      include: ['src/**/*.int.test.ts'],
      // Every file checks OPERATION_SAFETY against the effects it drives (command-safety.md CS-08).
      setupFiles: ['src/test/effects-setup.ts'],
      // Every file holds TEST_POOL_SIZE (3) connections of the shared dev Postgres (max_connections 100,
      // also used by other suites on the machine): 16 files at once hold 48, so a second suite still fits
      // (src/test/db.ts waits for free slots). CI explicitly overrides this with VITEST_MAX_WORKERS;
      // ci:check validates 1..8 for the isolated guest's Postgres.
      maxWorkers: 16,
      testTimeout: 30_000,
      // Includes waiting for free connections while other suites hold them (src/test/db.ts).
      hookTimeout: 180_000,
    },
  }),
);
