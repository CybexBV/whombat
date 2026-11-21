/**
 * Managed-runtime soak (`pnpm soak:managed [--minutes N] [--max-growth-mb M] [--snapshots]`, MR-30): the real server
 * (`src/index.ts`) and the real runner (`apps/runner`, the scripted Hermes, its sign-in executor
 * long-polling the server), with a stand-in manager on a unix socket (tickets, reports), a stand-in relay (control
 * connection and welcome) and a manager-like poller of the admin socket (`/health`, `/facts` every 5 s) — the idle
 * traffic of an appliance nobody is using. It samples the server's RSS (`/proc/<pid>/status`) every 10 s and fails
 * (exit 1) when it grows more than `--max-growth-mb` after the warm-up.
 *
 * A throwaway database next to `DATABASE_URL` (created and dropped), free ports, temporary directories only.
 * `--snapshots` writes two heap snapshots of the server (after the warm-up and at the end, `SIGUSR2`) to
 * `$TMPDIR/wb-soak-snapshots`; `--no-runner`, `--no-signin`, `--no-poller`, `--no-relay` leave a part out (bisecting).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { SCRIPTED_HERMES } from '@whombat/agent-runtime/testing/hermes';
import { WebSocketServer } from 'ws';
import { ensureDevIdentity } from '../managed/dev-standins';
import { createTestDb } from '../test/db';

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const MINUTES = flag('minutes', 2);
const MAX_GROWTH_MB = flag('max-growth-mb', 40);
const SNAPSHOTS = args.includes('--snapshots');
/** Where `--snapshots` writes the server's heap snapshots (kept after the run). */
const SNAPSHOT_DIR = resolve(process.env.TMPDIR ?? tmpdir(), 'wb-soak-snapshots');
/** Bisecting a leak: leave out the runner (its sign-in poll), the admin poller, or the relay. */
const NO_RUNNER = args.includes('--no-runner');
const NO_POLLER = args.includes('--no-poller');
const NO_RELAY = args.includes('--no-relay');
/** …or only the runner's sign-in executor (its long poll). */
const NO_SIGNIN = args.includes('--no-signin');
const WARMUP_MS = Math.min(60_000, (MINUTES * 60_000) / 3);

const serverDir = resolve(import.meta.dirname, '../..');
const runnerDir = resolve(serverDir, '../runner');
const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'wb-soak-'));

async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

/** The stand-in relay: control connections get a welcome; nothing else happens (no clients). */
async function standInRelay(): Promise<{ url: string; close: () => void; connections: () => number }> {
  const server = createHttpServer();
  const wss = new WebSocketServer({ server, path: '/v1/connect' });
  let connections = 0;
  wss.on('connection', (ws) => {
    connections += 1;
    ws.once('message', () =>
      ws.send(
        JSON.stringify({
          t: 'welcome',
          v: 1,
          conn: `conn-${String(connections).padStart(8, '0')}`,
          heartbeatMs: 20_000,
          maxMessage: 262_144,
        }),
      ),
    );
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { t?: string; n?: number };
      if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong', n: msg.n ?? 0 }));
    });
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return {
    url: `ws://127.0.0.1:${port}/v1/connect`,
    close: () => server.close(),
    connections: () => connections,
  };
}

/** The stand-in manager socket (`MANAGER_PATHS`). */
function standInManager(path: string, relayUrl: string): Server {
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/runtime/ticket')
        res.end(
          JSON.stringify({
            ticket: `aaaaaaaaaaaaaaaa.bbbbbbbb.c${Date.now()}`,
            relayUrl,
            worker: 'wrk-soak',
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          }),
        );
      else if (req.url === '/v1/runtime/push')
        res.end(JSON.stringify({ accepted: 0, invalidHandles: [], rateLimited: false }));
      else res.end(JSON.stringify({ ok: true }));
    });
  });
  server.listen(path);
  return server;
}

function adminGet(socket: string, path: string): Promise<number> {
  return new Promise((resolveStatus) => {
    const req = httpRequest({ socketPath: socket, path, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolveStatus(res.statusCode ?? 0));
    });
    req.on('error', () => resolveStatus(0));
    req.end();
  });
}

function rssMb(pid: number): number {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const kb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
  return Math.round(kb / 1024);
}

async function main(): Promise<void> {
  if (SNAPSHOTS) mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const db = await createTestDb();
  const relay = await standInRelay();
  const managerSock = join(work, 'manager.sock');
  const adminSock = join(work, 'admin.sock');
  const manager = standInManager(managerSock, NO_RELAY ? 'ws://127.0.0.1:1/v1/connect' : relay.url);
  const port = await freePort();
  const token = 'soak-runner-token-0000000000000000000000';
  const credentials = mkdtempSync(join(work, 'credentials-'));
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    LOG_LEVEL: 'warn',
    DATABASE_URL: db.url,
    PORT: String(port),
    HOST: '127.0.0.1',
    WHOMBAT_APP_URL: 'https://app.whombat.test',
    WHOMBAT_HOME: join(work, 'home'),
    WHOMBAT_FILES_DIR: join(work, 'files'),
    WHOMBAT_ADMIN_SOCKET: adminSock,
    WHOMBAT_MANAGER_SOCKET: managerSock,
    WHOMBAT_CONTENT_KEY_FILE: await ensureDevIdentity(join(work, 'home')),
    WHOMBAT_LICENCE_KEYS_FILE: join(serverDir, 'src/managed/__fixtures__/licence-keys.json'),
    WHOMBAT_CREDENTIALS_ROOT: credentials,
    RUNNER_TOKEN: token,
  };
  await db.sql.end({ timeout: 5 });
  const server = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      ...(SNAPSHOTS ? ['--heapsnapshot-signal=SIGUSR2', `--diagnostic-dir=${SNAPSHOT_DIR}`] : []),
      'src/index.ts',
    ],
    { cwd: serverDir, env, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  let runner: ReturnType<typeof spawn> | null = null;
  const stop = async () => {
    runner?.kill('SIGTERM');
    server.kill('SIGTERM');
    await sleep(1_000);
    manager.close();
    relay.close();
  };
  try {
    for (let i = 0; i < 120 && (await adminGet(adminSock, '/health')) === 0; i++) await sleep(500);
    if (!NO_RUNNER)
      runner = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: runnerDir,
        env: {
          ...env,
          WHOMBAT_SERVER_URL: `http://127.0.0.1:${port}`,
          WHOMBAT_WORKSPACES: join(work, 'ws'),
          // The scripted Hermes stands in for Hermes (hermes-engine.md HE-33): the runner's engine check passes.
          WHOMBAT_HERMES_BIN: SCRIPTED_HERMES,
          WHOMBAT_HERMES_ROOT: join(work, 'hermes'),
          ...(NO_SIGNIN ? { WHOMBAT_CREDENTIALS_ROOT: '' } : {}),
        },
        stdio: ['ignore', 'inherit', 'inherit'],
      });
    const poller = setInterval(() => {
      if (NO_POLLER) return;
      void adminGet(adminSock, '/health');
      void adminGet(adminSock, '/facts');
    }, 5_000);
    const started = Date.now();
    const samples: { s: number; rss: number }[] = [];
    let baseline: number | null = null;
    while (Date.now() - started < MINUTES * 60_000) {
      await sleep(10_000);
      if (server.exitCode !== null) throw new Error(`the server exited (${server.exitCode})`);
      const rss = rssMb(server.pid as number);
      const s = Math.round((Date.now() - started) / 1000);
      samples.push({ s, rss });
      if (baseline === null && Date.now() - started >= WARMUP_MS) {
        baseline = rss;
        if (SNAPSHOTS) server.kill('SIGUSR2');
      }
      console.log(`[soak] t=${s}s rss=${rss}MB${baseline !== null ? ` growth=${rss - baseline}MB` : ''}`);
    }
    clearInterval(poller);
    if (SNAPSHOTS) {
      server.kill('SIGUSR2');
      await sleep(5_000);
      const snaps = readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith('.heapsnapshot'));
      console.log(`[soak] heap snapshots in ${SNAPSHOT_DIR}: ${snaps.join(', ')}`);
    }
    const last = samples.at(-1)?.rss ?? 0;
    const growth = baseline === null ? 0 : last - baseline;
    console.log(
      JSON.stringify({
        soak: 'managed',
        minutes: MINUTES,
        relayConnections: relay.connections(),
        baselineMb: baseline,
        lastMb: last,
        growthMb: growth,
        limitMb: MAX_GROWTH_MB,
        ok: growth <= MAX_GROWTH_MB,
      }),
    );
    if (growth > MAX_GROWTH_MB) process.exitCode = 1;
  } finally {
    await stop();
    const drop = await createTestDbDropper(db.name);
    await drop();
    rmSync(work, { recursive: true, force: true });
  }
}

/** Drops the soak database (its own pool was closed before the server started). */
async function createTestDbDropper(name: string): Promise<() => Promise<void>> {
  const { default: postgres } = await import('postgres');
  const { loadConfig } = await import('../config');
  return async () => {
    const admin = postgres(loadConfig().DATABASE_URL, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
