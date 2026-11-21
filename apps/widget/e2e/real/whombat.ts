/**
 * A real Whombat for the end-to-end suite (run.ts): a throwaway database on the shared Postgres, the seed world,
 * and `apps/server/src/index.ts` in **production mode** (loopback `PUBLIC_URL`, its own master key and runner
 * token, GitHub and Google off, no SMTP) serving the built web app and the built widget. People sign in the way an
 * operator hands out access without email: a host sign-in link (`login-link`), exchanged for a bearer token.
 *
 * Everything is undone by `stop()` / `dropDatabase()`, which run on failure and on Ctrl-C too (run.ts).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

export const REPO = resolve(import.meta.dirname, '../../../..');
/** The Whombat server checkout (WHOMBAT_SERVER_REPO, default the sibling `../Whombat`). */
export const SERVER_REPO = resolve(process.env.WHOMBAT_SERVER_REPO || resolve(REPO, '../Whombat'));
const SERVER_DIR = join(SERVER_REPO, 'apps/server');
// The server package owns the Postgres driver; borrow it (as apps/web/e2e/support/server.mjs does).
const postgres = createRequire(join(SERVER_DIR, 'package.json'))('postgres') as typeof import('postgres');
type Sql = ReturnType<typeof postgres>;

const BASE_DB =
  process.env.FEEDBACK_E2E_DATABASE_URL ?? 'postgres://whombat:whombat@127.0.0.1:55432/postgres';
export const LOG_DIR = join(REPO, 'tmp/e2e-feedback');

export interface Database {
  name: string;
  url: string;
  sql: Sql;
  drop(): Promise<void>;
}

/** `whombat_fbe2e_<random>`, migrated and seeded with the mock world (seeding refuses production, so development). */
export async function createDatabase(env: NodeJS.ProcessEnv): Promise<Database> {
  const name = `whombat_fbe2e_${randomBytes(5).toString('hex')}`;
  const admin = postgres(BASE_DB, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${name}"`);
  const url = new URL(BASE_DB);
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 2, onnotice: () => {} });
  let dropped = false;
  const db: Database = {
    name,
    url: url.toString(),
    sql,
    async drop() {
      if (dropped) return;
      dropped = true;
      await sql.end({ timeout: 5 }).catch(() => {});
      await admin.unsafe(`drop database if exists "${name}" with (force)`).catch(() => {});
      await admin.end({ timeout: 5 }).catch(() => {});
    },
  };
  try {
    await runScript(['src/scripts/seed.ts'], { ...env, NODE_ENV: 'development', DATABASE_URL: db.url });
  } catch (err) {
    await db.drop();
    throw err;
  }
  return db;
}

function runScript(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
      cwd: SERVER_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c;
    });
    child.stderr.on('data', (c: Buffer) => {
      err += c;
    });
    child.once('error', fail);
    child.once('exit', (code) =>
      code === 0 ? ok(out) : fail(new Error(`${args.join(' ')} exited ${code}:\n${err || out}`)),
    );
  });
}

export interface ServerOptions {
  port: number;
  db: Database;
  /** Extra environment (`WHOMBAT_FEEDBACK=off`). */
  env?: Record<string, string>;
}

/** The production configuration every run uses (only secrets and the database differ between runs). */
export function productionEnv(
  port: number,
  dbUrl: string,
  secrets: Secrets,
  appDir: string | null = null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Nothing from the calling shell may change what is tested.
  for (const key of Object.keys(env)) if (key.startsWith('WHOMBAT_') || key === 'SMTP_URL') delete env[key];
  return {
    ...env,
    NODE_ENV: 'production',
    DATABASE_URL: dbUrl,
    HOST: '127.0.0.1',
    PORT: String(port),
    PUBLIC_URL: `http://localhost:${port}`,
    WHOMBAT_MASTER_KEY: secrets.masterKey,
    WHOMBAT_HOME: secrets.home,
    RUNNER_TOKEN: secrets.runnerToken,
    WHOMBAT_GITHUB: 'off',
    WHOMBAT_GOOGLE: 'off',
    SMTP_URL: 'off',
    // A release finds its web app and widget itself (WHOMBAT_APP_DIR, set by its bundle); a checkout is told.
    ...(appDir
      ? {}
      : {
          WHOMBAT_WIDGET_DIST: join(REPO, 'apps/widget/dist'),
          WHOMBAT_WEB_DIST: join(REPO, 'apps/web/dist'),
        }),
  };
}

export interface Secrets {
  masterKey: string;
  runnerToken: string;
  /**
   * The run's own WHOMBAT_HOME (attachments, packs, workspaces): never the shared `~/.whombat`, whose files another
   * server's attachment sweep could delete mid-run (and where this run's blobs would stay behind).
   */
  home: string;
}

export function newSecrets(): Secrets {
  const home = join(LOG_DIR, `home-${randomBytes(4).toString('hex')}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    masterKey: randomBytes(32).toString('base64'),
    runnerToken: randomBytes(24).toString('hex'),
    home,
  };
}

export class Whombat {
  readonly origin: string;
  private child: ChildProcess | null = null;
  readonly logFile: string;

  /**
   * `appDir`: an unpacked release (`pnpm package`) whose `app/server.mjs` runs instead of the checkout's
   * `src/index.ts`; host scripts (seed, login-link) still come from the checkout of the same commit.
   */
  constructor(
    readonly port: number,
    readonly env: NodeJS.ProcessEnv,
    readonly appDir: string | null = null,
  ) {
    this.origin = `http://localhost:${port}`;
    mkdirSync(LOG_DIR, { recursive: true });
    this.logFile = join(LOG_DIR, `server-${port}.log`);
  }

  async start(): Promise<void> {
    const log = createWriteStream(this.logFile, { flags: 'w' });
    const [args, cwd] = this.appDir
      ? [[join(this.appDir, 'app/server.mjs')], this.appDir]
      : [['--import', 'tsx', 'src/index.ts'], SERVER_DIR];
    const child = spawn(process.execPath, args, {
      cwd,
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      if (child.exitCode !== null)
        throw new Error(`the server exited ${child.exitCode} (see ${this.logFile})`);
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/api/v1/health`);
        if (res.ok && ((await res.json()) as { ok?: boolean }).ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`the server didn’t become healthy (see ${this.logFile})`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        r();
      }, 8000);
      child.once('exit', () => {
        clearTimeout(t);
        r();
      });
    });
  }

  /** A one-time host sign-in link (`pnpm login-link <email>`: what an operator runs without email). */
  async loginLink(email: string): Promise<string> {
    const out = await runScript(['src/scripts/login-link.ts', email, '--json'], this.env);
    return (JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as { link: string }).link;
  }

  /** Signs `email` in as a mobile client: a bearer token for the internal API. */
  async signIn(email: string): Promise<Session> {
    const link = new URL(await this.loginLink(email));
    const res = await fetch(`${this.origin}/api/v1/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: link.searchParams.get('token'), client: 'mobile', deviceName: 'fb-e2e' }),
    });
    if (!res.ok) throw new Error(`sign-in for ${email}: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { token: string };
    return new Session(this.origin, body.token);
  }
}

export class Session {
  constructor(
    readonly origin: string,
    readonly token: string,
  ) {}

  async call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T }> {
    const res = await fetch(`${this.origin}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json: json as T };
  }

  async get<T = unknown>(path: string): Promise<T> {
    const { status, json } = await this.call<T>('GET', path);
    if (status !== 200) throw new Error(`GET ${path}: ${status} ${JSON.stringify(json)}`);
    return json;
  }

  /** Raw bytes (attachments). */
  async fetchRaw(url: string): Promise<Response> {
    return fetch(new URL(url, this.origin), { headers: { authorization: `Bearer ${this.token}` } });
  }
}
