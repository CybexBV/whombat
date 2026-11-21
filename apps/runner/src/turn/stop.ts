/**
 * How a turn stops: one abort for the provider and every step that takes the turn's signal, and the first reason given
 * (pause, take over, cancel, shutdown), which decides how the turn completes. The runner's own signal for the turn is
 * followed until the turn ends.
 */

import type { ManagedOutcome } from '@whombat/agent-runtime';
import type { TurnVerdict } from './verdict';

export type StopReason = 'paused' | 'taken_over' | 'cancelled' | 'shutdown';

export class TurnStop {
  readonly #controller = new AbortController();
  #reason: StopReason | null = null;
  #unfollow: (() => void) | null = null;

  /** Aborts the provider and every step given it. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get aborted(): boolean {
    return this.#controller.signal.aborted;
  }

  /** Why the turn was stopped (the first reason counts); null while nothing stopped it. */
  get reason(): StopReason | null {
    return this.#reason;
  }

  stop(why: StopReason): void {
    this.#reason ??= why;
    this.#controller.abort(why);
  }

  /** Calls `fn` once when the turn stops (never for a turn that had stopped already). */
  onStop(fn: () => void): void {
    this.#controller.signal.addEventListener('abort', fn, { once: true });
  }

  /**
   * Follows the runner's signal for this turn. The heartbeat only says "stop" (no reason): `ask` progress why
   * (pause / take over) before stopping.
   */
  follow(external: AbortSignal, ask: () => Promise<void>): void {
    const onExternal = () => {
      const why = (external.reason as StopReason | undefined) ?? 'shutdown';
      if (why === 'cancelled') void ask().finally(() => this.stop('cancelled'));
      else this.stop(why);
    };
    this.#unfollow = () => external.removeEventListener('abort', onExternal);
    if (external.aborted) onExternal();
    else external.addEventListener('abort', onExternal, { once: true });
  }

  /** Lets go of the runner's signal: the turn ended, or never started. */
  unfollow(): void {
    this.#unfollow?.();
  }
}

/**
 * A managed limit stops the turn (its wall time, a lease it can't renew): the outcome is recorded first, so what runs on
 * the stop (the task's kill) knows it.
 */
export function stopManaged(turn: { stop: TurnStop; verdict: TurnVerdict }, outcome: ManagedOutcome): void {
  turn.verdict.managedOutcome ??= outcome;
  turn.stop.stop('cancelled');
}
