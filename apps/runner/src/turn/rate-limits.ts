/**
 * What the provider said about its subscription's windows during the turn, merged (UI-R08): sent with the next beat
 * once it changed, and with `complete` (a refused turn's `limited` window arrives that way).
 */

import { mergeObservation, type UsageObservation } from '@whombat/agent-runtime';
import type { TurnRateLimits } from '@whombat/core';

export class RateLimitReadings {
  #reading: UsageObservation | null = null;
  #sent = true;

  /** A reading of the turn's own provider; the server decides whose subscription it was (UI-R08). */
  observe(usage: UsageObservation): void {
    this.#reading = mergeObservation(this.#reading, usage);
    this.#sent = false;
  }

  /** The readings as the runner protocol carries them; undefined before the first. */
  report(): TurnRateLimits | undefined {
    const r = this.#reading;
    return r
      ? { provider: r.provider, plan: r.plan, windows: r.windows, observedAt: r.observedAt }
      : undefined;
  }

  /** What the next beat carries: the readings, when they changed since a beat took them. */
  unsent(): TurnRateLimits | undefined {
    return this.#sent ? undefined : this.report();
  }

  /** A beat took `limits`: they count as sent unless a newer reading came while it was on its way. */
  sent(limits: TurnRateLimits | undefined): void {
    if (limits && this.#reading?.observedAt === limits.observedAt) this.#sent = true;
  }

  /** When the limited window resets, when one is limited. */
  limitedUntil(): string | null {
    return this.#reading?.windows.find((w) => w.status === 'limited')?.resetsAt ?? null;
  }
}
