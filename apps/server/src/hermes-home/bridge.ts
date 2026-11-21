/**
 * The runner's Hermes-home service, seen from the server (hermes-engine.md HE-38, HE-S110): the Hermes homes are the
 * runner's, so every step on them — a person's memory files, sessions, skills, a home's archive — is a request the
 * runner takes over its long poll and answers (contracts 0.125 `HERMES_HOME_METHODS`):
 *
 *   POST /internal/runner/hermes/poll   {waitMs?}                       → {requests: [{id, method, params}]}
 *   POST /internal/runner/hermes/answer {id, ok, result | code, error}  → {ok}
 *
 * Like the sign-in bridge (managed/providers/bridge.ts, CS-04b): a request still queued when it times out was never
 * run (`unavailable`); one a runner took without answering may have been (`unknown_outcome`, or `unavailable` for a
 * read). A poll whose answer didn't go out gives its requests back. The answer is checked against the method's result
 * schema before anyone believes it.
 */
import { randomBytes } from 'node:crypto';
import {
  HERMES_HOME_METHODS,
  type HermesHomeAnswer,
  type HermesHomeErrorCode,
  type HermesHomeMethod,
  type HermesHomeParams,
  type HermesHomeRequest,
  type HermesHomeResult,
} from '@whombat/core';

/** Why a step didn't happen as asked: the runner's code, or that no runner took (or answered) it. */
export type HermesHomeFailure = HermesHomeErrorCode | 'unavailable' | 'unknown_outcome';

export class HermesHomeCallError extends Error {
  constructor(
    readonly code: HermesHomeFailure,
    message: string,
  ) {
    super(message);
    this.name = 'HermesHomeCallError';
  }
}

/** Steps that only read: without an answer nothing is unknown, they just failed. */
const READS: ReadonlySet<HermesHomeMethod> = new Set<HermesHomeMethod>([
  'memory.read',
  'sessions.pending',
  'sessions.list',
  'home.exportChunk',
]);

/** Requests in one poll's answer, and about how many bytes of params (an import's chunks are about 1.4 MB each). */
const POLL_MAX_REQUESTS = 16;
const POLL_MAX_BYTES = 4 * 1024 * 1024;

interface Pending {
  method: HermesHomeMethod;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  /** A runner's poll carried it out: the runner may be running it. */
  taken: boolean;
}

/** Who runs the steps: the runner over the long poll (`HermesHomeBridge`), or, in tests, the service in-process. */
export interface HermesHomeExecutor {
  call<M extends HermesHomeMethod>(
    method: M,
    params: HermesHomeParams<M>,
    options?: { timeoutMs?: number },
  ): Promise<HermesHomeResult<M>>;
  /** Whether a runner is there to answer now (a read that only shows something asks only then). */
  readonly runnerSeen: boolean;
  close(): void;
}

export class HermesHomeBridge implements HermesHomeExecutor {
  private queue: (HermesHomeRequest & { size: number })[] = [];
  private readonly pending = new Map<string, Pending>();
  private waiters: (() => void)[] = [];
  private closed = false;
  private lastPollAt = 0;

  constructor(private readonly timeoutMs = 30_000) {}

  call<M extends HermesHomeMethod>(
    method: M,
    params: HermesHomeParams<M>,
    options: { timeoutMs?: number } = {},
  ): Promise<HermesHomeResult<M>> {
    if (this.closed) return Promise.reject(notTaken());
    const id = `hhr_${randomBytes(9).toString('base64url')}`;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    return new Promise<HermesHomeResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        this.pending.delete(id);
        this.queue = this.queue.filter((r) => r.id !== id);
        reject(p?.taken ? noAnswer(method) : notTaken());
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        taken: false,
      });
      this.queue.push({ id, method, params, size: JSON.stringify(params ?? null).length });
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  /** The runner's long poll: the queued requests, or none after `waitMs`; nothing outlives the request (MR-30). */
  async poll(waitMs: number, signal?: AbortSignal): Promise<HermesHomeRequest[]> {
    this.lastPollAt = Date.now();
    if (this.queue.length === 0 && !this.closed && !signal?.aborted)
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          const i = this.waiters.indexOf(done);
          if (i >= 0) this.waiters.splice(i, 1);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(Math.max(waitMs, 0), 30_000));
        this.waiters.push(done);
        signal?.addEventListener('abort', done, { once: true });
      });
    this.lastPollAt = Date.now();
    if (signal?.aborted) return [];
    let n = 0;
    let bytes = 0;
    while (n < this.queue.length && n < POLL_MAX_REQUESTS) {
      bytes += this.queue[n]?.size ?? 0;
      if (n > 0 && bytes > POLL_MAX_BYTES) break;
      n++;
    }
    const taken = this.queue.splice(0, n);
    for (const r of taken) {
      const p = this.pending.get(r.id);
      if (p) p.taken = true;
    }
    signal?.addEventListener('abort', () => this.giveBack(taken), { once: true });
    return taken.map(({ id, method, params }) => ({ id, method, params }));
  }

  private giveBack(requests: (HermesHomeRequest & { size: number })[]): void {
    const back = requests.filter((r) => {
      const p = this.pending.get(r.id);
      if (!p) return false;
      p.taken = false;
      return true;
    });
    if (back.length === 0 || this.closed) return;
    this.queue.unshift(...back);
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** A runner waits in a long poll now, or polled within the last minute. */
  get runnerSeen(): boolean {
    return !this.closed && (this.waiters.length > 0 || Date.now() - this.lastPollAt < 60_000);
  }

  /** Long polls waiting now (tests: none may linger). */
  get waiting(): number {
    return this.waiters.length;
  }

  /** The runner's answer to one request. */
  answer(answer: HermesHomeAnswer): boolean {
    const p = this.pending.get(answer.id);
    if (!p) return false;
    this.pending.delete(answer.id);
    clearTimeout(p.timer);
    settle(p, answer);
    return true;
  }

  close(): void {
    this.closed = true;
    for (const wake of this.waiters.splice(0)) wake();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(p.taken ? noAnswer(p.method) : notTaken());
      this.pending.delete(id);
    }
    this.queue = [];
  }
}

/** Resolves or rejects a call with the runner's answer, checked against the method's result. */
export function settle(
  p: Pick<Pending, 'method' | 'resolve' | 'reject'>,
  answer: Pick<HermesHomeAnswer, 'ok'> &
    Partial<{ result: unknown; code: HermesHomeErrorCode; error: string }>,
): void {
  if (!answer.ok) {
    p.reject(new HermesHomeCallError(answer.code ?? 'failed', answer.error ?? 'The step failed.'));
    return;
  }
  const parsed = HERMES_HOME_METHODS[p.method].result.safeParse(answer.result);
  if (parsed.success) p.resolve(parsed.data);
  else
    p.reject(
      READS.has(p.method)
        ? new HermesHomeCallError('unavailable', 'The runner answered with something unexpected.')
        : new HermesHomeCallError(
            'unknown_outcome',
            'The runner answered with something unexpected, so it may have happened.',
          ),
    );
}

function notTaken(): HermesHomeCallError {
  return new HermesHomeCallError('unavailable', 'The runner didn’t pick this up, so nothing was done.');
}

function noAnswer(method: HermesHomeMethod): HermesHomeCallError {
  return READS.has(method)
    ? new HermesHomeCallError('unavailable', 'The runner didn’t answer in time.')
    : new HermesHomeCallError(
        'unknown_outcome',
        'The runner didn’t answer in time, so this may have happened.',
      );
}
