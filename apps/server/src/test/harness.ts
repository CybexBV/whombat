/**
 * Integration-test harness: a throwaway database (`useTestDb`), the service container, optionally the
 * seeded test world and the Fastify app listening on a free port.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { afterAll, beforeAll } from 'vitest';
import type { z } from 'zod';
import { buildApp } from '../app';
import type { CommandDef, CommitOptions, CommitResult } from '../commit/types';
import { loadConfig } from '../config';
import { MemoryMailer } from '../mail/mailer';
import { loadSeedWorld } from '../seed/load';
import { TEST_BURROW_ID, testWorld } from '../seed/test-world';
import { createServices, type Services } from '../services';
import { type InProcessApi, inProcessApi } from './api';
import { useTestDb } from './db';
import { logServerErrors, testLogger } from './log';

/** The hosted UI origin the session runtime's suites get unless they set `WHOMBAT_APP_URL` themselves (MR-45). */
export const TEST_APP_URL = 'https://app.whombat.test';

/** The licence key set the session runtime's suites get (TEST; `managed/testing.ts` `signTestLicence` signs with it, MR-55). */
export const TEST_LICENCE_KEYS_FILE = join(import.meta.dirname, '../managed/__fixtures__/licence-keys.json');

/**
 * What the session runtime's suites (`useManagedRuntime`) run with: the test hosted UI and the licence on with the test
 * key set, as a box. Other suites run as `pnpm dev` does: `DEV_APP_URL`, no licence (HE-49).
 */
export const BOX_TEST_ENV: Readonly<Record<string, string>> = {
  WHOMBAT_APP_URL: TEST_APP_URL,
  WHOMBAT_LICENCE: 'on',
  WHOMBAT_LICENCE_KEYS_FILE: TEST_LICENCE_KEYS_FILE,
};

export interface TestServer {
  services: Services;
  mailer: MemoryMailer;
  app: FastifyInstance;
  /** The contract's client endpoints in-process as an account (`test/api.ts`); anything else goes to `app`. */
  api: InProcessApi;
  /** `http://127.0.0.1:<port>` when `listen` is set. */
  baseUrl: string;
  burrowId: string;
  /** Commit a command as a principal of the seeded burrow; resolves once its background work is done. */
  commit<S extends z.ZodType, R>(
    actorId: string,
    command: CommandDef<S, R>,
    input: z.input<S>,
    options?: Partial<CommitOptions>,
  ): Promise<CommitResult<R>>;
}

export function useTestServer(
  options: {
    seed?: boolean;
    app?: boolean;
    listen?: boolean;
    env?: Record<string, string>;
    /**
     * The app's own logger (pino options, e.g. a capturing stream): the services log through it too, as in
     * production. Default: none (errors printed by `logServerErrors`).
     */
    logger?: FastifyServerOptions['logger'];
    /** Connections of the suite's database pool (default `TEST_POOL_SIZE`, `BUSY_POOL_SIZE` for busy servers). */
    poolSize?: number;
  } = {},
): TestServer {
  const testDb = useTestDb({ poolSize: options.poolSize });
  const mailer = new MemoryMailer();
  let services: Services | undefined;
  let app: FastifyInstance | undefined;
  let baseUrl = '';
  // Attachment bytes of this suite, never the host's WHOMBAT_HOME (docs/decisions/bp-attachments.md).
  let filesDir: string | null = null;
  // Backup files of this suite (docs/decisions/backup-file.md BF-D03), never the host's WHOMBAT_HOME either.
  let backupDir: string | null = null;

  beforeAll(async () => {
    if (!options.env?.WHOMBAT_FILES_DIR) filesDir = mkdtempSync(join(tmpdir(), 'whombat-files-'));
    if (!options.env?.WHOMBAT_BACKUP_FILES_DIR) backupDir = mkdtempSync(join(tmpdir(), 'whombat-backups-'));
    const config = loadConfig({
      ...(filesDir ? { WHOMBAT_FILES_DIR: filesDir } : {}),
      ...(backupDir ? { WHOMBAT_BACKUP_FILES_DIR: backupDir } : {}),
      ...options.env,
      DATABASE_URL: testDb.url,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
    const log = testLogger();
    services = createServices({ config, sql: testDb.sql, mailer, log });
    if (options.seed) await loadSeedWorld(services, testWorld());
    if (options.app || options.listen) {
      app = await buildApp({ services, logger: options.logger ?? false });
      logServerErrors(app, log);
      if (options.listen) {
        await app.listen({ host: '127.0.0.1', port: 0 });
        const address = app.server.address();
        if (address && typeof address === 'object') baseUrl = `http://127.0.0.1:${address.port}`;
      } else {
        await app.ready();
      }
    }
  });

  afterAll(async () => {
    await services?.github.idle().catch(() => {});
    await services?.background.settle();
    // Requests still open when the suite is done (a stopped runner's last claim, an MCP stream) would hold app.close()
    // for about 70 s: end them first (test-speed.md TS-S05).
    app?.server.closeAllConnections();
    await app?.close();
    services?.github.close();
    services?.typing.close();
    services?.files.close();
    if (filesDir) rmSync(filesDir, { recursive: true, force: true });
    if (backupDir) rmSync(backupDir, { recursive: true, force: true });
  });

  const get = (): Services => {
    if (!services) throw new Error('useTestServer: not ready (use inside tests or hooks)');
    return services;
  };

  const api = inProcessApi(get, () => app);
  return {
    get services() {
      return get();
    },
    mailer,
    api,
    get app() {
      if (!app) throw new Error('useTestServer: pass { app: true }');
      return app;
    },
    get baseUrl() {
      return baseUrl;
    },
    burrowId: TEST_BURROW_ID,
    async commit(actorId, command, input, extra = {}) {
      const result = await get().pipeline.commit(command, input, {
        burrowId: TEST_BURROW_ID,
        actorId,
        ...extra,
      });
      // What the commit started in the background (badges, notifications, push; server-efficiency.md SV-02) is done
      // when a test's commit returns, as when those hooks held the commit.
      await get().background.settle();
      return result;
    },
  };
}
