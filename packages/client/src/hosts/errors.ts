/**
 * What a refused server change says (AP-1310): Whombat's server words the hosts service's refusals (its code in
 * `details.code`), so the screens show the message as it is; a configuration changed meanwhile (`digest_mismatch`)
 * asks for another review, field errors go back to their fields, and an approval or a missing key is said plainly.
 */
import { ApiError, NetworkError } from '../http/errors';
import type { CommitResult } from '../http/types';

export const CHANGED_MEANWHILE = 'Changed meanwhile — review again.';

export interface HostErrorInfo {
  message: string;
  /** The service's code (`agent_offline`, `digest_mismatch`, …). */
  code: string | null;
  /** The configuration changed meanwhile: reload it and review again. */
  conflict: boolean;
  /** Config key → what is wrong. */
  fields: Record<string, string>;
}

function serviceCode(err: ApiError): string | null {
  const d = err.details as { code?: unknown } | undefined;
  return typeof d?.code === 'string' ? d.code : null;
}

function rawErrorCode(err: ApiError): string | null {
  const code = (err.body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' ? code : null;
}

export function hostErrorInfo(err: unknown): HostErrorInfo {
  if (err instanceof ApiError) {
    if (rawErrorCode(err) === 'unknown_op')
      return {
        message: 'Update this Whombat to use this feature.',
        code: 'unknown_op',
        conflict: false,
        fields: {},
      };
    const code = serviceCode(err);
    const conflict = code === 'digest_mismatch';
    const fields = Object.fromEntries(
      Object.entries(err.fields ?? {})
        .filter(([, v]) => v.length)
        .map(([k, v]) => [k.replace(/^(body\.)?(params\.)?(set\.)?/, ''), v.join(' ')]),
    );
    return {
      message: conflict ? CHANGED_MEANWHILE : err.message || 'That didn’t work.',
      code,
      conflict,
      fields,
    };
  }
  if (err instanceof NetworkError)
    return { message: 'Whombat can’t be reached right now.', code: 'network', conflict: false, fields: {} };
  return {
    message: err instanceof Error && err.message ? err.message : 'That didn’t work.',
    code: null,
    conflict: false,
    fields: {},
  };
}

/** A change's outcome that didn't go straight through, in words; null when it did. */
export function commitOutcomeText(result: CommitResult<unknown>): string | null {
  if (result.status === 'ok') return null;
  if (result.status === 'pending_approval')
    return 'That needs an approval first. You’ll find it in the Inbox.';
  return result.message || 'You don’t have the key for that.';
}

/** Whether the service is missing or down (`hosts_unavailable`). */
export function isHostsUnavailable(err: unknown): boolean {
  return err instanceof ApiError && serviceCode(err) === 'hosts_unavailable';
}
