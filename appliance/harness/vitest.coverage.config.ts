import { defineConfig } from 'vitest/config';
import unit from './vitest.unit.config.ts';

// Keep the source denominator fixed, including files that no test imports.
export default defineConfig({
  ...unit,
  test: {
    ...unit.test,
    coverage: {
      provider: 'v8',
      reportOnFailure: true,
      // 2026-09-26 baseline minus 2 percentage points (docs/decisions/test-pruning.md).
      thresholds: { statements: 4.84, branches: 3.23, functions: 6.01, lines: 4.8 },
      include: ['src/**/*.ts'],
      exclude: ['**/*.{test,spec,stories}.*', '**/test/**', '**/tests/**', '**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'json'],
    },
  },
});
