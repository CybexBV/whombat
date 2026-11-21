/** The acceptance demo (src/demo/*.demo.ts) with the scenarios' module resolution; narration streams live. */
import { defineConfig } from 'vitest/config';
import scenarios from './vitest.scenarios.config.ts';

export default defineConfig({
  resolve: scenarios.resolve,
  test: {
    include: ['src/demo/**/*.demo.ts'],
    environment: 'node',
    disableConsoleIntercept: true,
    testTimeout: 900_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    server: { deps: { inline: [/packages\/client\/src/] } },
  },
});
