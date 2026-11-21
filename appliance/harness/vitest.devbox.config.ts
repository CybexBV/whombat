/**
 * The DEV box's claim and smoke (`dev/devbox`, IN-94, IN-101) through the real client: `@app-client/*` resolves to the
 * `@whombat/client` session code of the whombat-app the DEV instance serves (its `env.json` sources, i.e. what
 * dev.whombat.com's users run), or `WB_DEVBOX_APP_DIR`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

const devHome = (process.env.WB_DEV_HOME ?? '~/.whombat-stack-dev').replace(/^~\//, `${homedir()}/`);
const envFile = join(devHome, 'env', 'env.json');
const envState = existsSync(envFile) ? JSON.parse(readFileSync(envFile, 'utf8')) : null;
const app: string = process.env.WB_DEVBOX_APP_DIR ?? envState?.sources?.['whombat-app']?.path ?? '';
const session = join(app, 'packages/client/src/session');

export default defineConfig({
  resolve: {
    alias: {
      '@app-client/session': join(session, 'index.ts'),
      '@app-client/secure-channel': join(session, 'secure-channel.ts'),
      '@app-client/claim': join(app, 'packages/client/src/managed/claim.ts'),
    },
  },
  test: {
    include: ['src/devbox/**/*.devbox.ts'],
    environment: 'node',
    testTimeout: 900_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    server: { deps: { inline: [/packages\/client\/src/] } },
  },
});
