/** `harness/validate --soak`: the soak run with the scenarios' module resolution. */
import { defineConfig } from 'vitest/config';
import scenarios from './vitest.scenarios.config.ts';

export default defineConfig({
  resolve: scenarios.resolve,
  test: {
    include: ['src/validate/soak.run.ts'],
    environment: 'node',
    disableConsoleIntercept: true,
    testTimeout: 24 * 3_600_000,
    hookTimeout: 300_000,
    server: { deps: { inline: [/packages\/client\/src/] } },
  },
});
