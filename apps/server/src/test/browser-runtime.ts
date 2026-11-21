/** Real disposable runtime for Playwright: Postgres, encrypted direct sessions, and the scripted Hermes runner. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { MemoryMailer } from '../mail/mailer';
import { startManaged } from '../managed/boot';
import { withStandIns } from '../managed/dev-standins';
import { loadSeedWorld } from '../seed/load';
import { IDS, testWorld } from '../seed/test-world';
import { createServices, silentLogger } from '../services';
import { createTestDb } from './db-resource';
import { chatWith } from './rooms';
import { startTestRunner } from './runner';
import { SCRIPTED_ENV } from './scripted';

const home = await mkdtemp(join(tmpdir(), 'wb-browser-runtime-'));
let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let managed: Awaited<ReturnType<typeof startManaged>> | undefined;
let runner: Awaited<ReturnType<typeof startTestRunner>> | undefined;
let standIns: Awaited<ReturnType<typeof withStandIns>> | undefined;
let services: ReturnType<typeof createServices> | undefined;
let closing: Promise<void> | undefined;
function close(): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    // One failed shutdown must not leave the remaining private resources behind.
    const cleanups = [
      async () => {
        await runner?.stop();
        if (runner) await rm(dirname(runner.hermesRoot), { recursive: true, force: true });
      },
      () => managed?.close(),
      async () => {
        app?.server.closeAllConnections();
        await app?.close();
      },
      () => services?.typing.close(),
      () => standIns?.manager?.close(),
      () => db?.drop(),
      () => rm(home, { recursive: true, force: true }),
    ];
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error) {
        console.error('Browser runtime cleanup failed', error);
        process.exitCode = 1;
      }
    }
  })();
  return closing;
}
process.once('SIGTERM', () => void close().then(() => process.exit(process.exitCode ?? 0)));
process.once('SIGINT', () => void close().then(() => process.exit(process.exitCode ?? 0)));
try {
  db = await createTestDb(5);
  await writeFile(join(home, 'test-resource.json'), JSON.stringify({ database: db.name, home }));
  standIns = await withStandIns(
    loadConfig({
      ...SCRIPTED_ENV,
      DATABASE_URL: db.url,
      NODE_ENV: 'development',
      LOG_LEVEL: 'silent',
      PORT: process.env.RUNTIME_PORT ?? '4496',
      WHOMBAT_DIRECT_PORT: process.env.WEB_RUNTIME_DIRECT_PORT ?? '4576',
      WHOMBAT_HOME: home,
      WHOMBAT_ADMIN_SOCKET: join(home, 'admin.sock'),
      WHOMBAT_WORKSPACES: join(home, 'workspaces'),
      WHOMBAT_FILES_DIR: join(home, 'files'),
      WHOMBAT_BACKUP_FILES_DIR: join(home, 'backups'),
      WHOMBAT_HERMES_ROOT: join(home, 'hermes'),
      WHOMBAT_CREDENTIALS_ROOT: join(home, 'credentials'),
    }),
  );
  services = createServices({
    config: standIns.config,
    sql: db.sql,
    log: silentLogger,
    mailer: new MemoryMailer(),
  });
  await loadSeedWorld(services, testWorld());
  await chatWith(services, 'bur_burrow-hq', IDS.dusty, IDS.mara);
  app = await buildApp({ services });
  await app.listen({ host: '127.0.0.1', port: standIns.config.PORT });
  managed = await startManaged(services, standIns.config, { relay: false });
  runner = await startTestRunner(`http://127.0.0.1:${standIns.config.PORT}`, { thinkMs: 30, tickMs: 20 });
  await writeFile(
    join(home, 'test-resource.json'),
    JSON.stringify({ database: db.name, home, runnerHome: dirname(runner.hermesRoot) }),
  );
  console.log(`Browser runtime ready; disposable database ${db.name}`);
} catch (error) {
  await close();
  throw error;
}
