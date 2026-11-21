// End-to-end checks against a running hub with real agents (no fixtures):
//
//   RACKOON_LIVE_URL=http://10.100.0.7:29080 RACKOON_LIVE_USER=… RACKOON_LIVE_PASS=… \
//   podman run --rm --network host -e RACKOON_LIVE_URL -e RACKOON_LIVE_USER -e RACKOON_LIVE_PASS \
//     -v "$PWD/..":/work -w /work/web mcr.microsoft.com/playwright:v1.64.0-noble \
//     npx playwright test -c scripts/live.config.ts
//
// Guest ids default to the maintainers' test environment; screenshots go to web/.screenshots/live-*.png.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['*.live.ts'],
  outputDir: '../test-results/live',
  workers: 1,
  reporter: [['list']],
  timeout: 90_000,
  use: {
    baseURL: process.env.RACKOON_LIVE_URL,
    locale: 'en-US',
    colorScheme: 'dark',
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ['--font-render-hinting=none', '--disable-lcd-text'] },
  },
});
