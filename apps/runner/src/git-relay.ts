/**
 * GitHub over git's https in an agent's shell, through Whombat (docs/decisions/resourceful-agents.md RA-DS72…RA-DS74):
 * the runner's side of `git-remote-whombat`, served on the turn's gh socket (agent-gh.md AGH-02) beside the stand-in gh.
 *
 * - `probe`: is this URL a GitHub repository? Then the turn's fetch credential is asked for once (`runner.gitCredentials`,
 *   operation `fetch`: the same keys decision and the same GitHub sign-in as a run checkout's fetch, G-14, RA-DS51) and
 *   kept for the turn; the answer is `whombat`. A repository not switched on yet (`DispatchContext.gh.repos`,
 *   case-insensitive) is asked for too: the server adds it for agents when the burrow's GitHub connection reaches it
 *   (Whombat agent-repos.md AGR-01). A refusal is `direct` — git's own transport, as without this — with the words to
 *   show if that fails.
 * - `upload-pack`: one fetch. The runner runs its own `git remote-https <the repository's GitHub URL>` with the token in
 *   that process's environment only (`http.extraHeader`, exactly how a run checkout's git gets it), says
 *   `stateless-connect git-upload-pack` to it, and relays the agent's git and it both ways in frames. Nothing else is
 *   ever said to it, so a push can't be made through it (GitHub's upload-pack only serves reads), and the token never
 *   reaches the agent's sandbox or its commands.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { devNull } from 'node:os';
import { dirname, join } from 'node:path';
import { encodeFrame, FRAME, type Frame, FrameDecoder, jsonFrame } from '@whombat/commands/frames';
import type { RunnerLease } from '@whombat/core';
import { type RunnerApi, RunnerApiError } from './api';

type Log = (level: 'error' | 'warn' | 'info' | 'debug', msg: string, extra?: Record<string, unknown>) => void;

/** Where repositories are fetched from. */
export const GITHUB_BASE = 'https://github.com/';
/** A credential is asked for again this long before the server's `expiresAt`. */
const REFRESH_MS = 5 * 60_000;
/** At most this many fetches of one turn at once. */
const SESSIONS_MAX = 8;
/** What is held before git's greeting: the agent's git says nothing until then, and the greeting is one line. */
const BEFORE_GREETING_MAX = 1024 * 1024;

/** Variables the runner's git may need to reach GitHub at all (a proxy, the system's CA bundle); no secrets. */
const PASS_ENV = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'GIT_SSL_CAINFO',
] as const;

/**
 * Replaces `secrets` with `***` in output that arrives in chunks, a secret split between two chunks too: the end of a
 * chunk that could be the start of a secret is held back until the next chunk (or `end`) shows what it is.
 */
export function streamRedactor(secrets: readonly string[]): { push(chunk: Buffer): Buffer; end(): Buffer } {
  // The longest first, so a shorter one inside it can't break it up.
  const forms = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  let held = '';
  return {
    push(chunk) {
      let s = held + chunk.toString('latin1');
      for (const f of forms) s = s.split(f).join('***');
      let keep = 0;
      for (const f of forms)
        for (let k = Math.min(f.length - 1, s.length); k > keep; k--)
          if (s.endsWith(f.slice(0, k))) {
            keep = k;
            break;
          }
      held = s.slice(s.length - keep);
      return Buffer.from(s.slice(0, s.length - keep), 'latin1');
    },
    end() {
      const rest = Buffer.from(held, 'latin1');
      held = '';
      return rest;
    },
  };
}

/** What the agent sees when GitHub can't be had through Whombat (after the transport git falls back to, or alone). */
export const GIT_LINES = {
  notGitHub: (url: string) =>
    `Whombat’s git transport is for GitHub repositories (https://github.com/owner/name); ${url} isn’t one.`,
  notSwitchedOn: (repo: string) =>
    `${repo} isn’t a repository this Whombat’s GitHub sign-in reaches, so git reached it without Whombat’s GitHub sign-in.`,
  version:
    'GitHub didn’t answer in git’s protocol version 2, which is the only way Whombat fetches from it. Try again in a moment.',
  busy: 'Too many git fetches of this turn at once: wait for one to finish.',
  over: 'This turn is over.',
} as const;

/** A request of `git-remote-whombat` (the first line of its connection). */
export interface GitRequest {
  v: 1;
  git: 'probe' | 'upload-pack';
  url: string;
}

export function isGitRequest(raw: unknown): raw is GitRequest {
  const r = raw as Partial<GitRequest> | null;
  return (
    !!r &&
    typeof r === 'object' &&
    r.v === 1 &&
    (r.git === 'probe' || r.git === 'upload-pack') &&
    typeof r.url === 'string' &&
    r.url.length <= 2048
  );
}

/** `owner/name` of a GitHub repository URL (`https://github.com/owner/name[.git]`), or null (whombat-git.mjs's rule). */
export function githubRepoOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com') return null;
  if (u.username || u.password || (u.port && u.port !== '443') || u.search || u.hash) return null;
  const parts = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = parts[0] as string;
  const raw = parts[1] as string;
  const name = raw.endsWith('.git') ? raw.slice(0, -4) : raw;
  const ok = (s: string) => /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..';
  return ok(owner) && ok(name) ? `${owner}/${name}` : null;
}

/** The repository's canonical name among those switched on for agents (`gh.repos`), or null (not switched on yet). */
export function switchedOn(repos: readonly string[], name: string): string | null {
  const want = name.toLowerCase();
  return repos.find((r) => r.toLowerCase() === want) ?? null;
}

export interface GitRelayDeps {
  api: Pick<RunnerApi, 'gitCredentials'>;
  log: Log;
  /** The runner's private temp root: each fetch's git gets a fresh 0700 home there. */
  tmpRoot: string;
  /** The runner's git (`git` on its `PATH`). */
  gitBin?: string;
  /** The runner's environment (`PATH` and `PASS_ENV` for git). */
  env?: NodeJS.ProcessEnv;
  /** Where a credential's `remoteUrl` must point (tests: a local smart-HTTP server). Default GitHub. */
  remoteBase?: string;
}

export interface GitRelayTurn {
  dispatchId: string;
  lease: RunnerLease;
  /** The repositories switched on for agents (`DispatchContext.gh.repos`). */
  repos: readonly string[];
}

interface Credential {
  token: string;
  expiresAt: string;
  remoteUrl: string;
}

export type ProbeReply =
  | { ok: true; via: 'whombat'; repo: string }
  | { ok: true; via: 'direct'; note?: string }
  | { ok: false; error: string };

/** Why a credential couldn't be had, in the agent's words: the server's own sentence where it gave one. */
function whyNot(err: unknown, repo: string): string {
  if (err instanceof RunnerApiError) {
    if (err.status === 501) return 'GitHub isn’t switched on for this Whombat.';
    if (err.status === 404) return GIT_LINES.notSwitchedOn(repo);
    return err.message;
  }
  return `Whombat couldn’t ask for GitHub (${err instanceof Error ? err.message : String(err)}).`;
}

export class GitRelay {
  readonly #deps: GitRelayDeps;
  readonly #t: GitRelayTurn;
  readonly #creds = new Map<string, Promise<Credential>>();
  readonly #children = new Set<ChildProcess>();
  #closed = false;

  constructor(deps: GitRelayDeps, turn: GitRelayTurn) {
    this.#deps = deps;
    this.#t = turn;
  }

  /** The turn's fetch credential for a repository: asked for once, again shortly before it runs out. */
  #credential(repo: string): Promise<Credential> {
    const cached = this.#creds.get(repo);
    if (cached) {
      const fresh = cached.then((c) => (Date.parse(c.expiresAt) - REFRESH_MS > Date.now() ? c : null));
      return fresh.then((c) => c ?? this.#ask(repo));
    }
    return this.#ask(repo);
  }

  #ask(repo: string): Promise<Credential> {
    const t = this.#t;
    const asked = this.#deps.api
      .gitCredentials(t.dispatchId, { repo, branch: 'HEAD', operation: 'fetch', ...t.lease })
      .then((c) => {
        if (!this.#remoteAllowed(c.remoteUrl))
          throw new Error(`the server named ${c.remoteUrl}, not a GitHub repository`);
        return c;
      });
    this.#creds.set(repo, asked);
    // A refusal isn't kept: the next fetch asks again (a person may have connected GitHub meanwhile).
    asked.catch(() => {
      if (this.#creds.get(repo) === asked) this.#creds.delete(repo);
    });
    return asked;
  }

  #remoteAllowed(url: string): boolean {
    const base = this.#deps.remoteBase ?? GITHUB_BASE;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    return (
      url.startsWith(base) && !u.username && !u.password && (u.protocol === 'https:' || base !== GITHUB_BASE)
    );
  }

  /** Whether the runner fetches this URL for the agent, or git's own transport does (and what to say if it fails). */
  async probe(url: string): Promise<ProbeReply> {
    const name = githubRepoOf(url);
    if (!name) return { ok: false, error: GIT_LINES.notGitHub(url) };
    const repo = switchedOn(this.#t.repos, name) ?? name;
    if (this.#closed) return { ok: true, via: 'direct', note: GIT_LINES.over };
    try {
      await this.#credential(repo);
      return { ok: true, via: 'whombat', repo };
    } catch (err) {
      const note = whyNot(err, repo);
      this.#deps.log('warn', `git ${repo}: no GitHub through Whombat: ${note}`, {
        dispatchId: this.#t.dispatchId,
      });
      // A public repository still comes without the sign-in.
      return { ok: true, via: 'direct', note };
    }
  }

  /** One fetch (`stateless-connect git-upload-pack`), relayed in frames until the runner's git exits. */
  async session(socket: Socket, url: string, rest: Buffer): Promise<void> {
    const t = this.#t;
    const say = (line: string) => {
      if (!socket.destroyed) socket.write(encodeFrame(FRAME.stderr, `whombat: ${line}\n`));
    };
    const exit = (code: number) => {
      if (!socket.destroyed) socket.end(jsonFrame(FRAME.exit, { code, signal: null }));
    };
    /** Refused before git runs: the socket reads on (so it can close) and says why. */
    const refuse = (line: string) => {
      socket.resume();
      say(line);
      exit(128);
    };
    const name = githubRepoOf(url);
    if (!name) return refuse(GIT_LINES.notGitHub(url));
    const repo = switchedOn(t.repos, name) ?? name;
    if (this.#closed) return refuse(GIT_LINES.over);
    if (this.#children.size >= SESSIONS_MAX) return refuse(GIT_LINES.busy);
    let cred: Credential;
    try {
      cred = await this.#credential(repo);
    } catch (err) {
      return refuse(whyNot(err, repo));
    }
    if (socket.destroyed || this.#closed) return refuse(GIT_LINES.over);
    try {
      await this.#relay(socket, repo, cred, say, exit, rest);
    } catch (err) {
      this.#deps.log('warn', `git fetch of ${repo} failed: ${String(err)}`, { dispatchId: t.dispatchId });
      refuse(`Whombat couldn’t fetch ${repo} (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  /** The runner's git for one fetch, relayed both ways (its stdout only after its greeting). */
  async #relay(
    socket: Socket,
    repo: string,
    cred: Credential,
    say: (line: string) => void,
    exit: (code: number) => void,
    rest: Buffer,
  ): Promise<void> {
    const t = this.#t;
    const deps = this.#deps;
    await mkdir(deps.tmpRoot, { recursive: true, mode: 0o700 });
    const runs = join(deps.tmpRoot, 'git-runs');
    await mkdir(runs, { recursive: true, mode: 0o700 });
    const home = await mkdtemp(join(runs, 'f-'));
    await chmod(home, 0o700);
    const scheme = new URL(cred.remoteUrl).protocol.slice(0, -1);
    const child = spawn(deps.gitBin ?? 'git', [`remote-${scheme}`, cred.remoteUrl, cred.remoteUrl], {
      cwd: home,
      env: this.#env(cred.token, home),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    this.#children.add(child);
    const started = Date.now();
    // The token as it is and as git's Basic header carries it.
    const redactor = streamRedactor([
      cred.token,
      Buffer.from(`x-access-token:${cred.token}`).toString('base64'),
    ]);
    const toAgentStderr = (data: Buffer) => {
      if (data.length && !socket.destroyed) socket.write(encodeFrame(FRAME.stderr, data));
    };
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    child.stdin.on('error', () => {});
    // Only after git's first answer — the blank line that opens the connection — does anything of the agent's reach it.
    let greeted = false;
    let greeting = Buffer.alloc(0);
    const queued: Frame[] = [];
    let queuedBytes = 0;
    const toChild = (f: Frame) => {
      if (f.type === FRAME.eof) child.stdin.end();
      else if (f.type === FRAME.stdin && !child.stdin.writableEnded && !child.stdin.write(f.payload)) {
        socket.pause();
        child.stdin.once('drain', () => socket.resume());
      }
    };
    const decoder = new FrameDecoder();
    const onFrames = (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = decoder.push(chunk);
      } catch {
        kill();
        socket.destroy();
        return;
      }
      for (const f of frames) {
        if (f.type !== FRAME.stdin && f.type !== FRAME.eof) continue;
        if (greeted) {
          toChild(f);
          continue;
        }
        queuedBytes += f.payload.length;
        if (queuedBytes > BEFORE_GREETING_MAX) {
          kill();
          socket.destroy();
          return;
        }
        queued.push(f);
      }
    };
    socket.on('data', onFrames);
    socket.on('close', kill);
    const toAgent = (data: Buffer) => {
      if (!socket.destroyed && !socket.write(encodeFrame(FRAME.stdout, data))) {
        child.stdout.pause();
        socket.once('drain', () => child.stdout.resume());
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (greeted) return toAgent(chunk);
      greeting = Buffer.concat([greeting, chunk]);
      const nl = greeting.indexOf(10);
      if (nl < 0 && greeting.length <= BEFORE_GREETING_MAX) return;
      if (nl !== 0) {
        // `fallback` (GitHub answered without protocol version 2) or anything else: nothing more is said to it.
        kill();
        say(GIT_LINES.version);
        return;
      }
      greeted = true;
      toAgent(greeting);
      for (const f of queued.splice(0)) toChild(f);
    });
    child.stderr.on('data', (chunk: Buffer) => toAgentStderr(redactor.push(chunk)));
    child.stderr.on('end', () => toAgentStderr(redactor.end()));
    if (rest.length) onFrames(rest);
    socket.resume();
    child.stdin.write('stateless-connect git-upload-pack\n');
    const code = await new Promise<number>((resolve) => {
      child.on('error', (err) => {
        say(`Whombat’s git couldn’t start (${(err as NodeJS.ErrnoException).code ?? err.message}).`);
        resolve(128);
      });
      child.on('close', (c, signal) => resolve(c ?? (signal ? 128 + 9 : 128)));
    });
    this.#children.delete(child);
    socket.off('close', kill);
    await rm(home, { recursive: true, force: true }).catch(() => {});
    deps.log('info', `git fetch of ${repo} through Whombat: exit ${code} (${Date.now() - started} ms)`, {
      dispatchId: t.dispatchId,
    });
    exit(greeted ? code : 128);
  }

  /** The runner's git: no system or global config, no prompts or helpers, the token in one header (G-14). */
  #env(token: string, home: string): NodeJS.ProcessEnv {
    const env = this.#deps.env ?? process.env;
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    const out: NodeJS.ProcessEnv = {
      PATH: env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      LANG: 'C.UTF-8',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CEILING_DIRECTORIES: dirname(home),
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'http.extraHeader',
      GIT_CONFIG_VALUE_1: `Authorization: Basic ${basic}`,
      GIT_CONFIG_KEY_2: 'protocol.version',
      GIT_CONFIG_VALUE_2: '2',
    };
    for (const k of PASS_ENV) if (env[k]) out[k] = env[k];
    return out;
  }

  /** The turn is over: running fetches stopped, nothing more is asked. */
  close(): void {
    this.#closed = true;
    for (const c of this.#children) {
      try {
        if (c.pid) process.kill(-c.pid, 'SIGKILL');
      } catch {}
    }
    this.#children.clear();
  }
}
