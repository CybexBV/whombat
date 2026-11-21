/**
 * Durable command semantics (MA-09): client command states, the appliance receipt states answered to
 * `status`, and the idempotency digest bound to a request id.
 */
import { canonicalJson, sha256Hex } from '@whombat/core/audit';
import { z } from 'zod';

/**
 * Client-side state of a request:
 * `draft → pending_delivery → accepted → executing → completed | rejected | unknown`.
 * `accepted` means the appliance transaction committed (not that the relay saw a frame). `unknown` means the
 * outcome is ambiguous (connection lost or deadline passed before a verdict): query `status`; resend with the same
 * request id only as the op's classification allows (`resendAfterNotFound`, CT-194), never with a fresh one.
 */
export const CommandState = z.enum([
  'draft',
  'pending_delivery',
  'accepted',
  'executing',
  'completed',
  'rejected',
  'unknown',
]);
export type CommandState = z.infer<typeof CommandState>;

/**
 * Appliance-side state of a request id, as `outcome` reports it. `not_found`: no receipt — never committed, or its
 * finished receipt was swept after the retention. For a `receipt` op never seen `accepted` that means it never committed
 * (safe to resend with the same id); after `accepted` it means the receipt expired (`nextCommandState` keeps
 * `accepted`); a `never` op may have acted outside its receipt (CT-194).
 */
export const ReceiptState = z.enum(['not_found', 'accepted', 'executing', 'completed', 'rejected']);
export type ReceiptState = z.infer<typeof ReceiptState>;

export const TERMINAL_COMMAND_STATES: ReadonlySet<CommandState> = new Set(['completed', 'rejected']);

export type CommandEvent =
  /** The client hands the request to the session (or resends it with the same id). */
  | { type: 'send' }
  | { type: 'accepted' }
  /** An `event`/`outcome` shows the command running. */
  | { type: 'executing' }
  | { type: 'result' }
  /** An `error` for this request id: the appliance's definitive verdict. */
  | { type: 'error' }
  /** The session closed or the deadline passed without a verdict. */
  | { type: 'connection_lost' }
  /** Answer to `status`. */
  | { type: 'outcome'; receipt: ReceiptState };

/**
 * Pure transition function. Events that make no sense in a state leave it unchanged; terminal states never
 * change. Disconnects never regress accepted work (MA-09: "disconnects never cancel accepted work").
 */
export function nextCommandState(state: CommandState, event: CommandEvent): CommandState {
  if (TERMINAL_COMMAND_STATES.has(state)) return state;
  switch (event.type) {
    case 'send':
      return state === 'draft' || state === 'unknown' ? 'pending_delivery' : state;
    case 'accepted':
      return state === 'pending_delivery' || state === 'unknown' ? 'accepted' : state;
    case 'executing':
      return state === 'draft' ? state : 'executing';
    case 'result':
      return state === 'draft' ? state : 'completed';
    case 'error':
      return state === 'draft' ? state : 'rejected';
    case 'connection_lost':
      return state === 'pending_delivery' ? 'unknown' : state;
    case 'outcome':
      switch (event.receipt) {
        case 'not_found':
          // Never committed: the client may resend with the same id (`send`) if `resendAfterNotFound` (CT-194).
          return state === 'pending_delivery' ? 'unknown' : state;
        case 'accepted':
          return state === 'pending_delivery' || state === 'unknown' ? 'accepted' : state;
        case 'executing':
          return state === 'draft' ? state : 'executing';
        case 'completed':
          return state === 'draft' ? state : 'completed';
        case 'rejected':
          return state === 'draft' ? state : 'rejected';
      }
  }
}

/**
 * Idempotency digest: `sha256(canonicalJson({op, input}))`, lowercase hex. `(principal, op, requestId)` is
 * bound to it; a reused id with another digest is rejected with `idempotency_mismatch`.
 */
export function requestDigest(op: string, input: unknown): string {
  return sha256Hex(canonicalJson({ op, input: input === undefined ? null : input }));
}
