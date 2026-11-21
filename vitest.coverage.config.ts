import { defineConfig } from 'vitest/config';
import unit from './vitest.config.ts';

// Keep the source denominator fixed, including files that no test imports.
export default defineConfig({
  ...unit,
  test: {
    ...unit.test,
    projects: [
      ...(unit.test?.projects ?? []),
      'apps/server/vitest.int.config.ts',
      'apps/cli/vitest.int.config.ts',
    ],
    coverage: {
      provider: 'v8',
      reportOnFailure: true,
      // 2026-09-26 baseline minus 2 percentage points (docs/decisions/test-pruning.md).
      thresholds: { statements: 79.95, branches: 71.06, functions: 81.94, lines: 83.35 },
      include: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}', 'scripts/package/src/**/*.ts'],
      exclude: ['**/*.{test,spec,stories}.*', '**/test/**', '**/tests/**', '**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'json'],
    },
  },
});
