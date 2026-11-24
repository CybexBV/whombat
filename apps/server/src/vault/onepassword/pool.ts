/**
 * The server's side of the 1Password worker (docs/decisions/onepassword-sync.md): the worker process is started
 * when a pass or a check first needs it, stopped after 15 minutes without work, and replaced when it dies. Every call
 * has a deadline; a worker that dies or stops answering fails its calls with “1Password sync stopped unexpectedly”, and
 * the next call starts a new one.
 *
 * What the pass and the check talk to is `OnePasswordApi`: this pool in the server, an in-memory 1Password in tests
 * (`testing/fake.ts`). Answers are read through core's shapes, so a newer SDK's extra members pass through untouched and
 * a broken answer is an error, never a half-read item.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ONEPASSWORD_WORDS,
  ONEPASSWORD_WORKER_IDLE_MS,
  OnePasswordItem,
  OnePasswordItemOverview,
  type OnePasswordNewItem,
  OnePasswordVaultOverview,
} from '@whombat/core';
import { z } from 'zod';
import type { Logger } from '../../services';
import {
  ONEPASSWORD_WORKER_FLAG,
  type OnePasswordCall,
  type OnePasswordErrorKind,
  type OnePasswordReply,
} from './worker';

/** How a call to 1Password failed: the worker's kinds, and the pool's own `stopped` (the worker died or hung). */
export type OnePasswordFailure = OnePasswordErrorKind | 'stopped';

export class OnePasswordError extends Error {
  constructor(
    readonly kind: OnePasswordFailure,
    message: string,
  ) {
    super(message);
    this.name = 'OnePasswordError';
  }
}

export interface OnePasswordVaultChoice {
  id: string;
  title: string;
}

export interface OnePasswordGetAnswer {
  items: OnePasswordItem[];
  /** Ids 1Password doesn't have (any more). */
  missing: string[];
  /** Ids it couldn't read this time. */
  failed: string[];
}

/** The calls the sync and the check make. */
export interface OnePasswordApi {
  /** Signs in and lists the vaults the token can see. */
  check(token: string): Promise<{ vaults: OnePasswordVaultChoice[] }>;
  overview(token: string, vaultId: string): Promise<OnePasswordVaultOverview>;
  /** The vault's active items, without their values. */
  list(token: string, vaultId: string): Promise<OnePasswordItemOverview[]>;
  /** At most 50 items at once. */
  get(token: string, vaultId: string, itemIds: readonly string[]): Promise<OnePasswordGetAnswer>;
  create(token: string, item: OnePasswordNewItem): Promise<OnePasswordItem>;
  /** The whole item with the version it was read at; an older version is refused. */
  put(token: string, item: OnePasswordItem): Promise<OnePasswordItem>;
  /** Archives an item (never deletes it). */
  archive(token: string, vaultId: string, itemId: string): Promise<void>;
}

/** One call's deadline: a `get` of 50 items, or a sign-in, can take a while. */
export const ONEPASSWORD_CALL_TIMEOUT_MS = 60_000;

const CheckAnswer = z.object({
  vaults: z.array(z.object({ id: z.string().min(1).max(64), title: z.string().max(500) })).max(500),
});
const GetAnswer = z.object({
  items: z.array(z.unknown()),
  missing: z.array(z.string()),
  failed: z.array(z.string()),
});

/**
 * A `get`'s answer, each item read on its own: one that doesn't read is `failed` (by its id, when it has one), so one
 * odd item never fails the other 49.
 */
export function readGetAnswer(raw: unknown): OnePasswordGetAnswer {
  const answer = GetAnswer.parse(raw);
  const items: OnePasswordItem[] = [];
  const failed = [...answer.failed];
  for (const raw of answer.items) {
    const item = OnePasswordItem.safeParse(raw);
    if (item.success) items.push(item.data);
    else {
      const id = (raw as { id?: unknown } | null)?.id;
      if (typeof id === 'string' && id !== '') failed.push(id.slice(0, 64));
      else failed.push('');
    }
  }
  return { items, missing: answer.missing, failed };
}

/** The worker's module for code at `from`: the source file, or the release's own bundle next to `app/server.mjs`. */
export function onePasswordWorkerUrl(from: string = import.meta.url): URL {
  return /\.m?js$/.test(new URL(from).pathname)
    ? new URL('./onepassword-worker.mjs', from)
    : new URL('./worker.ts', from);
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: OnePasswordError) => void;
  timer: NodeJS.Timeout;
}

export interface OnePasswordPoolOptions {
  log: Logger;
  /** The worker's module (tests may start another). */
  url?: URL;
  timeoutMs?: number;
  idleMs?: number;
}

/** What the worker is started with: none of the server's environment (no master key, no database address). */
function workerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'TZ'])
    if (process.env[name]) env[name] = process.env[name];
  return env;
}

export class OnePasswordPool implements OnePasswordApi {
  readonly #log: Logger;
  readonly #url: URL;
  readonly #timeoutMs: number;
  readonly #idleMs: number;
  #child: ChildProcess | null = null;
  #buffer = '';
  #seq = 0;
  readonly #pending = new Map<number, Pending>();
  /** Tokens this worker was sent: taken out of whatever it writes to stderr. */
  #tokens = new Set<string>();
  #idle: NodeJS.Timeout | null = null;
  /** Workers started so far (tests check that a dead one was replaced). */
  started = 0;

  constructor(options: OnePasswordPoolOptions) {
    this.#log = options.log;
    this.#url = options.url ?? onePasswordWorkerUrl();
    this.#timeoutMs = options.timeoutMs ?? ONEPASSWORD_CALL_TIMEOUT_MS;
    this.#idleMs = options.idleMs ?? ONEPASSWORD_WORKER_IDLE_MS;
  }

  /** Whether a worker is running now. */
  get running(): boolean {
    return this.#child !== null;
  }

  async check(token: string) {
    return CheckAnswer.parse(await this.#call({ call: 'check', token }));
  }

  async overview(token: string, vaultId: string) {
    return OnePasswordVaultOverview.parse(await this.#call({ call: 'overview', token, vaultId }));
  }

  async list(token: string, vaultId: string) {
    return z.array(OnePasswordItemOverview).parse(await this.#call({ call: 'list', token, vaultId }));
  }

  async get(token: string, vaultId: string, itemIds: readonly string[]) {
    return readGetAnswer(await this.#call({ call: 'get', token, vaultId, itemIds: itemIds.slice(0, 50) }));
  }

  async create(token: string, item: OnePasswordNewItem) {
    return OnePasswordItem.parse(await this.#call({ call: 'create', token, item: { ...item } }));
  }

  async put(token: string, item: OnePasswordItem) {
    return OnePasswordItem.parse(await this.#call({ call: 'put', token, item: { ...item } }));
  }

  async archive(token: string, vaultId: string, itemId: string) {
    await this.#call({ call: 'archive', token, vaultId, itemId });
  }

  /** Loads the SDK in the worker, nothing else: the packaged layout's check. */
  async probe(): Promise<unknown> {
    return this.#call({ call: 'probe' });
  }

  /** Stops the worker; calls still waiting fail. */
  close(): void {
    this.#stop(new OnePasswordError('stopped', ONEPASSWORD_WORDS.stopped));
  }

  #call(request: OnePasswordCall): Promise<unknown> {
    let child: ChildProcess;
    try {
      child = this.#ensure();
    } catch {
      return Promise.reject(new OnePasswordError('stopped', ONEPASSWORD_WORDS.stopped));
    }
    if (this.#idle) {
      clearTimeout(this.#idle);
      this.#idle = null;
    }
    if ('token' in request) this.#tokens.add(request.token);
    const id = ++this.#seq;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A worker that stops answering may be stuck inside the SDK: it is replaced, and what it had fails.
        this.#log.warn({ call: request.call }, 'the 1Password worker didn’t answer in time');
        this.#stop(new OnePasswordError('stopped', ONEPASSWORD_WORDS.stopped));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin?.write(`${JSON.stringify({ id, ...request })}\n`);
    });
  }

  #ensure(): ChildProcess {
    if (this.#child) return this.#child;
    const child = spawn(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        '--max-old-space-size=256',
        fileURLToPath(this.#url),
        ONEPASSWORD_WORKER_FLAG,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], env: workerEnv() },
    );
    this.started++;
    this.#child = child;
    this.#buffer = '';
    // Idle, the worker doesn't keep the server's process alive; a waiting call's timer does.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr])
      (stream as unknown as { unref?: () => void } | null)?.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.#onData(child, chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.#onStderr(child, chunk));
    child.stdin?.on('error', () => {});
    child.on('error', (err) => this.#onDeath(child, (err as { code?: string }).code ?? 'error'));
    child.on('exit', (code, signal) => this.#onDeath(child, signal ?? String(code)));
    return child;
  }

  #onData(child: ChildProcess, chunk: string): void {
    if (child !== this.#child) return;
    this.#buffer += chunk;
    let at = this.#buffer.indexOf('\n');
    while (at >= 0) {
      const line = this.#buffer.slice(0, at);
      this.#buffer = this.#buffer.slice(at + 1);
      if (line.trim() !== '') this.#onLine(line);
      at = this.#buffer.indexOf('\n');
    }
  }

  #onLine(line: string): void {
    let reply: OnePasswordReply;
    try {
      reply = JSON.parse(line) as OnePasswordReply;
    } catch {
      this.#log.warn({}, 'the 1Password worker wrote a line that isn’t an answer');
      return;
    }
    const pending = this.#pending.get(reply.id);
    if (!pending) return;
    this.#pending.delete(reply.id);
    clearTimeout(pending.timer);
    if (reply.ok) pending.resolve(reply.result);
    else pending.reject(new OnePasswordError(reply.error.kind, reply.error.message));
    this.#idleCheck();
  }

  /**
   * What the worker writes to stderr goes to the log with every token it was sent taken out, briefly. A worker already
   * replaced is ignored: the tokens it was sent are forgotten, so its words couldn't be cleaned of them.
   */
  #onStderr(child: ChildProcess, chunk: string): void {
    if (child !== this.#child) return;
    let text = chunk;
    for (const token of this.#tokens) if (token.length >= 4) text = text.split(token).join('[hidden]');
    text = text.replace(/ops_[A-Za-z0-9+/=_-]{8,}/g, '[hidden]').trim();
    if (text !== '') this.#log.warn({ stderr: text.slice(0, 300) }, 'the 1Password worker said');
  }

  #idleCheck(): void {
    if (this.#pending.size > 0 || !this.#child) return;
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.close(), this.#idleMs);
    this.#idle.unref();
  }

  #onDeath(child: ChildProcess, how: string): void {
    if (child !== this.#child) return;
    if (this.#pending.size > 0) this.#log.warn({ how }, 'the 1Password worker stopped while it had calls');
    this.#stop(new OnePasswordError('stopped', ONEPASSWORD_WORDS.stopped));
  }

  #stop(err: OnePasswordError): void {
    const child = this.#child;
    this.#child = null;
    this.#tokens = new Set();
    if (this.#idle) {
      clearTimeout(this.#idle);
      this.#idle = null;
    }
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      this.#pending.delete(id);
      p.reject(err);
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin?.end();
      child.kill('SIGKILL');
    }
  }
}

/** The failures that mean 1Password couldn't be reached (as opposed to answering “no”). */
export function onePasswordUnreachable(err: unknown): boolean {
  return err instanceof OnePasswordError && (err.kind === 'network' || err.kind === 'stopped');
}

/** A failure's kind, or `failed` for anything that isn't the worker's. */
export function onePasswordFailureOf(err: unknown): OnePasswordFailure {
  return err instanceof OnePasswordError ? err.kind : 'failed';
}

/** The pool's error when an answer didn't parse (a Zod error), as a plain failure. */
export function asOnePasswordError(err: unknown): OnePasswordError {
  if (err instanceof OnePasswordError) return err;
  return new OnePasswordError(
    'failed',
    err instanceof z.ZodError ? 'An answer from 1Password didn’t read.' : 'It failed.',
  );
}
