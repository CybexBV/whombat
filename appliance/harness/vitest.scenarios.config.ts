/**
 * Cross-repo scenarios against the running local environment (dev/up). `@app-client/*` resolves to the real
 * `@whombat/client` session sources of the whombat-app checkout the environment runs (IN-12).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { loadPins } from './src/manifest/pins.ts';

/** Files in name order (0-platform, a-…, b-…): later files may restart services; earlier ones claim the appliance. */
class ByName extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((x, y) => x.moduleId.localeCompare(y.moduleId));
  }
}

const home = process.env.WB_MGD_HOME ?? join(homedir(), '.cache', 'whombat-mgd');
const envFile = join(home, 'env', 'env.json');
const envState = existsSync(envFile) ? JSON.parse(readFileSync(envFile, 'utf8')) : null;
// `harness/demo --live` resets the environment onto the live trees: resolve the client from the live app tree.
// The pins are `WB_MGD_PINS`'s, else this checkout's own from the component list (written here when they are missing,
// and handed to the test processes).
const pins = loadPins();
const liveApp = String(pins.components.find((c) => c.id === 'whombat-app')?.live ?? '').replace(
  /^~\//,
  `${homedir()}/`,
);
/** Without an environment (a demo that starts by resetting it): the pinned app's clean clone under `src/`. */
function pinnedAppClone(): string {
  const commit = String(pins.components.find((c) => c.id === 'whombat-app')?.commit ?? '');
  return join(home, 'src', `whombat-app@${commit.slice(0, 12)}`);
}
const app: string =
  process.env.WB_APP_DIR ??
  (/^(1|all)$|(^|,)(app|whombat-app)(,|$)/.test(process.env.WB_DEMO_LIVE ?? '')
    ? liveApp
    : (envState?.sources?.['whombat-app']?.path ?? pinnedAppClone()));
const session = join(app, 'packages/client/src/session');

export default defineConfig({
  resolve: {
    alias: {
      '@app-client/session': join(session, 'index.ts'),
      '@app-client/secure-channel': join(session, 'secure-channel.ts'),
      // The app's claim ceremony (AP-47, contracts ≥ 0.7): CPace over the enrollment session.
      '@app-client/claim': join(app, 'packages/client/src/managed/claim.ts'),
      // The claim on the box's own page (`runLocalClaim`): CPace over the page's direct connection.
      '@app-client/community': join(app, 'packages/client/src/managed/community.ts'),
    },
  },
  test: {
    include: ['scenarios/**/*.scenario.ts'],
    exclude: (process.env.WB_SCENARIO_EXCLUDE ?? '')
      .split(',')
      .filter(Boolean)
      .map((file) => `scenarios/${file}`),
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false, sequencer: ByName },
    server: { deps: { inline: [/packages\/client\/src/] } },
  },
});
