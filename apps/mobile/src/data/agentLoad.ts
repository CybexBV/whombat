/**
 * Why Settings → Agent didn't load, said as what it is (AP-707; one-agent.md AP-4965): it used to say one thing for
 * every failure — on John's phone a far older app than its Whombat, which reads the agent's keys strictly (AP-266).
 * Pure.
 */
import { ApiError, ContractError, NeedsNewerAppError, NetworkError } from '@whombat/client';
import { licenceRefusalText } from '@whombat/client/managed';
import { mobileTranslator } from '../i18n/translate';

export type AgentLoadProblem =
  /** Its keys don't match this app (`NeedsNewerAppError`): the update path, no Try again. */
  | { kind: 'newer' }
  /** Not here (404): nothing to try again. */
  | { kind: 'gone'; text: string }
  /** Offline, the Whombat's licence, anything else: what happened and Try again. */
  | { kind: 'retry'; text: string };

export const AGENT_GONE_TEXT = mobileTranslator().t('data.agentLoad.gone');
export const AGENT_OFFLINE_TEXT = mobileTranslator().t('data.agentLoad.offline');
export const AGENT_FAILED_TEXT = mobileTranslator().t('data.agentLoad.failed');

export function agentLoadProblem(error: unknown, locale?: string): AgentLoadProblem {
  const { t } = mobileTranslator(locale);
  if (error instanceof NeedsNewerAppError) return { kind: 'newer' };
  if (error instanceof ApiError && (error.status === 404 || error.code === 'not_found'))
    return { kind: 'gone', text: t('data.agentLoad.gone') };
  if (error instanceof NetworkError) return { kind: 'retry', text: t('data.agentLoad.offline') };
  const licence = licenceRefusalText(error, locale);
  if (licence) return { kind: 'retry', text: licence };
  if (error instanceof ApiError && error.status !== 500 && error.message)
    return { kind: 'retry', text: error.message };
  return { kind: 'retry', text: t('data.agentLoad.failed') };
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
