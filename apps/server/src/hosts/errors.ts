/**
 * The hosts service's refusals in Whombat's words (one-whombat-servers.md ONE-DH11): its code picks the contract error
 * and a short plain sentence; field errors pass through for forms; the service's own sentence is kept only where it is
 * the platform's (a Proxmox message) or names the field. `HostsUnavailable` is a 503 `unavailable` (contracts 0.80.1,
 * CT-346) with `details.code: hosts_unavailable`.
 */
import { type ErrorCode, HOST_ERROR_WORDS, type HostAgentUpdateReasonCode } from '@whombat/core';
import { ApiError } from '../lib/errors';
import { agentUpdateRefusalText } from './agent-updates';
import { HostsError, HostsUnavailable } from './client';
import { HOSTS_TEXT } from './service';
import { packagesRefusalText } from './updates';

/**
 * Whom and what a refusal is about: the server's and guest's names, and the manage op (`packages.install`, …, or
 * `agent.update` for Update now); `agentReason`: why the server's agent can't be updated, as Whombat read it just before.
 */
export interface HostsNames {
  server?: string;
  guest?: string;
  op?: string;
  agentReason?: HostAgentUpdateReasonCode;
}

/** The service's sentence as one of ours: capitalised, one line, ending in a full stop. */
function sentence(detail: string): string {
  const line = detail.split(/\r?\n/)[0]?.trim().slice(0, 300) ?? '';
  const capped = `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
  return /[.!?…]$/.test(capped) ? capped : `${capped}.`;
}

/**
 * Whether the service refused a change before acting: a 4xx, or a 501 (`unsupported`, also an older agent's “unknown
 * operation”). Any other 5xx may have acted.
 */
export function refusedBeforeActing(err: unknown): boolean {
  return err instanceof HostsError && ((err.status >= 400 && err.status < 500) || err.status === 501);
}

/** The words for a code (the server's or guest's name filled in where it helps; a Check's or Install's in SWU's). */
export function hostsErrorText(err: HostsError, names: HostsNames = {}): string {
  if (names.op === 'agent.update') {
    const words = agentUpdateRefusalText(err, names.server ?? 'the server', names.agentReason);
    if (words) return words;
  }
  if (names.op?.startsWith('packages.')) {
    const words = packagesRefusalText(err, names.op, names.server ?? 'the server');
    if (words) return words;
  }
  const server = names.server ?? 'The server';
  const guest = names.guest ?? 'That guest';
  // A Mac's screen (macos-servers.md): it goes with commands, and only a Mac has one.
  if (names.op === 'screen') {
    if (err.code === 'host_shell_disabled' || err.code === 'remote_control_disabled')
      return `Commands and the screen are switched off on ${names.server ?? 'this Mac'}.`;
    if (err.code === 'unsupported')
      return `${server} can’t do that: it isn’t a Mac, or its Whombat helper needs an update.`;
  }
  switch (err.code) {
    case 'agent_offline':
      return `${server} isn’t connected right now, so it can’t do that.`;
    case 'server_not_found':
      return `There’s no server called ${names.server ?? 'that'}.`;
    case 'guest_not_found':
    case 'unknown_guest':
      return `${guest} isn’t on ${names.server ?? 'that server'}.`;
    case 'console_disabled':
      return 'Consoles are switched off for this server.';
    case 'power_disabled':
      return 'Starting and stopping guests is switched off for this server.';
    case 'host_shell_disabled':
      return 'Commands on this server are switched off.';
    case 'host_power_disabled':
      return 'Restarting this server from Whombat is switched off.';
    case 'manage_disabled':
    case 'remote_control_disabled':
      return 'Changing guests is switched off for this server.';
    case 'diagnose_disabled':
      return 'Read-only checks are switched off for this server.';
    case 'confirm_required':
      return 'This needs a confirmation first.';
    case 'digest_mismatch':
      return 'Changed meanwhile — review again.';
    case 'action_in_progress':
    case 'busy':
    case 'locked':
      return 'Something else is still running there. Try again in a moment.';
    case 'not_allowed':
      // A server-wide refusal (a backup job without storage) is the agent's own plain sentence.
      if (!names.guest && err.detail) return sentence(err.detail);
      return HOST_ERROR_WORDS.not_allowed;
    case 'self_guest':
      return HOST_ERROR_WORDS.self_guest;
    case 'in_use':
      return HOST_ERROR_WORDS.in_use;
    case 'guest_running':
      return `${guest} has to be stopped first.`;
    case 'guest_not_running':
      return `${guest} isn’t running.`;
    case 'protected':
      return 'It’s protected, so it can’t be removed.';
    case 'exists':
    case 'server_exists':
      return 'Something with that name is already there.';
    case 'not_pending':
      return 'It isn’t waiting any more.';
    case 'alert_not_open':
      return 'That alert isn’t open any more.';
    case 'no_agent_url':
      return 'Whombat can’t tell which address your servers should reach it at. Check the box’s network connection.';
    case 'unknown_check':
      return 'That check isn’t available on this server. Leave the check out to see the list.';
    case 'invalid_request':
      return err.detail ?? 'The server refused that.';
    case 'session_limit':
      return 'Too many consoles are open. Close one and try again.';
    case 'rate_limited':
      return 'Too many refused tries. Wait a few minutes.';
    case 'unsupported':
    case 'unsupported_action':
      if (!names.guest && err.detail) return sentence(err.detail);
      return names.guest
        ? 'That isn’t possible on this kind of guest.'
        : 'That isn’t possible on this server.';
    case 'protocol_unavailable':
    case 'console_unavailable':
      return 'That console isn’t available for this guest.';
    case 'audit_unavailable':
    case 'shutting_down':
    case 'inventory_unavailable':
      return 'Whombat’s server monitoring can’t do that right now. Try again in a moment.';
    case 'timeout':
      return `${server} didn’t answer in time. It may still be working on it.`;
    case 'platform_error':
      return err.detail ? `The platform said: ${err.detail}` : `${server} couldn’t do it.`;
    case 'agent_error':
      return `${server} didn’t answer as expected.`;
    default:
      if (err.status === 404) return 'That isn’t there any more.';
      if (err.status === 400 && err.detail) return err.detail;
      return `${server} couldn’t do that.`;
  }
}

/** The contract code for a hosts code. */
function codeOf(err: HostsError): ErrorCode {
  if (err.status === 404) return 'not_found';
  if (err.status === 429) return 'rate_limited';
  if (err.code === 'confirm_required') return 'bad_request';
  if (err.status === 400) return err.fieldErrors ? 'validation_failed' : 'bad_request';
  if (err.status === 403) return 'not_allowed';
  if (err.status === 401) return 'conflict';
  return 'conflict';
}

/** Any error from a hosts call as an `ApiError` (others are rethrown as they are). */
export function toApiError(err: unknown, names: HostsNames = {}): unknown {
  if (err instanceof HostsUnavailable)
    return new ApiError(
      'unavailable',
      err.reason === 'not_configured'
        ? HOSTS_TEXT.absent
        : err.reason === 'no_token'
          ? HOSTS_TEXT.noToken
          : err.reason === 'timeout'
            ? `${names.server ?? 'Whombat’s server monitoring'} didn’t answer in time.`
            : HOSTS_TEXT.down,
      { details: { code: 'hosts_unavailable' } },
    );
  if (err instanceof HostsError) {
    const fields = err.fieldErrors
      ? Object.fromEntries(Object.entries(err.fieldErrors).map(([k, v]) => [k, [v]]))
      : undefined;
    return new ApiError(codeOf(err), hostsErrorText(err, names), {
      ...(err.status >= 500 ? { status: 409 } : {}),
      details: { code: err.code },
      ...(fields ? { fields } : {}),
    });
  }
  return err;
}

/** Runs a hosts call, turning its errors into `ApiError`s. */
export async function hostsCall<T>(fn: () => Promise<T>, names: HostsNames = {}): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toApiError(err, names);
  }
}
