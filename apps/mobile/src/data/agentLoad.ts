/**
 * Why Settings → Agent didn't load, said as what it is (AP-707; one-agent.md AP-4965): it used to say one thing for
 * every failure — on John's phone a far older app than its Whombat, which reads the agent's keys strictly (AP-266).
 * Pure.
 */
import { ApiError, ContractError, NeedsNewerAppError, NetworkError } from '@whombat/client';
import { licenceRefusalText } from '@whombat/client/managed';

export type AgentLoadProblem =
  /** Its keys don't match this app (`NeedsNewerAppError`): the update path, no Try again. */
  | { kind: 'newer' }
  /** Not here (404): nothing to try again. */
  | { kind: 'gone'; text: string }
  /** Offline, the Whombat's licence, anything else: what happened and Try again. */
  | { kind: 'retry'; text: string };

export const AGENT_GONE_TEXT = 'This isn’t here any more.';
export const AGENT_OFFLINE_TEXT = 'Can’t reach your Whombat. Check your connection and try again.';
export const AGENT_FAILED_TEXT = 'Couldn’t load these settings. Try again in a moment.';

export function agentLoadProblem(error: unknown): AgentLoadProblem {
  if (error instanceof NeedsNewerAppError) return { kind: 'newer' };
  if (error instanceof ApiError && (error.status === 404 || error.code === 'not_found'))
    return { kind: 'gone', text: AGENT_GONE_TEXT };
  if (error instanceof NetworkError) return { kind: 'retry', text: AGENT_OFFLINE_TEXT };
  const licence = licenceRefusalText(error);
  if (licence) return { kind: 'retry', text: licence };
  if (error instanceof ApiError && error.status !== 500 && error.message)
    return { kind: 'retry', text: error.message };
  return { kind: 'retry', text: AGENT_FAILED_TEXT };
}

/**
 * The fields an answer didn't match, for the log (`adb logcat`, AP-707): “agent.get: grants.3.keyId: Invalid option”.
 * Paths and zod's messages only, never the values. Null for any other error.
 */
export function contractMismatchLine(error: unknown): string | null {
  if (!(error instanceof ContractError)) return null;
  const fields = Object.entries(error.fields).map(
    ([path, messages]) => `${path || '(root)'}: ${messages.join(', ')}`,
  );
  return `${error.endpointId}: ${fields.join('; ') || 'does not match'}`;
}
