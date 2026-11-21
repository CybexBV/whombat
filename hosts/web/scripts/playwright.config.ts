// Visual verification: renders every page in fixture mode at 1440 px and 390 px
// (full page) into web/.screenshots/ for comparison with
// docs/handoff/design/screenshots/. Run inside the official Playwright image:
//
//   podman run --rm --network host -v "$PWD/..":/work -w /work/web \
//     mcr.microsoft.com/playwright:v1.64.0-noble npx playwright test -c scripts/playwright.config.ts
//
// The fixture dev server is reused when already running on :5173
// (`pnpm dev:fixtures`), otherwise started inside the container.
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.SCREENSHOT_PORT ?? 5173);

export default defineConfig({
  testDir: '.',
  testMatch: ['*.spec.ts'],
  outputDir: '../test-results',
  fullyParallel: true,
  workers: 4,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    timezoneId: 'UTC',
    locale: 'en-US',
    colorScheme: 'dark',
    deviceScaleFactor: 1,
    // Subpixel glyph positioning, closer to the reference renders (macOS).
    launchOptions: { args: ['--font-render-hinting=none', '--disable-lcd-text'] },
  },
  webServer: {
    command: `npx vite --mode fixtures --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/api/v1/auth/state`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: false, hasTouch: false } },
  ],
});
