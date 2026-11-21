/**
 * Durable command states for the UI (MA-09, AP-14): every mutation a person starts is tracked by its request id
 * through `pending_delivery → accepted → executing → completed | rejected | unknown`, plus
 * `not_delivered` (it never reached the appliance: safe to send again with the same id). A local draft (the
 * composer's text) is the state before any of these and stays with the composer.
 *
 * Rules the tracker enforces:
 * - a retry reuses the request id and the exact input (the appliance dedupes by id + digest);
 * - `unknown` is resolved by asking the appliance (`check`), never by resubmitting. `check` answering "never
 *   committed" moves a command to `not_delivered`, from where a person may send it again (same id), only when that is
 *   what the session itself would do (`resendAfterNotFound`, CT-194: a `receipt` op that isn't destructive) and the
 *   appliance never acknowledged it (AP-574: afterwards `not_found` means its receipt expired). Anything else stays
 *   `unknown`: no receipt doesn't prove no effect (GitHub, a provider, a revoked grant …), so a person checks the
 *   current state instead (AP-577);
 * - a command whose call is over is never stuck: while it isn't finished (`unknown`, or `check` finding it `accepted` /
 *   `executing`) a person can check again (`canCheck`, AP-579); a `completed` answer without a result (`redacted`,
 *   CT-195) is done.
 */
import type { AnyEndpoint } from '@whombat/core/contracts';
import { resendAfterNotFound } from '@whombat/protocol/session';
import { NetworkError } from '../http/errors';
import { apiOpName } from './op-names';
import type { ApplianceSession, CommandStatus, OperationInput } from './types';
import { NotDeliveredError, OutcomeRedactedError, OutcomeUnknownError, SessionClosedError } from './types';

export type CommandPhase =
  | 'pending_delivery'
  | 'accepted'
  | 'executing'
  | 'completed'
  | 'rejected'
  | 'unknown'
  | 'not_delivered';

export interface TrackedCommand {
  requestId: string;
  endpoint: AnyEndpoint;
  input: OperationInput;
  phase: CommandPhase;
  /** People's words for what this is ("Message to #billing-v2"). */
  label: string;
  /** Epoch ms of the last change. */
  updatedAt: number;
  /** Set while `check` is asking the appliance. */
  checking: boolean;
  /**
   * The appliance said it was accepted or running (`progress`, or `check`): a later `not_found` means its receipt
   * expired, never that it wasn't sent (AP-574).
   */
  acknowledged: boolean;
  /** The call is over (`settle`): what the phase says now comes from `check`. */
  settled: boolean;
}

/**
 * Whether a person may ask the appliance again (“Check again”, AP-579): the call is over and the command isn't
 * finished — its outcome is unknown, or the last check found it accepted or running.
 */
export function canCheck(command: Pick<TrackedCommand, 'phase' | 'settled'>): boolean {
  return (
    command.phase === 'unknown' ||
    (command.settled && (command.phase === 'accepted' || command.phase === 'executing'))
  );
}

/** Quiet status words for the pending states (null = nothing to show). */
export function commandStatusText(phase: CommandPhase): string | null {
  switch (phase) {
    case 'pending_delivery':
      return 'Sending…';
    case 'accepted':
    case 'executing':
      return 'Received · working on it';
    case 'unknown':
      return 'Not confirmed yet';
    case 'not_delivered':
      return 'Not sent';
    case 'rejected':
      return 'Didn’t go through';
    case 'completed':
      return null;
  }
}

export interface CommandTracker {
  /** Start tracking `requestId` (pending delivery). */
  begin(command: Omit<TrackedCommand, 'phase' | 'updatedAt' | 'checking' | 'acknowledged' | 'settled'>): void;
  progress(requestId: string, phase: 'accepted' | 'executing'): void;
  /** The call settled: map the outcome to a phase. */
  settle(requestId: string, outcome: { ok: true } | { ok: false; error: unknown }): void;
  /** Ask the appliance what happened to an `unknown` command. */
  check(requestId: string): Promise<CommandPhase>;
  get(requestId: string): TrackedCommand | undefined;
  list(): TrackedCommand[];
  forget(requestId: string): void;
  subscribe(listener: () => void): () => void;
  /** Forget everything (sign-out, account or appliance switch). */
  clear(): void;
}

/** What phase a failed call ends in. */
export function phaseForError(error: unknown): CommandPhase {
  if (error instanceof OutcomeUnknownError) return 'unknown';
  // An answer that isn't kept (a secret op's, or a result lost after the commit, CT-195): `completed` is done; after
  // `unknown_outcome` it may have happened. Never offered as “Send again” by itself.
  if (error instanceof OutcomeRedactedError) return error.state === 'completed' ? 'completed' : 'unknown';
  if (error instanceof NetworkError) return 'not_delivered';
  if (error instanceof NotDeliveredError) return 'not_delivered';
  // Closed before it was sent (a sent mutation fails as `OutcomeUnknownError`, its cause the closed session).
  if (error instanceof SessionClosedError) return 'not_delivered';
  if (error instanceof Error && error.name === 'AbortError') return 'not_delivered';
  return 'rejected';
}

export function createCommandTracker(
  session: () => ApplianceSession,
  now: () => number = Date.now,
): CommandTracker {
  const commands = new Map<string, TrackedCommand>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const l of [...listeners]) l();
  };
  const patch = (requestId: string, change: Partial<TrackedCommand>) => {
    const c = commands.get(requestId);
    if (!c) return;
    commands.set(requestId, { ...c, ...change, updatedAt: now() });
    changed();
  };
  return {
    begin(command) {
      commands.set(command.requestId, {
        ...command,
        phase: 'pending_delivery',
        updatedAt: now(),
        checking: false,
        acknowledged: false,
        settled: false,
      });
      changed();
    },
    progress(requestId, phase) {
      const c = commands.get(requestId);
      if (!c || c.phase === 'completed' || c.phase === 'rejected') return;
      patch(requestId, { phase, acknowledged: true });
    },
    settle(requestId, outcome) {
      const error = outcome.ok ? null : outcome.error;
      patch(requestId, {
        phase: outcome.ok ? 'completed' : phaseForError(error),
        settled: true,
        // The session gave up on work the appliance had acknowledged (AP-574, AP-578).
        ...(error instanceof OutcomeUnknownError && error.acknowledged && { acknowledged: true }),
      });
    },
    async check(requestId) {
      const c = commands.get(requestId);
      if (!c) return 'completed';
      patch(requestId, { checking: true });
      let s: CommandStatus;
      try {
        s = await session().status(requestId, c.endpoint);
      } catch {
        patch(requestId, { checking: false });
        return c.phase;
      }
      // The appliance has it but can't tell whether it took effect (CT-196): unknown, never “Not sent” (AP-582).
      const mayHaveRun = s.state === 'unknown' && s.acknowledged === true;
      const phase: CommandPhase =
        s.state === 'unknown'
          ? // No receipt on the appliance (`outcome{not_found}`): “Not sent” only where the session would resend it
            // itself and it was never acknowledged (AP-572, AP-574, AP-577).
            !mayHaveRun && !c.acknowledged && resendAfterNotFound(apiOpName(c.endpoint))
            ? 'not_delivered'
            : 'unknown'
          : s.state === 'completed'
            ? // `redacted` (no result kept, CT-195) is done too: the caller fetches the current state.
              s.response.status >= 400 && s.response.status !== 403 && s.response.status !== 202
              ? 'rejected'
              : 'completed'
            : s.state;
      patch(requestId, {
        phase,
        checking: false,
        ...((s.state === 'accepted' || s.state === 'executing' || mayHaveRun) && { acknowledged: true }),
      });
      return phase;
    },
    get: (id) => commands.get(id),
    list: () => [...commands.values()],
    forget(id) {
      if (commands.delete(id)) changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      commands.clear();
      changed();
    },
  };
}
