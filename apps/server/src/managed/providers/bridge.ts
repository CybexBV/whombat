/**
 * The runner-side sign-in executor, seen from the server (docs/decisions/managed-providers.md PV-12, orchestrator
 * approval 2026-09-25): the server keeps attempts, policy and audit; every step that runs a provider CLI or touches a
 * credential home is a request the runner takes over the loopback runner protocol (runner token) and answers:
 *
 *   POST /internal/runner/signin/poll   {waitMs?}                 → {requests: [{id, method, params}]}  (long poll)
 *   POST /internal/runner/signin/answer {id, ok, result | error}  → {ok}
 *   POST /internal/runner/signin/event  {done: DeviceDone}        → {ok}   (a device sign-in finished)
 *   POST /internal/runner/signin/console {events}                 → {ok, unknown}  (sign-in console output, exits)
 *
 * So the CLIs run as the runner's user and every home belongs to the user whose sandboxed turns use it. A secret
 * (`submitSecret`) crosses only this loopback hop, inside one request, and is never logged. No runner polling: the
 * request times out and the person is told to try again. INTERIM: these routes are the runner protocol's, proposed
 * for the contracts' `runnerApi` (0.5.1).
 *
 * The runner runs each request it receives once and never dedupes (every call has a new id), so what a call without
 * an answer means depends on whether the runner took it (docs/decisions/command-safety.md CS-04b): still queued, it
 * certainly didn't act (`unavailable`, nothing was done); taken by a poll whose answer went out, a step that acts may
 * have (`unknown_outcome`), a read simply failed (`unavailable`). A poll whose answer didn't go out gives its requests
 * back. Steps that act run as external effects of the session command that asked (CS-01).
 */
import { randomBytes } from 'node:crypto';
import type {
  ConsoleResult,
  ConsoleStartJob,
  CredentialProvider,
  DeviceDone,
  DeviceStartResult,
  SecretResult,
  SecretSignIn,
  SignInExecutor,
  SignInRecord,
  SignInTarget,
  UsageProbeResult,
  UsageProvider,
} from '@whombat/agent-runtime/providers';
import {
  type ConsoleSignInEvent,
  SIGNIN_METHODS as SIGNIN_SCHEMAS,
  type SignInMethod,
} from '@whombat/core/contracts';
import { externalEffect } from '../../commit/scope';
import { ApiError } from '../../lib/errors';

export interface SignInRequest {
  id: string;
  method: SignInMethod;
  params: unknown;
}

interface Pending {
  method: SignInMethod;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  /** A runner's poll carried it out: the runner may be running it. */
  taken: boolean;
}

export const SIGNIN_METHODS = Object.keys(SIGNIN_SCHEMAS) as readonly SignInMethod[];

/** Methods that only read (a sign-in list, a git token): without an answer nothing is unknown, they just failed. */
const READS: ReadonlySet<SignInMethod> = new Set<SignInMethod>(['list', 'githubToken']);

/**
 * A bridge call that got no usable answer from the runner (CS-04b). Over a session it answers `sessionCode`:
 * `unavailable` (the runner never took it, or it only read: nothing was done, a retry may run it) or `unknown_outcome`
 * (the runner took a step that acts and no answer came back: it may have acted). Elsewhere (the runner's own routes,
 * MCP) it stays the `conflict` it always was, with `details.code: provider.signin_unavailable`.
 */
export class RunnerBridgeError extends ApiError {
  constructor(
    readonly sessionCode: 'unavailable' | 'unknown_outcome',
    message: string,
  ) {
    super('conflict', message, { details: { code: 'provider.signin_unavailable' } });
  }
}

/** A failure that proves the runner didn't act: everything but a taken step without its answer. */
const runnerRefused = (err: unknown) =>
  !(err instanceof RunnerBridgeError && err.sessionCode === 'unknown_outcome');

export class RunnerSignInBridge implements SignInExecutor {
  private queue: SignInRequest[] = [];
  private readonly pending = new Map<string, Pending>();
  private waiters: (() => void)[] = [];
  private closed = false;

  constructor(
    private readonly onDeviceDone: (done: DeviceDone) => void,
    /** Sign-in console output and exits (CT-71); answers the console ids the server doesn't know. */
    private readonly onConsoleEvents: (events: ConsoleSignInEvent[]) => Promise<string[]> = async (
      events,
    ) => [...new Set(events.map((e) => e.consoleId))],
    private readonly timeoutMs = 45_000,
  ) {}

  /**
   * One request to the runner. Steps that act run as an external effect of the session command that asked (CS-01):
   * `idempotent` ones (cancels, a resize, a probe) are only observed; the others pin the command past its cancel.
   */
  private call<T>(
    method: SignInRequest['method'],
    params: unknown,
    timeoutMs = this.timeoutMs,
    effect: { idempotent: boolean } | null = null,
  ): Promise<T> {
    const send = () => this.send<T>(method, params, timeoutMs);
    if (!effect) return send();
    return externalEffect(`runner.${method}`, send, {
      idempotent: effect.idempotent,
      refused: runnerRefused,
    });
  }

  private send<T>(method: SignInRequest['method'], params: unknown, timeoutMs: number): Promise<T> {
    if (this.closed) return Promise.reject(notTaken());
    const id = `sir_${randomBytes(9).toString('base64url')}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        this.pending.delete(id);
        this.queue = this.queue.filter((r) => r.id !== id);
        reject(p?.taken ? noAnswer(method) : notTaken());
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer, taken: false });
      this.queue.push({ id, method, params });
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  /**
   * The runner's long poll: the queued requests, or none after `waitMs`. A poll that ends (timeout, hang-up) takes
   * its waiter and listener with it: nothing outlives the request (MR-30).
   */
  async poll(waitMs: number, signal?: AbortSignal): Promise<SignInRequest[]> {
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
    // The runner hung up: the requests wait for its next poll (it never saw them).
    if (signal?.aborted) return [];
    const taken = this.queue.splice(0, 8);
    for (const r of taken) {
      const p = this.pending.get(r.id);
      if (p) p.taken = true;
    }
    // An answer that doesn't go out in full can't have been read: its requests go back to the queue (CS-04b).
    signal?.addEventListener('abort', () => this.giveBack(taken), { once: true });
    return taken;
  }

  /** Requests a poll carried that never reached the runner: first in line again. */
  private giveBack(requests: SignInRequest[]): void {
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

  /** Long polls waiting now (tests: none may linger). */
  get waiting(): number {
    return this.waiters.length;
  }

  /** When a runner last asked for requests (0: never since the server started). */
  private lastPollAt = 0;

  /**
   * A runner is there to answer: one waits in a long poll now, or polled within the last minute (it polls again as soon
   * as an answer went out). A read that only shows something (`appliance.status`) asks only then, instead of waiting a
   * bridge timeout for nobody.
   */
  get runnerSeen(): boolean {
    return !this.closed && (this.waiters.length > 0 || Date.now() - this.lastPollAt < 60_000);
  }

  /** The runner's answer to one request. */
  answer(id: string, answer: { ok: true; result: unknown } | { ok: false; error: string }): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (answer.ok) {
      // The contract's result for the method (CT-39; `CredentialMeta` with `creatorAttested`, `login` and the last
      // run's `signal` since 0.5.2, CT-50): the runner's answer is data, never trusted blindly.
      const parsed = SIGNIN_SCHEMAS[p.method].result.safeParse(answer.result);
      if (parsed.success) p.resolve(parsed.data);
      // It ran the step and said it succeeded, with something unexpected: what it did is unknown (CS-04b).
      else
        p.reject(
          READS.has(p.method)
            ? new RunnerBridgeError(
                'unavailable',
                'The runner answered the sign-in step with something unexpected.',
              )
            : new RunnerBridgeError(
                'unknown_outcome',
                'The runner answered the sign-in step with something unexpected, so it may have happened. Check the sign-ins before trying again.',
              ),
        );
    } else
      p.reject(
        new ApiError('conflict', `The sign-in failed on the appliance: ${answer.error.slice(0, 300)}`),
      );
    return true;
  }

  /** A device sign-in finished on the runner. */
  event(done: DeviceDone): void {
    this.onDeviceDone(done);
  }

  /** Sign-in console output and exits from the runner (in order); the ids of consoles the server doesn't know. */
  console(events: ConsoleSignInEvent[]): Promise<string[]> {
    return this.onConsoleEvents(events);
  }

  submitSecret(job: SecretSignIn): Promise<SecretResult> {
    return this.call('submitSecret', job, 90_000, ACTS);
  }
  startDevice(job: SignInTarget): Promise<DeviceStartResult> {
    return this.call('startDevice', job, 60_000, ACTS);
  }
  cancel(loginId: string): Promise<void> {
    return this.call('cancel', { loginId }, this.timeoutMs, IDEMPOTENT);
  }
  /** Signs out and removes the home: a later repeat isn't harmless (someone may have signed in again, CT-195). */
  logout(provider: CredentialProvider): Promise<{ removed: boolean; authMode: string | null }> {
    return this.call('logout', { provider }, this.timeoutMs, ACTS);
  }
  list(): Promise<SignInRecord[]> {
    return this.call('list', {});
  }
  githubToken(): Promise<string | null> {
    return this.call('githubToken', {});
  }
  consoleStart(job: ConsoleStartJob): Promise<ConsoleResult> {
    return this.call('consoleStart', job, 60_000, ACTS);
  }
  /** Keystrokes: a secret crosses only this loopback hop, inside one request, and is never logged. */
  consoleInput(consoleId: string, data: string): Promise<ConsoleResult> {
    return this.call('consoleInput', { consoleId, data }, this.timeoutMs, ACTS);
  }
  consoleResize(consoleId: string, cols: number, rows: number): Promise<ConsoleResult> {
    return this.call('consoleResize', { consoleId, cols, rows }, this.timeoutMs, IDEMPOTENT);
  }
  /**
   * A person's subscription usage (UI-R05), read by the runner in a task sandbox. A CLI run takes a few seconds; the
   * answer may take up to a minute. A runner before contracts 0.23 answers `unknown sign-in method usageProbe`.
   */
  usageProbe(provider: UsageProvider): Promise<UsageProbeResult> {
    return this.call('usageProbe', { provider }, 75_000, IDEMPOTENT);
  }

  async consoleStop(consoleId: string, reason: 'cancelled' | 'expired'): Promise<void> {
    await this.call('consoleStop', { consoleId, reason }, this.timeoutMs, IDEMPOTENT);
  }

  /** Shutting down: a request still queued was never run; one the runner took may have been (CS-04b). */
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

const ACTS = { idempotent: false };
const IDEMPOTENT = { idempotent: true };

/** The runner never took the request: nothing was done. */
function notTaken(): RunnerBridgeError {
  return new RunnerBridgeError(
    'unavailable',
    'The appliance’s runner didn’t pick up the sign-in step, so nothing was done. Try again in a moment.',
  );
}

/** The runner took the request and no answer came back: a step that acts may have happened. */
function noAnswer(method: SignInMethod): RunnerBridgeError {
  if (READS.has(method))
    return new RunnerBridgeError(
      'unavailable',
      'The appliance’s runner didn’t answer the sign-in in time. Try again in a moment.',
    );
  return new RunnerBridgeError(
    'unknown_outcome',
    'The appliance’s runner didn’t answer in time, so this may or may not have happened. Check the sign-ins before trying again.',
  );
}
