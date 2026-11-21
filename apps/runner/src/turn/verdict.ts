/**
 * Why a turn didn't end done, as the runner learns it while the turn is prepared and runs: the failure, the refusal the
 * agent says, a managed limit or login, what the provider said of its credential. Every `complete` classifies a failure
 * with it (essentials-agents.md EA-08).
 */

import {
  classifyProviderFailure,
  classifyTurnFailure,
  FINAL_OUTCOMES,
  gatewayRoomAt,
  type ManagedOutcome,
  outcomeCode,
  outcomeCopy,
  type SandboxSession,
  type TurnEvent,
} from '@whombat/agent-runtime';
import type { RunSignalState } from '@whombat/agent-runtime/providers';
import type { TurnFailureReport } from '@whombat/core';
import { TurnRefusal } from '../workspace';

/**
 * A refusal's code the app knows (`error.details.code`: `provider.requester_not_signed_in`, `client.not_installed`,
 * `managed.provider_gated`, …): the dispatch records it as its error (SUB-50). The runner's own reasons (a workspace
 * refusal, `sandbox_unavailable`) keep `host_not_ready` / `managed:<outcome>`.
 */
export function isAppErrorCode(code: string): boolean {
  return /^(provider|client|managed)\.[a-z0-9_]+$/.test(code);
}

/** Managed outcomes that are about a person's sign-in: not a gateway turn's (AIG-10). */
const SIGN_IN_OUTCOMES: ReadonlySet<ManagedOutcome> = new Set([
  'not_signed_in',
  'auth_expired',
  'quota_exhausted',
]);

export class TurnVerdict {
  failure: string | null = null;
  /** What the agent says in the conversation when the host or the provider wouldn't run the turn. */
  refusal: string | null = null;
  /** The app error code of a refusal (`provider.*`, `client.*`, `managed.*`), recorded as the dispatch's error. */
  refusalCode: string | null = null;
  /** Any refusal's own code (a workspace reason, `sandbox_unavailable`, …), for the failure's classification (EA-08). */
  refusalReason: string | null = null;
  /** Managed: why a limit or the person's login stopped the turn (every `complete` classifies with it). */
  managedOutcome: ManagedOutcome | null = null;
  /** What the provider's failure said about its credential, and until when (a usage limit's reset). */
  credentialState: RunSignalState | null = null;
  credentialUntil: string | null = null;

  /** The provider's error: the turn's failure, and what it says about the credential. */
  providerFailed(ev: Extract<TurnEvent, { type: 'error' }>): void {
    this.failure = ev.message;
    this.credentialState = ev.credentialState ?? this.credentialState;
    this.credentialUntil = ev.credentialUntil ?? this.credentialUntil;
  }

  /** What broke the turn while it was prepared or ran; a stopped turn's error is the stop's (it completes as such). */
  caught(err: unknown, stopped: boolean): void {
    if (!stopped) {
      this.failure = err instanceof Error ? err.message : String(err);
      // The host is not ready for the turn (TurnRefusal): the agent says why.
      if (err instanceof TurnRefusal) this.refusal = err.refusal;
      if (err instanceof TurnRefusal) this.refusalReason = err.code;
      if (err instanceof TurnRefusal && isAppErrorCode(err.code)) this.refusalCode = err.code;
    }
  }

  /**
   * Once the provider is done: what the sandbox's limits stopped, and what the provider's failure means for the
   * credential owner. An outcome that ends the turn for good is what the agent says.
   */
  async settle(
    sandbox: SandboxSession | null,
    turn: { viaGateway: boolean; provider: string },
  ): Promise<void> {
    if (sandbox) {
      const hit = await sandbox.violations();
      if (hit.length) this.managedOutcome ??= hit[0] as ManagedOutcome;
    }
    if (this.failure && !this.refusal && !this.managedOutcome) {
      const classified = classifyProviderFailure(this.failure);
      // A gateway turn's failure is no sign-in's (AIG-10): what reads like one (a 401, a used-up pool) stays an ordinary
      // failure, which the server words for the gateway, instead of the copy about the agent's own sign-in.
      if (classified && !(turn.viaGateway && SIGN_IN_OUTCOMES.has(classified)))
        this.managedOutcome = classified;
    }
    if (
      this.managedOutcome &&
      this.managedOutcome !== 'lease_lost' &&
      FINAL_OUTCOMES.has(this.managedOutcome)
    ) {
      this.refusal ??= outcomeCopy(this.managedOutcome, turn.provider);
      this.failure ??= outcomeCode(this.managedOutcome);
    }
  }

  /**
   * Why a failed turn failed, for the server's `turn_failed` card (essentials-agents.md EA-08): everything this runner
   * knows — the managed outcome, the refusal's code, the provider's credential signal, its message — as one code. A usage
   * limit resets when the provider said, else when the AI gateway said it has room again (ai-gateway.md AIG-D31), else
   * when its limited window does (`limitedUntil`).
   */
  failureOf(error: string, limitedUntil: string | null, now = new Date()): TurnFailureReport {
    return classifyTurnFailure({
      error,
      refusalCode: this.refusalReason,
      managedOutcome:
        this.managedOutcome && this.managedOutcome !== 'lease_lost' ? this.managedOutcome : null,
      credentialState: this.credentialState,
      credentialUntil: this.credentialUntil ?? gatewayRoomAt(error, now) ?? limitedUntil,
    });
  }
}
