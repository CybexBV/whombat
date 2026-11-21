/**
 * The Claude sign-in console's client loop (CT-71, SUB-03): start (or resume) the console, long-poll its output with a
 * byte cursor, type into it with numbered writes, follow the terminal's size, and cancel it on close. Transport-neutral:
 * the same `api.signins.console*` calls over REST (self-hosted) and over the session (managed, CT-70).
 *
 * What passes through here (the output, which may echo the code from claude.ai, and the keystrokes) is handed to the
 * terminal and nowhere else: never logged, never put in a query cache, never stored.
 */
import type { api } from '@whombat/core/contracts';
import {
  PROVIDER_CONSOLE_COLS,
  PROVIDER_CONSOLE_INPUT_MAX_BYTES,
  PROVIDER_CONSOLE_ROWS,
  PROVIDER_CONSOLE_WAIT_MAX_MS,
  type ProviderConsole,
  utf8ByteLength,
} from '@whombat/core/domain';
import type { WhombatClient } from '../http/client';
import type { ResponseData } from '../http/types';
import { appErrorOf, isRetryable, wentThrough } from './errors';

export type ConsoleOutput = ResponseData<typeof api.signins.consoleRead>;

/** The five console calls; `consoleApiOf(client)` builds them from the typed client. */
export interface ConsoleApi {
  start(size: { cols: number; rows: number }): Promise<ProviderConsole>;
  read(consoleId: string, cursor: number, waitMs: number, signal: AbortSignal): Promise<ConsoleOutput>;
  write(consoleId: string, seq: number, data: string): Promise<ProviderConsole>;
  resize(consoleId: string, cols: number, rows: number): Promise<ProviderConsole>;
  cancel(consoleId: string): Promise<ProviderConsole>;
}

/** How long a read waits for output (the contract's longest), and the session deadline above it. */
export const CONSOLE_WAIT_MS = PROVIDER_CONSOLE_WAIT_MAX_MS;
const READ_DEADLINE_MS = CONSOLE_WAIT_MS + 10_000;

function ok<T>(r: { status: string; data?: T; message?: string }): T {
  if (r.status !== 'ok') throw new Error(r.message ?? `Unexpected ${r.status}`);
  return r.data as T;
}

export function consoleApiOf(client: Pick<WhombatClient, 'signins'>): ConsoleApi {
  return {
    start: async ({ cols, rows }) =>
      ok(
        await client.signins.consoleStart({
          body: { provider: 'claude', authMode: 'subscription_cli', cols, rows },
        }),
      ),
    read: (consoleId, cursor, waitMs, signal) =>
      client.signins.consoleRead({
        params: { consoleId },
        query: { cursor, waitMs },
        signal,
        deadlineMs: READ_DEADLINE_MS,
      }),
    write: async (consoleId, seq, data) =>
      ok(await client.signins.consoleWrite({ params: { consoleId }, body: { seq, data } })),
    resize: async (consoleId, cols, rows) =>
      ok(await client.signins.consoleResize({ params: { consoleId }, body: { cols, rows } })),
    cancel: async (consoleId) => ok(await client.signins.consoleCancel({ params: { consoleId } })),
  };
}

export type ConsolePhase = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'expired';

export interface ConsoleDriverState {
  phase: ConsolePhase;
  console: ProviderConsole | null;
  /** Why it failed (`provider.login_failed`, `provider.login_missing`, or a start that was refused). */
  error: { code: string; message: string | null } | null;
}

export interface ConsoleDriverOptions {
  api: ConsoleApi;
  /** A console of this account that is still running (from `signins.list`): pick it up instead of starting one. */
  resume?: ProviderConsole | null;
  cols: number;
  rows: number;
  /** Raw PTY bytes for the terminal, in order (UTF-8 may split across calls; the terminal joins them). */
  onOutput(bytes: Uint8Array): void;
  onState(state: ConsoleDriverState): void;
  /** Wait before retry `attempt` (0-based); default 0.5 s, 1 s, 2 s, then 4 s. */
  backoffMs?: (attempt: number) => number;
  /** Tests: a clock-free sleep. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface ConsoleDriver {
  /** Keystrokes or pasted text, as the terminal produced them. */
  input(data: string): void;
  /** The terminal's new size (clamped to what the contract allows; only a change is sent). */
  resize(cols: number, rows: number): void;
  /** Stop reading and writing; a console that still runs is cancelled. */
  close(): Promise<void>;
  readonly state: ConsoleDriverState;
}

const defaultBackoff = (attempt: number) => Math.min(4_000, 500 * 2 ** attempt);

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

const clamp = (n: number, { min, max }: { min: number; max: number }) =>
  Math.max(min, Math.min(max, Math.floor(n)));

/** Standard base64 → bytes, without `atob` or `Buffer` (Hermes, workers). */
export function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    const v =
      c >= 65 && c <= 90
        ? c - 65
        : c >= 97 && c <= 122
          ? c - 71
          : c >= 48 && c <= 57
            ? c + 4
            : c === 43
              ? 62
              : c === 47
                ? 63
                : -1;
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/**
 * The longest prefix of `text` that fits `maxBytes` of UTF-8 without splitting a surrogate pair (at least one
 * character, so progress is always made).
 */
export function takeUtf8(text: string, maxBytes = PROVIDER_CONSOLE_INPUT_MAX_BYTES): [string, string] {
  if (utf8ByteLength(text) <= maxBytes) return [text, ''];
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    const pair = c >= 0xd800 && c <= 0xdbff && i + 1 < text.length;
    const w = utf8ByteLength(text.slice(i, pair ? i + 2 : i + 1));
    if (bytes + w > maxBytes && i > 0) break;
    bytes += w;
    i += pair ? 2 : 1;
  }
  return [text.slice(0, i), text.slice(i)];
}

const FINAL: Record<string, ConsolePhase> = {
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  expired: 'expired',
};

/**
 * Runs one sign-in console. Reads are a loop of long polls (`waitMs` 25 s) from the last `next`; output older than what
 * the server keeps comes back from a later `from`, which the terminal just shows. Writes go one at a time, numbered
 * from the console's `inputSeq` + 1; a write whose answer was lost is sent again with the same `seq` (the server types
 * it once), and a refused gap (`provider.console_input_gap`) renumbers from the `inputSeq` the server reports.
 */
export function createConsoleDriver(options: ConsoleDriverOptions): ConsoleDriver {
  const { api } = options;
  const backoff = options.backoffMs ?? defaultBackoff;
  const sleep = options.sleep ?? defaultSleep;
  const stop = new AbortController();
  let state: ConsoleDriverState = { phase: 'starting', console: null, error: null };
  let consoleId: string | null = null;
  let size = {
    cols: clamp(options.cols, PROVIDER_CONSOLE_COLS),
    rows: clamp(options.rows, PROVIDER_CONSOLE_ROWS),
  };
  let sentSize = size;
  let lastSeq = 0;
  let pending = '';
  let inFlight: { seq: number; data: string } | null = null;
  let writing = false;
  let resizing = false;

  const running = () => state.phase === 'running' && !stop.signal.aborted;

  function setState(next: Partial<ConsoleDriverState>) {
    state = { ...state, ...next };
    options.onState(state);
  }

  function follow(c: ProviderConsole) {
    const phase = FINAL[c.state];
    if (phase) {
      pending = '';
      setState({
        phase,
        console: c,
        error: c.error ? { code: c.error.code, message: c.error.message } : state.error,
      });
    } else setState({ console: c });
  }

  async function readLoop() {
    let cursor = 0;
    let attempt = 0;
    while (!stop.signal.aborted && consoleId) {
      let out: ConsoleOutput;
      try {
        out = await api.read(consoleId, cursor, CONSOLE_WAIT_MS, stop.signal);
        attempt = 0;
      } catch (error) {
        if (stop.signal.aborted) return;
        const { code, message } = appErrorOf(error);
        if (code === 'provider.console_not_found' || code === 'not_found') {
          setState({ phase: 'failed', error: { code, message } });
          return;
        }
        await sleep(backoff(attempt++), stop.signal);
        continue;
      }
      if (stop.signal.aborted) return;
      if (out.data) options.onOutput(decodeBase64(out.data));
      cursor = Math.max(cursor, out.next);
      follow(out.console);
      if (out.console.state !== 'running' && !out.more) return;
    }
  }

  async function pump() {
    if (writing) return;
    writing = true;
    let attempt = 0;
    try {
      while (running() && consoleId && (inFlight || pending)) {
        if (!inFlight) {
          const [chunk, rest] = takeUtf8(pending);
          pending = rest;
          inFlight = { seq: lastSeq + 1, data: chunk };
        }
        const write = inFlight;
        try {
          const c = await api.write(consoleId, write.seq, write.data);
          lastSeq = write.seq;
          inFlight = null;
          attempt = 0;
          if (FINAL[c.state]) follow(c);
        } catch (error) {
          if (stop.signal.aborted) return;
          if (wentThrough(error)) {
            lastSeq = write.seq;
            inFlight = null;
            continue;
          }
          const { code, details } = appErrorOf(error);
          if (code === 'provider.console_input_gap' && typeof details?.inputSeq === 'number') {
            // The server applied up to `inputSeq` (another tab typed, or we resumed): number ours after it.
            lastSeq = details.inputSeq;
            inFlight = { seq: lastSeq + 1, data: write.data };
            if (attempt++ > 3) inFlight = null;
            continue;
          }
          if (code === 'provider.console_ended' || code === 'provider.console_not_found') {
            inFlight = null;
            pending = '';
            return;
          }
          if (isRetryable(error)) {
            await sleep(backoff(attempt++), stop.signal);
            continue; // the same seq again
          }
          // Refused for good (malformed input): drop it rather than block what follows.
          inFlight = null;
          attempt = 0;
        }
      }
    } finally {
      writing = false;
    }
  }

  async function syncSize() {
    if (resizing) return;
    resizing = true;
    try {
      while (running() && consoleId && (size.cols !== sentSize.cols || size.rows !== sentSize.rows)) {
        const want = size;
        try {
          await api.resize(consoleId, want.cols, want.rows);
          sentSize = want;
        } catch (error) {
          if (!isRetryable(error))
            sentSize = want; // e.g. the console ended: nothing to resize
          else await sleep(backoff(0), stop.signal);
        }
      }
    } finally {
      resizing = false;
    }
  }

  async function begin() {
    let c: ProviderConsole;
    const resume = options.resume?.state === 'running' ? options.resume : null;
    try {
      c = resume ?? (await api.start(size));
    } catch (error) {
      if (stop.signal.aborted) return;
      const { code, message } = appErrorOf(error);
      setState({ phase: 'failed', error: { code, message } });
      return;
    }
    if (stop.signal.aborted) {
      if (c.state === 'running') await api.cancel(c.consoleId).catch(() => {});
      return;
    }
    consoleId = c.consoleId;
    lastSeq = c.inputSeq;
    sentSize = { cols: c.cols, rows: c.rows };
    setState({ phase: FINAL[c.state] ?? 'running', console: c });
    void readLoop();
    void syncSize();
    void pump();
  }

  void begin();

  return {
    input(data: string) {
      if (!data || stop.signal.aborted || (state.phase !== 'running' && state.phase !== 'starting')) return;
      pending += data;
      void pump();
    },
    resize(cols: number, rows: number) {
      size = { cols: clamp(cols, PROVIDER_CONSOLE_COLS), rows: clamp(rows, PROVIDER_CONSOLE_ROWS) };
      void syncSize();
    },
    async close() {
      if (stop.signal.aborted) return;
      const wasRunning = state.phase === 'running' || state.phase === 'starting';
      stop.abort();
      pending = '';
      if (wasRunning && consoleId) await api.cancel(consoleId).catch(() => {});
    },
    get state() {
      return state;
    },
  };
}
