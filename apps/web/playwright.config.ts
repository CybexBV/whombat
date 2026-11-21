import { defineConfig, devices } from '@playwright/test';

/**
 * Browser projects, with a disposable real runtime for the smoke suite (hermes-engine-app.md AP-5323, AP-5430):
 * - `visual` (`pnpm visual`): the web app in fixture mode (`VITE_FIXTURES=1`, the in-memory box) compared with
 *   the HTML references, plus screenshot baselines for unmocked screens and every Storybook primitive /
 *   card story (Storybook dev server). See tools/visual/README.md.
 * - `managed` (`pnpm e2e:managed`): the hosted app's journeys against the in-browser fake control and boxes.
 * - `hosted`: the hosted build under its strict CSP, same fake world.
 * - `box` (`pnpm e2e:box`): the box's own page against the fake world's community box (claim, links, settings).
 * - `readme` (`pnpm readme:shots`): the README's pictures, from the demo world in fixture mode (`readme/`).
 * Only the servers of the selected project are started. Ports are overridable for parallel runs.
 */
const visualPort = Number(process.env.WEB_VISUAL_PORT || 5191);
const visualURL = `http://localhost:${visualPort}`;
const storybookPort = Number(process.env.STORYBOOK_VISUAL_PORT || 6192);
const storybookURL = `http://localhost:${storybookPort}`;
const managedPort = Number(process.env.WEB_MANAGED_PORT || 5193);
const managedURL = `http://localhost:${managedPort}`;
const hostedPort = Number(process.env.WEB_HOSTED_PORT || 5194);
const hostedURL = `http://localhost:${hostedPort}`;
const boxPort = Number(process.env.WEB_BOX_PORT || 5195);
const boxURL = `http://localhost:${boxPort}`;

const readmePort = Number(process.env.WEB_README_PORT || 5197);
const readmeURL = `http://localhost:${readmePort}`;

const runtimePort = Number(process.env.WEB_RUNTIME_PORT || 5196);
const runtimeURL = `http://localhost:${runtimePort}`;
const runtimeDirectPort = process.env.WEB_RUNTIME_DIRECT_PORT || '4576';

const args = process.argv.join(' ');
const wants = (project: string) => !/--project[= ]/.test(args) || args.includes(`--project=${project}`);
const reuse = !process.env.CI;

const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } };

export default defineConfig({
  outputDir: '../../tmp/playwright/web',
  reporter: process.env.CI ? 'github' : 'list',
  // A modest cap: this dev box runs several agents' worktrees at once.
  workers: process.env.CI ? undefined : 4,
  // This dev box runs several agents' worktrees at once (CLAUDE.md), so host CPU contention outside this
  // suite's control can still push a target over the timeout above even with the worker cap. One retry
  // absorbs that transient noise; a genuine regression still fails twice and gets reported.
  retries: 1,
  // Dev-mode React StrictMode double-invokes effects, which aborts and immediately retries each route's
  // first read; under the suite's load that can take a few seconds. 5s (the default) flakes on this.
  expect: { timeout: 15_000 },
  use: {
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'runtime',
      testDir: './e2e-runtime',
      timeout: 90_000,
      retries: 0,
      use: { ...desktop, baseURL: runtimeURL },
    },
    // Managed journeys (AP-15): the hosted UI in session mode against the in-browser fake control and appliances.
    {
      name: 'managed',
      testDir: './e2e-managed',
      testIgnore: /hosted\.spec\.ts/,
      use: { ...desktop, baseURL: managedURL, acceptDownloads: true },
    },
    // The hosted build (strict CSP, own fonts, no inline script) against the fake world: no CSP violations.
    {
      name: 'hosted',
      testDir: './e2e-managed',
      testMatch: /hosted\.spec\.ts/,
      use: { ...desktop, baseURL: hostedURL, acceptDownloads: true },
    },
    // The box's own page (AP-5430): the box target in fake mode, on the fake world's community box.
    {
      name: 'box',
      testDir: './e2e-box',
      use: { ...desktop, baseURL: boxURL },
    },
    // The README's pictures (`readme/`): written only when README_SHOTS names a folder.
    {
      name: 'readme',
      testDir: './readme',
      timeout: 120_000,
      retries: 0,
      use: { baseURL: readmeURL, launchOptions: { args: ['--disable-lcd-text'] } },
    },
    {
      name: 'visual',
      testDir: './visual',
      timeout: 120_000,
      retries: process.env.CI ? 1 : 0,
      // Baselines for screens without a mock: one set for every platform (fonts are web fonts).
      snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
      expect: {
        toHaveScreenshot: {
          animations: 'disabled',
          caret: 'hide',
          scale: 'css',
          threshold: 0.2,
          maxDiffPixelRatio: 0.002,
        },
      },
      use: {
        ...desktop,
        baseURL: visualURL,
        deviceScaleFactor: 1,
        timezoneId: 'Europe/Amsterdam',
        locale: 'en-GB',
        // Grayscale text on every machine (CHROMIUM_ARGS in tools/visual, the reference harness).
        launchOptions: { args: ['--disable-lcd-text'] },
        // Stills: animated avatars (the agent's face in Settings and onboarding) hold their static pose.
        reducedMotion: 'reduce',
      },
    },
  ],
  webServer: [
    ...(wants('runtime')
      ? [
          {
            command: 'node --import tsx ../server/src/test/browser-runtime.ts',
            gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 20_000 },
            url: `http://127.0.0.1:${runtimeDirectPort}/v1/direct`,
            reuseExistingServer: false,
            timeout: 180_000,
            env: { WEB_RUNTIME_DIRECT_PORT: runtimeDirectPort },
          },
          {
            command: `pnpm exec vite --port ${runtimePort} --strictPort`,
            url: runtimeURL,
            reuseExistingServer: false,
            env: {
              WEB_PORT: String(runtimePort),
              WHOMBAT_DIRECT_PORT: runtimeDirectPort,
              VITE_WHOMBAT_TARGET: 'box',
              VITE_WHOMBAT_FAKE: '',
              VITE_FIXTURES: '',
            },
          },
        ]
      : []),
    ...(wants('visual')
      ? [
          {
            command: `pnpm exec vite --port ${visualPort} --strictPort`,
            url: visualURL,
            reuseExistingServer: reuse,
            env: { WEB_PORT: String(visualPort), VITE_FIXTURES: '1' },
          },
          {
            command: `pnpm exec storybook dev -p ${storybookPort} --ci --no-open`,
            url: `${storybookURL}/index.json`,
            reuseExistingServer: reuse,
            timeout: 180_000,
          },
        ]
      : []),
    ...(wants('readme')
      ? [
          {
            // The demo world as the README shows it: the one-Whombat shell with servers, services, automations and
            // the screens a tablet or monitor draws.
            command: `pnpm exec vite --port ${readmePort} --strictPort`,
            url: readmeURL,
            reuseExistingServer: false,
            env: {
              WEB_PORT: String(readmePort),
              VITE_FIXTURES: '1',
              VITE_FIXTURE_SHELL: 'assistant',
              VITE_FIXTURE_HOST: '1',
              VITE_FIXTURE_HOSTS: '1',
              VITE_FIXTURE_SERVICES: '1',
              VITE_FIXTURE_AUTOMATIONS: '1',
              VITE_FIXTURE_DESK: 'screens',
            },
          },
        ]
      : []),
    ...(wants('managed')
      ? [
          {
            // A bundled build, not the Vite dev server: the dev server sends every page load as ~1,200 separate
            // modules, which costs 3–5 s per navigation on a 4-CPU CI VM with four browsers, so journeys that
            // navigate a dozen times ran out of their 30 s. NODE_ENV=development keeps what the dev server gave
            // the journeys (React's development build, StrictMode's double effects, responses checked against
            // the contracts); building takes a few seconds.
            command: `pnpm exec vite build --mode e2e --outDir dist-managed-e2e && pnpm exec vite preview --outDir dist-managed-e2e --port ${managedPort} --strictPort`,
            url: managedURL,
            reuseExistingServer: reuse,
            timeout: 180_000,
            env: {
              NODE_ENV: 'development',
              WEB_PORT: String(managedPort),
              VITE_WHOMBAT_TARGET: 'hosted',
              VITE_WHOMBAT_FAKE: '1',
            },
          },
        ]
      : []),
    ...(wants('box')
      ? [
          {
            command: `pnpm exec vite --port ${boxPort} --strictPort`,
            url: boxURL,
            reuseExistingServer: reuse,
            env: { WEB_PORT: String(boxPort), VITE_WHOMBAT_TARGET: 'box', VITE_WHOMBAT_FAKE: '1' },
          },
        ]
      : []),
    ...(wants('hosted')
      ? [
          {
            command: `pnpm exec vite build --mode e2e --outDir dist-hosted-e2e && node e2e-managed/serve-hosted.mjs`,
            url: hostedURL,
            reuseExistingServer: false,
            timeout: 180_000,
            env: {
              WEB_HOSTED_PORT: String(hostedPort),
              VITE_WHOMBAT_TARGET: 'hosted',
              VITE_WHOMBAT_FAKE: '1',
            },
          },
        ]
      : []),
  ],
});
