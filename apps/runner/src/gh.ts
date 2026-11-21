/**
 * The runner's gh service of one turn (docs/decisions/agent-gh.md AGH-02, AGH-03, AGH-10, AGH-15): the stand-in `gh`
 * in the agent's shell (`whombat-gh`) sends each command here as one JSON line; the service adds the dispatch's lease,
 * asks the server (`runner.ghAuthorize`) and either relays Whombat's own answer (`done`) or runs the real gh with the
 * token the server handed out (`run`) — outside the agent's sandbox, with `execFile`-style arguments (no shell), only
 * the server's words, a minimal environment and a fresh 0700 directory the command's files are written to again — and
 * answers one JSON line `{exitCode, stdout, stderr}` (base64). The token is only in that process's environment and is
 * replaced by `***` wherever gh prints it.
 *
 * Where it listens: a unix socket in the turn's folder of its commands' place (one-person.md OP-S111), which every
 * command of the turn sees at `/run/whombat/gh.sock` (`WHOMBAT_GH_SOCKET`); nothing else of the pod reaches it.
 *
 * The same socket serves git's GitHub transport (`git-remote-whombat`, resourceful-agents.md RA-DS72): a first line
 * `{v: 1, git: …}` goes to the turn's `GitRelay`, which fetches from GitHub for the agent's git without giving it the
 * token.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  type DispatchContext,
  GH_ARG_MAX,
  GH_ARGS_MAX,
  GH_FILES_MAX,
  GH_INPUT_MAX_BYTES,
  GhAuthorizeBody,
  type GhAuthorizeReply,
  type GhDispatchContext,
  type RunnerLease,
} from '@whombat/core';
import type { RunnerApi } from './api';
import { GitRelay, isGitRequest } from './git-relay';

type Log = (level: 'error' | 'warn' | 'info' | 'debug', msg: string, extra?: Record<string, unknown>) => void;

/** How long one gh command may run (AGH-10, `WHOMBAT_GH_TIMEOUT_MS`). */
export const GH_TIMEOUT_MS = 5 * 60_000;
/** What is kept of gh's output (AGH-10); the rest is cut with a line saying so. */
export const GH_STDOUT_MAX = 8 * 1024 * 1024;
export const GH_STDERR_MAX = 1024 * 1024;
/** A timed-out command's exit status (like `timeout(1)`). */
export const GH_EXIT_TIMED_OUT = 124;
/** The largest request line the service reads: the contracts' words and files, base64 (AGH-08). */
const REQUEST_MAX = GH_ARGS_MAX * GH_ARG_MAX + Math.ceil((GH_INPUT_MAX_BYTES * 4) / 3) + 64 * 1024;
/** A unix socket's path has at most 107 bytes. */

/** What the agent's gh prints for errors of the server (AGH-15). */
export const GH_TURN_OVER = 'This turn is over.';
export const GH_UNAVAILABLE = 'gh through Whombat isn’t available on this Whombat yet.';

/** Variables of the runner gh may need to reach GitHub at all (a proxy, the system's CA bundle); no secrets. */
const PASS_ENV = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

/**
 * The turn's gh (AGH-12): only a managed live turn the server gave one, and never an assessment, a search answer or a
 * read-only checkout (the server leaves those out already; the runner doesn't take them on trust).
 */
export function ghContextOf(ctx: DispatchContext): GhDispatchContext | null {
  const gh = ctx.gh ?? null;
  // No switched-on repository yet is fine: the server adds one the burrow's connection reaches (agent-repos.md AGR-01).
  if (!gh) return null;
  if (
    ctx.dispatch.trigger === 'feedback' ||
    ctx.dispatch.mode === 'answer' ||
    ctx.workspace?.access === 'read'
  )
    return null;
  return gh;
}

/** The real gh and its time limit from the runner's environment (`WHOMBAT_GH_PATH`, `WHOMBAT_GH_TIMEOUT_MS`). */
export function ghSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  ghBin: string;
  timeoutMs: number;
} {
  const ms = Number(env.WHOMBAT_GH_TIMEOUT_MS);
  return {
    ghBin: env.WHOMBAT_GH_PATH?.trim() || 'gh',
    timeoutMs: Number.isInteger(ms) && ms > 0 ? ms : GH_TIMEOUT_MS,
  };
}

export interface GhServiceDeps {
  /** `ghAuthorize` for gh; `gitCredentials` for git's GitHub transport (without it, git goes its own way). */
  api: Required<Pick<RunnerApi, 'ghAuthorize'>> & Partial<Pick<RunnerApi, 'gitCredentials'>>;
  log: Log;
  /** The runner's private temp root: run directories (and a sandbox turn's socket) go there. */
  tmpRoot: string;
  /** The real gh (`WHOMBAT_GH_PATH`, else `gh` on `PATH`). */
  ghBin?: string;
  /** `WHOMBAT_GH_TIMEOUT_MS` (default 5 minutes). */
  timeoutMs?: number;
  /** The runner's environment (`PATH` and `PASS_ENV` for gh; default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** The runner's git for git's GitHub transport (`git` on its `PATH`). */
  gitBin?: string;
  /** Where the transport's fetches may go (tests: a local server; default GitHub). */
  gitRemoteBase?: string;
}

export interface GhTurn {
  dispatchId: string;
  /** The dispatch's lease (`leaseOf`), sent with every command. */
  lease: RunnerLease;
  /** The repositories switched on for agents (`DispatchContext.gh.repos`): what git's GitHub transport fetches. */
  repos?: readonly string[];
}

/** One reply line for the stand-in. */
function replyLine(exitCode: number, stdout: Buffer | string, stderr: Buffer | string): string {
  const b64 = (x: Buffer | string) => (typeof x === 'string' ? Buffer.from(x) : x).toString('base64');
  return `${JSON.stringify({ exitCode, stdout: b64(stdout), stderr: b64(stderr) })}\n`;
}

/** The words of a `run` answer with the placeholders turned into the files written in `dir` (AGH-08). */
export function rewriteArgs(args: readonly string[], dir: string, files: number): string[] | null {
  const path = (n: string): string | null => {
    const i = Number(n);
    return Number.isInteger(i) && i >= 0 && i < files ? join(dir, `f${i}`) : null;
  };
  const out: string[] = [];
  for (const word of args) {
    let m = /^@whombat-file:(\d+)$/.exec(word);
    if (m) {
      const p = path(m[1] as string);
      if (!p) return null;
      out.push(p);
      continue;
    }
    // A gh api field (`body=@@whombat-file:0` → `body=@<path>`), a `--flag=value` and an attached short flag.
    m = /^(.*=@)@whombat-file:(\d+)$/.exec(word) ?? /^(.*=|-[A-Za-z])@whombat-file:(\d+)$/.exec(word);
    if (m) {
      const p = path(m[2] as string);
      if (!p) return null;
      out.push(`${m[1]}${p}`);
      continue;
    }
    out.push(word);
  }
  return out;
}

/** Output kept to `max` bytes (after the token is replaced, so a token on the edge is never half kept). */
class Capture {
  readonly #chunks: Buffer[] = [];
  #size = 0;
  #dropped = false;
  constructor(readonly max: number) {}
  push(chunk: Buffer, slack: number): void {
    const room = this.max + slack - this.#size;
    if (room <= 0) {
      this.#dropped = true;
      return;
    }
    if (chunk.length > room) this.#dropped = true;
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.#chunks.push(kept);
    this.#size += kept.length;
  }
  /** The output with every `token` replaced, cut to `max` with a line saying so. */
  text(token: string, what: string): Buffer {
    let bytes = Buffer.concat(this.#chunks);
    if (token) bytes = Buffer.from(bytes.toString('latin1').split(token).join('***'), 'latin1');
    if (!this.#dropped && bytes.length <= this.max) return bytes;
    return Buffer.concat([
      bytes.subarray(0, this.max),
      Buffer.from(`\n[Whombat cut gh’s ${what} here: it keeps at most ${this.max / 1024 / 1024} MiB.]\n`),
    ]);
  }
}

export class GhService {
  /** The socket the stand-in connects to (bound at `/run/whombat/gh.sock` in the turn's commands). */
  readonly socket: string;
  readonly #deps: GhServiceDeps;
  readonly #t: GhTurn;
  /** What `close` removes: the service's own directory, and a short link folder for a long socket path. */
  readonly #remove: string[];
  readonly #sockets = new Set<Socket>();
  readonly #children = new Set<ReturnType<typeof spawn>>();
  readonly #abort = new AbortController();
  /** git's GitHub transport (RA-DS72), when the API can hand out a fetch credential and the turn has repositories. */
  readonly #git: GitRelay | null;
  #server: Server | null = null;
  #closing: Promise<void> | null = null;

  private constructor(deps: GhServiceDeps, t: GhTurn, socket: string, remove: string[]) {
    this.#deps = deps;
    this.#t = t;
    this.socket = socket;
    this.#remove = remove;
    const gitCredentials = deps.api.gitCredentials?.bind(deps.api);
    this.#git =
      gitCredentials && t.repos?.length
        ? new GitRelay(
            {
              api: { gitCredentials },
              log: deps.log,
              tmpRoot: deps.tmpRoot,
              ...(deps.gitBin ? { gitBin: deps.gitBin } : {}),
              ...(deps.env ? { env: deps.env } : {}),
              ...(deps.gitRemoteBase ? { remoteBase: deps.gitRemoteBase } : {}),
            },
            { dispatchId: t.dispatchId, lease: t.lease, repos: t.repos },
          )
        : null;
  }

  /**
   * Starts the turn's service in `dir` (the turn's folder of its commands' place, which every command of the turn sees
   * at `/run/whombat/gh.sock`); throws when it can't listen (what was made by then is removed).
   */
  static async open(deps: GhServiceDeps, t: GhTurn, dir: string): Promise<GhService> {
    const service = new GhService(deps, t, join(dir, 'gh.sock'), [join(dir, 'gh.sock')]);
    try {
      await service.#listen(0o600);
    } catch (err) {
      await service.close();
      throw err;
    }
    return service;
  }

  async #listen(mode: number): Promise<void> {
    const server = createServer((socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
      socket.on('error', () => {});
      void this.#serve(socket).catch((err) => {
        this.#deps.log('warn', `a gh command failed: ${String(err)}`, { dispatchId: this.#t.dispatchId });
        if (!socket.destroyed) socket.end(replyLine(1, '', 'gh: Whombat couldn’t run this command.\n'));
      });
    });
    await rm(this.socket, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socket, () => resolve());
    });
    this.#server = server;
    await chmod(this.socket, mode);
  }

  /**
   * One command from the stand-in: one line in, one line out. Or git's GitHub transport (RA-DS72): its first line, then
   * what the relay reads itself — the socket is paused at the line's end so nothing after it is lost.
   */
  async #serve(socket: Socket): Promise<void> {
    const read = await new Promise<{ line: string; rest: Buffer } | null>((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const onData = (c: Buffer) => {
        const nl = c.indexOf(10);
        const part = nl < 0 ? c : c.subarray(0, nl);
        size += part.length;
        if (size > REQUEST_MAX) {
          socket.off('data', onData);
          resolve(null);
          return;
        }
        chunks.push(part);
        if (nl >= 0) {
          socket.off('data', onData);
          socket.pause();
          resolve({ line: Buffer.concat(chunks).toString('utf8'), rest: c.subarray(nl + 1) });
        }
      };
      socket.on('data', onData);
      socket.once('close', () => resolve(null));
    });
    if (socket.destroyed) return;
    const line = read?.line ?? null;
    let raw: unknown;
    try {
      raw = line === null ? null : JSON.parse(line);
    } catch {
      raw = null;
    }
    if (this.#git && isGitRequest(raw)) {
      if (raw.git === 'probe') {
        socket.resume();
        const answer = await this.#git.probe(raw.url);
        if (!socket.destroyed) socket.end(`${JSON.stringify(answer)}\n`);
        return;
      }
      return this.#git.session(socket, raw.url, read?.rest ?? Buffer.alloc(0));
    }
    // A gh command reads nothing more: the socket reads on, so it closes when the stand-in goes.
    socket.resume();
    const say = (exitCode: number, stdout: Buffer | string, stderr: Buffer | string) => {
      if (!socket.destroyed) socket.end(replyLine(exitCode, stdout, stderr));
    };
    const t = this.#t;
    const parsed = GhAuthorizeBody.safeParse({ ...(raw as object), ...t.lease });
    const bytes = parsed.success
      ? parsed.data.files.reduce((n, f) => n + Buffer.byteLength(f.base64, 'base64'), 0) +
        (parsed.data.stdin ? Buffer.byteLength(parsed.data.stdin, 'base64') : 0)
      : 0;
    if (!parsed.success || raw === null || typeof raw !== 'object')
      return say(1, '', 'gh: Whombat couldn’t read this command.\n');
    if (parsed.data.files.length > GH_FILES_MAX || bytes > GH_INPUT_MAX_BYTES)
      return say(
        1,
        '',
        'gh: the files and input of this command come to more than Whombat takes (1 MiB, 8 files).\n',
      );
    const body = parsed.data;
    let reply: GhAuthorizeReply;
    try {
      reply = await this.#deps.api.ghAuthorize(t.dispatchId, body, this.#abort.signal);
    } catch (err) {
      if (this.#abort.signal.aborted) return say(1, '', `gh: ${GH_TURN_OVER}\n`);
      const status = (err as { status?: number }).status;
      const message =
        status === 409
          ? GH_TURN_OVER
          : status === 404
            ? GH_UNAVAILABLE
            : err instanceof Error
              ? err.message
              : String(err);
      this.#deps.log('warn', `gh ${body.args[0] ?? ''}: the server refused (${status ?? 'no answer'})`, {
        dispatchId: t.dispatchId,
      });
      return say(1, '', `gh: ${message}\n`);
    }
    if (reply.outcome === 'done') return say(reply.exitCode, reply.stdout, reply.stderr);
    const ran = await this.#run(reply, body);
    say(ran.exitCode, ran.stdout, ran.stderr);
  }

  /** The real gh, as the server decided (AGH-03, AGH-10). */
  async #run(
    reply: Extract<GhAuthorizeReply, { outcome: 'run' }>,
    body: GhAuthorizeBody,
  ): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> {
    const deps = this.#deps;
    const env = deps.env ?? process.env;
    const token = reply.token;
    const fail = (line: string) => ({
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(`gh: ${line.split(token).join('***')}\n`),
    });
    await mkdir(deps.tmpRoot, { recursive: true, mode: 0o700 });
    const runs = join(deps.tmpRoot, 'gh-runs');
    await mkdir(runs, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(runs, `${randomBytes(3).toString('hex')}-`));
    try {
      await chmod(dir, 0o700);
      const config = join(dir, '.gh');
      await mkdir(config, { mode: 0o700 });
      for (const [i, f] of body.files.entries())
        await writeFile(join(dir, `f${i}`), Buffer.from(f.base64, 'base64'), { mode: 0o600 });
      const args = rewriteArgs(reply.args, dir, body.files.length);
      if (!args) return fail('Whombat’s answer named a file the command didn’t send.');
      const ghEnv: Record<string, string> = {
        PATH: env.PATH ?? '/usr/bin:/bin',
        HOME: dir,
        GH_CONFIG_DIR: config,
        GH_TOKEN: token,
        GH_HOST: 'github.com',
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        GH_SPINNER_DISABLED: '1',
        NO_COLOR: '1',
        CLICOLOR: '0',
        GH_PAGER: 'cat',
        PAGER: 'cat',
        LANG: 'C.UTF-8',
        ...(reply.repo ? { GH_REPO: reply.repo } : {}),
      };
      for (const k of PASS_ENV) if (env[k]) ghEnv[k] = env[k] as string;
      const out = new Capture(GH_STDOUT_MAX);
      const err = new Capture(GH_STDERR_MAX);
      const slack = Buffer.byteLength(token);
      const timeoutMs = deps.timeoutMs ?? GH_TIMEOUT_MS;
      const result = await new Promise<{
        code: number | null;
        signal: string | null;
        timedOut: boolean;
        error?: Error;
      }>((resolve) => {
        const child = spawn(deps.ghBin ?? 'gh', args, {
          cwd: dir,
          env: ghEnv,
          stdio: [body.stdin !== null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          detached: true,
        });
        this.#children.add(child);
        let timedOut = false;
        const kill = (sig: NodeJS.Signals) => {
          try {
            if (child.pid) process.kill(-child.pid, sig);
          } catch {
            child.kill(sig);
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          kill('SIGTERM');
          setTimeout(() => kill('SIGKILL'), 2000).unref();
        }, timeoutMs);
        child.stdout?.on('data', (c: Buffer) => out.push(c, slack));
        child.stderr?.on('data', (c: Buffer) => err.push(c, slack));
        if (child.stdin) {
          child.stdin.on('error', () => {});
          child.stdin.end(Buffer.from(body.stdin ?? '', 'base64'));
        }
        child.on('error', (error) => {
          clearTimeout(timer);
          this.#children.delete(child);
          resolve({ code: null, signal: null, timedOut, error });
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          this.#children.delete(child);
          resolve({ code, signal, timedOut });
        });
      });
      if (result.error)
        return fail(
          `gh couldn’t be started where Whombat runs it (${(result.error as NodeJS.ErrnoException).code ?? result.error.message}).`,
        );
      const stdout = out.text(token, 'output');
      let stderr = err.text(token, 'errors');
      if (result.timedOut) {
        stderr = Buffer.concat([
          stderr,
          Buffer.from(
            `gh: it took longer than ${Math.round(timeoutMs / 1000)} seconds, so Whombat stopped it.\n`,
          ),
        ]);
        return { exitCode: GH_EXIT_TIMED_OUT, stdout, stderr };
      }
      const signals: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
      const exitCode = result.code ?? (result.signal ? 128 + (signals[result.signal] ?? 9) : 1);
      deps.log(
        'info',
        `gh ${reply.args.slice(0, 2).join(' ')}${reply.repo ? ` · ${reply.repo}` : ''}: exit ${exitCode}`,
        {
          dispatchId: this.#t.dispatchId,
        },
      );
      return { exitCode, stdout, stderr };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** The turn is over (cancel and failure too): connections dropped, running gh stopped, the socket removed. */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#abort.abort();
      this.#git?.close();
      for (const c of this.#children) {
        try {
          if (c.pid) process.kill(-c.pid, 'SIGKILL');
        } catch {}
      }
      for (const s of this.#sockets) s.destroy();
      await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
      for (const d of this.#remove) await rm(d, { recursive: true, force: true }).catch(() => {});
    })();
    return this.#closing;
  }
}
