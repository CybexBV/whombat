/**
 * The Claude sign-in console on the server's side (contracts 0.9.0 CT-71, SUB-02, SUB-03): the consoles of the
 * people signing in, their output and their input — nothing about the process itself, which the sign-in executor
 * runs (the runner's on a managed appliance, this process's when self-hosted).
 *
 * - One console per account and provider: a new one cancels the running one (a second tab takes over).
 * - Output: the newest `PROVIDER_CONSOLE_BUFFER_BYTES` (64 KiB) per console, read with a byte cursor and a long poll
 *   (`waitMs` ≤ 25 s); a cursor older than the buffer is answered from the oldest byte still kept (`from` > cursor).
 * - Input: numbered by `seq` from 1. A `seq` already applied is answered without typing it again (a resend after a
 *   lost answer), a gap is refused (`provider.console_input_gap`, `details.inputSeq`). Writes of one console run one
 *   at a time, in order.
 * - A console lives `PROVIDER_CONSOLE_TTL_S` (10 minutes): the relay stops it then (`expired`), and the executor stops
 *   it by itself too. Ended consoles stay listed until their `expiresAt`, so a reloaded page shows how it ended.
 *
 * Output and input may carry what the person typed (the code from claude.ai): neither is ever logged, audited or kept
 * anywhere but the in-memory buffer of this console.
 */
import { randomBytes } from 'node:crypto';
import type { ConsoleSignInEvent } from '@whombat/core/contracts';
import {
  PROVIDER_CONSOLE_BUFFER_BYTES,
  PROVIDER_CONSOLE_READ_MAX_BYTES,
  PROVIDER_CONSOLE_TTL_S,
  PROVIDER_CONSOLE_WAIT_MAX_MS,
  type ProviderConsole,
} from '@whombat/core/domain';
import { CommandStopped } from '../../commit/scope';
import { ApiError } from '../../lib/errors';
import { RunnerBridgeError } from './bridge';

export type ConsoleState = ProviderConsole['state'];

/** What the relay needs of the sign-in executor (`SignInExecutor`'s console methods). */
export interface ConsoleExecutor {
  consoleStart(job: {
    consoleId: string;
    owner: { kind: 'person'; accountId: string };
    provider: 'claude';
    authMode: 'subscription_cli';
    cols: number;
    rows: number;
    expiresAt: string;
  }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  consoleInput(
    consoleId: string,
    data: string,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  consoleResize(
    consoleId: string,
    cols: number,
    rows: number,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  consoleStop(consoleId: string, reason: 'cancelled' | 'expired'): Promise<void>;
}

interface ConsoleRecord {
  consoleId: string;
  accountId: string;
  endpointId: string | null;
  state: ConsoleState;
  exitCode: number | null;
  cols: number;
  rows: number;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  error: ProviderConsole['error'];
  /** The newest output bytes; `buffer[0]` is at offset `bufferStart`. */
  buffer: Buffer;
  bufferStart: number;
  outputBytes: number;
  inputSeq: number;
  /** Writes run one at a time, in order. */
  writes: Promise<unknown>;
  waiters: Set<() => void>;
  timer: NodeJS.Timeout | null;
}

function consoleError(
  code: string,
  message: string,
  status: ConstructorParameters<typeof ApiError>[0] = 'conflict',
  details: Record<string, unknown> = {},
) {
  return new ApiError(status, message, { details: { code, ...details } });
}

export interface ConsoleRelayOptions {
  executor: () => ConsoleExecutor;
  now: () => Date;
  /** A console completed (the CLI's own status says signed in): audit it (`provider.signed_in`). */
  onCompleted: (c: { consoleId: string; accountId: string; endpointId: string | null }) => Promise<void>;
  /** Tests: a shorter lifetime. */
  ttlMs?: number;
}

export class ConsoleRelay {
  private readonly consoles = new Map<string, ConsoleRecord>();

  constructor(private readonly options: ConsoleRelayOptions) {}

  private now(): Date {
    return this.options.now();
  }

  view(c: ConsoleRecord): ProviderConsole {
    return {
      consoleId: c.consoleId,
      provider: 'claude',
      authMode: 'subscription_cli',
      state: c.state,
      exitCode: c.exitCode,
      cols: c.cols,
      rows: c.rows,
      startedAt: c.startedAt.toISOString(),
      expiresAt: c.expiresAt.toISOString(),
      endedAt: c.endedAt ? c.endedAt.toISOString() : null,
      outputBytes: c.outputBytes,
      inputSeq: c.inputSeq,
      error: c.error,
    };
  }

  /** The console, if it is this account's (anyone else: “not found”, never a hint it exists). */
  private own(accountId: string, consoleId: string): ConsoleRecord {
    const c = this.consoles.get(consoleId);
    if (!c || c.accountId !== accountId)
      throw consoleError('provider.console_not_found', 'No sign-in console with that id.', 'not_found');
    return c;
  }

  private wake(c: ConsoleRecord): void {
    for (const w of [...c.waiters]) w();
  }

  /** Ends a console on the relay's side (the executor's exit report may follow; a finished console keeps its end). */
  private end(
    c: ConsoleRecord,
    state: Exclude<ConsoleState, 'running'>,
    error: ProviderConsole['error'],
    exitCode: number | null = null,
  ): boolean {
    if (c.state !== 'running') return false;
    c.state = state;
    c.error = error;
    c.exitCode = exitCode;
    c.endedAt = this.now();
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    this.wake(c);
    return true;
  }

  private sweep(): void {
    const now = this.now().getTime();
    for (const [id, c] of this.consoles)
      if (c.state !== 'running' && c.expiresAt.getTime() <= now && c.waiters.size === 0)
        this.consoles.delete(id);
  }

  /** The account's consoles: running ones and ended ones until they expire (`signins.list`). */
  list(accountId: string): ProviderConsole[] {
    this.sweep();
    return [...this.consoles.values()]
      .filter((c) => c.accountId === accountId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, 8)
      .map((c) => this.view(c));
  }

  /** `signins.consoleStart`: the fixed login command in a new console (the policy was checked by the caller). */
  async start(
    caller: { accountId: string; endpointId: string | null },
    input: { cols: number; rows: number },
  ): Promise<ProviderConsole> {
    this.sweep();
    // One console per account and provider: a newer one takes over.
    for (const c of this.consoles.values())
      if (c.accountId === caller.accountId && c.state === 'running') {
        this.end(c, 'cancelled', null);
        await this.options
          .executor()
          .consoleStop(c.consoleId, 'cancelled')
          .catch(() => {});
      }
    const startedAt = this.now();
    const ttlMs = this.options.ttlMs ?? PROVIDER_CONSOLE_TTL_S * 1000;
    const c: ConsoleRecord = {
      consoleId: `pcn_${randomBytes(12).toString('base64url')}`,
      accountId: caller.accountId,
      endpointId: caller.endpointId,
      state: 'running',
      exitCode: null,
      cols: input.cols,
      rows: input.rows,
      startedAt,
      expiresAt: new Date(startedAt.getTime() + ttlMs),
      endedAt: null,
      error: null,
      buffer: Buffer.alloc(0),
      bufferStart: 0,
      outputBytes: 0,
      inputSeq: 0,
      writes: Promise.resolve(),
      waiters: new Set(),
      timer: null,
    };
    this.consoles.set(c.consoleId, c);
    c.timer = setTimeout(() => void this.expire(c), ttlMs);
    c.timer.unref?.();
    let started: Awaited<ReturnType<ConsoleExecutor['consoleStart']>>;
    try {
      started = await this.options.executor().consoleStart({
        consoleId: c.consoleId,
        owner: { kind: 'person', accountId: caller.accountId },
        provider: 'claude',
        authMode: 'subscription_cli',
        cols: input.cols,
        rows: input.rows,
        expiresAt: c.expiresAt.toISOString(),
      });
    } catch (err) {
      // Neither is a failed console (CS-14): a cancelled request never started it (it ends here); a runner that took
      // it and never answered may be running it (it stays, its output still arrives, and its TTL ends it).
      if (err instanceof CommandStopped) {
        this.end(c, 'cancelled', null);
        throw err;
      }
      if (err instanceof RunnerBridgeError && err.sessionCode === 'unknown_outcome') throw err;
      started = {
        ok: false,
        code: 'provider.login_failed',
        message: err instanceof ApiError ? err.message : 'The sign-in console couldn’t start. Try again.',
      };
    }
    if (!started.ok) this.end(c, 'failed', { code: started.code, message: started.message.slice(0, 500) });
    return this.view(c);
  }

  private async expire(c: ConsoleRecord): Promise<void> {
    if (
      !this.end(c, 'expired', {
        code: 'provider.login_expired',
        message: 'This sign-in expired before it was finished. Start again.',
      })
    )
      return;
    await this.options
      .executor()
      .consoleStop(c.consoleId, 'expired')
      .catch(() => {});
  }

  /** `signins.consoleRead`: output from `cursor`, waiting up to `waitMs` for more while the console runs. */
  async read(
    accountId: string,
    consoleId: string,
    query: { cursor: number; waitMs: number },
    signal?: AbortSignal,
  ) {
    const c = this.own(accountId, consoleId);
    const waitMs = Math.min(Math.max(query.waitMs, 0), PROVIDER_CONSOLE_WAIT_MAX_MS);
    if (waitMs > 0 && c.state === 'running' && query.cursor >= c.outputBytes && !signal?.aborted)
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          c.waiters.delete(done);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        timer.unref?.();
        c.waiters.add(done);
        signal?.addEventListener('abort', done, { once: true });
      });
    const from = Math.min(Math.max(query.cursor, c.bufferStart), c.outputBytes);
    const start = from - c.bufferStart;
    const chunk = c.buffer.subarray(start, start + PROVIDER_CONSOLE_READ_MAX_BYTES);
    const next = from + chunk.length;
    return {
      console: this.view(c),
      from,
      data: chunk.toString('base64'),
      next,
      more: next < c.outputBytes,
    };
  }

  /** `signins.consoleWrite`: keystrokes, applied once per `seq`, in order. */
  write(
    accountId: string,
    consoleId: string,
    input: { seq: number; data: string },
  ): Promise<ProviderConsole> {
    const c = this.own(accountId, consoleId);
    const run = c.writes.then(async () => {
      if (input.seq <= c.inputSeq) return this.view(c);
      if (input.seq > c.inputSeq + 1)
        throw consoleError(
          'provider.console_input_gap',
          'Some keystrokes before these didn’t arrive. Send them again in order.',
          'conflict',
          { inputSeq: c.inputSeq },
        );
      if (c.state !== 'running')
        throw consoleError('provider.console_ended', 'This sign-in console has ended.', 'conflict');
      const r = await this.options.executor().consoleInput(c.consoleId, input.data);
      if (!r.ok) throw consoleError(r.code, r.message);
      c.inputSeq = input.seq;
      return this.view(c);
    });
    c.writes = run.catch(() => {});
    return run;
  }

  async resize(
    accountId: string,
    consoleId: string,
    input: { cols: number; rows: number },
  ): Promise<ProviderConsole> {
    const c = this.own(accountId, consoleId);
    if (c.state !== 'running')
      throw consoleError('provider.console_ended', 'This sign-in console has ended.', 'conflict');
    const r = await this.options.executor().consoleResize(c.consoleId, input.cols, input.rows);
    if (!r.ok) throw consoleError(r.code, r.message);
    c.cols = input.cols;
    c.rows = input.rows;
    return this.view(c);
  }

  async cancel(accountId: string, consoleId: string): Promise<ProviderConsole> {
    const c = this.own(accountId, consoleId);
    if (this.end(c, 'cancelled', null))
      await this.options
        .executor()
        .consoleStop(c.consoleId, 'cancelled')
        .catch(() => {});
    return this.view(c);
  }

  /**
   * What the executor reported (in order). Returns the ids of consoles the relay doesn't know (the runner stops them).
   * Output at an offset already kept is skipped, so a repeated report is harmless.
   */
  async events(events: readonly ConsoleSignInEvent[]): Promise<string[]> {
    const unknown = new Set<string>();
    for (const ev of events) {
      const c = this.consoles.get(ev.consoleId);
      if (!c) {
        unknown.add(ev.consoleId);
        continue;
      }
      if (ev.kind === 'output') {
        let bytes: Buffer = Buffer.from(ev.data, 'base64');
        let offset = ev.offset;
        if (offset < c.outputBytes) {
          // Already kept (a resent report): only what's new.
          bytes = bytes.subarray(Math.min(bytes.length, c.outputBytes - offset));
          offset = c.outputBytes;
        }
        if (bytes.length === 0) continue;
        if (offset > c.outputBytes) {
          // A gap the executor never filled: nothing to show for it, the cursor moves on.
          c.buffer = Buffer.alloc(0);
          c.bufferStart = offset;
        }
        c.buffer = Buffer.concat([c.buffer, bytes]);
        c.outputBytes = offset + bytes.length;
        if (c.buffer.length > PROVIDER_CONSOLE_BUFFER_BYTES) {
          const drop = c.buffer.length - PROVIDER_CONSOLE_BUFFER_BYTES;
          c.buffer = c.buffer.subarray(drop);
          c.bufferStart += drop;
        }
        this.wake(c);
        continue;
      }
      // The exit: the executor decided the state (completed only after the CLI's own status said signed in).
      const wasRunning = c.state === 'running';
      if (wasRunning) this.end(c, ev.state, ev.error, ev.exitCode);
      else if (c.exitCode === null) c.exitCode = ev.exitCode;
      if (wasRunning && ev.state === 'completed')
        await this.options
          .onCompleted({ consoleId: c.consoleId, accountId: c.accountId, endpointId: c.endpointId })
          .catch(() => {});
    }
    return [...unknown];
  }

  /** Stops every running console (shutdown). */
  async close(): Promise<void> {
    for (const c of this.consoles.values())
      if (this.end(c, 'cancelled', null))
        await this.options
          .executor()
          .consoleStop(c.consoleId, 'cancelled')
          .catch(() => {});
  }
}
