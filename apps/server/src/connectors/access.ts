/**
 * Who a connector tool acts as, and the calls it makes (docs/decisions/connectors.md "Tools",
 * connectors-google-tools.md GT-01…GT-03, one-agent.md OA-10): the agent in a turn for a person whose connection is
 * `active` and includes the service; every call acts as that connection with a token from `services.google.tokens`, and a 401 is
 * retried once with a forced refresh. Google's and the token store's errors become tool errors that say what
 * is wrong and how to fix it, naming the person.
 */
import {
  CONNECTOR_PROVIDER_LABELS,
  CONNECTOR_PROVIDERS,
  CONNECTOR_SERVICES,
  type ConnectorProvider,
  type ConnectorService,
  connectorMissingText,
  googleEnableApisUrl,
  serviceLabel,
} from '@whombat/core';
import type { Db } from '../db/client';
import { ApiError } from '../lib/errors';
import type { PrincipalRow } from '../read/principals';
import { shortName } from '../read/principals';
import type { Services } from '../services';
import { type AgentConnection, type ConnectionRow, connectionForAgent, scopeAccountOf } from './lookup';
import { providerMode } from './providers';
import { ConnectionUnavailableError, GoogleApiError } from './types';

/** The agent, the person and their usable connection (one-person.md OP-S51). */
export interface PersonalAccess {
  agent: PrincipalRow;
  person: PrincipalRow;
  /** “Mara”. */
  personName: string;
  accountId: string;
  connection: ConnectionRow;
  provider: ConnectorProvider;
}

/** An outsiders' turn (one-person.md OP-17): the person's mail, calendar and files stay out of it. */
export const NOT_PERSONAL_TEXT = 'Mail, calendar and files aren’t used when you answer someone from outside.';
export const GOOGLE_OFF_TEXT = 'Google isn’t turned on for this Whombat.';

export function reauthText(personName: string, provider: ConnectorProvider = 'google'): string {
  // A mailbox over IMAP (CM-D03): its server refused the stored password.
  if (provider === 'imap')
    return `${personName}’s mail account needs a new password. They can enter it in Settings → Connections → Email (IMAP).`;
  const label = provider === 'google' ? 'Google' : 'Microsoft';
  return `${personName}’s ${label} account needs you to sign in again. They can sign in again in Settings → Connections.`;
}

function refusal(message: string, details: Record<string, string>): ApiError {
  return new ApiError('not_allowed', message, { details });
}

/** “Google and Email (IMAP) both provide this service. Specify provider: google or imap for this task.” */
export function ambiguousText(providers: readonly ConnectorProvider[]): string {
  const names = providers.map((p) => CONNECTOR_PROVIDER_LABELS[p]);
  const ids = providers.join(' or ');
  const both =
    names.length === 2
      ? `Both ${names[0]} and ${names[1]}`
      : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${both} provide this service. Specify provider: ${ids} for this task.`;
}

/** The services the agent can use now in the person's connection (none in an outsiders' turn, or with Google off). */
export function usableServices(
  found: AgentConnection | null,
  mode: Services['google']['mode'],
): ConnectorService[] {
  const c = found?.connection;
  if (mode === 'off' || !c || c.status !== 'active') return [];
  return CONNECTOR_SERVICES.filter((s) => c.services.includes(s));
}

/**
 * The person's connection for a service (OP-S51). Throws `not_allowed` with the fix: an outsiders' turn, Google off, nothing connected (“Mara hasn’t connected Google Drive. …”), needs reauth.
 */
export async function personalAccess(
  services: Services,
  db: Db,
  agentId: string,
  service: ConnectorService,
  provider?: ConnectorProvider,
  /** The account the turn is for; default: the current turn's (null in an outsiders' turn). */
  forAccountId: string | null = scopeAccountOf(agentId),
): Promise<PersonalAccess> {
  if (!provider) {
    const connected = await Promise.all(
      CONNECTOR_PROVIDERS.map(async (p) => ({
        provider: p,
        found: await connectionForAgent(db, agentId, p, forAccountId),
      })),
    );
    const usable = connected.filter(
      (c) =>
        c.found?.connection?.status === 'active' &&
        c.found.connection.services.includes(service) &&
        providerMode(services, c.provider) !== 'off',
    );
    if (usable.length > 1)
      throw refusal(ambiguousText(usable.map((u) => u.provider)), {
        connector: service,
        reason: 'ambiguous_provider',
      });
    // Nothing usable: the one connected (it says why: needs a new password, the service missing), else Google's words.
    provider =
      usable[0]?.provider ??
      connected.find((c) => c.found?.connection?.services.includes(service))?.provider ??
      'google';
  }
  const found = await connectionForAgent(db, agentId, provider, forAccountId);
  if (!found) throw refusal(NOT_PERSONAL_TEXT, { connector: service, reason: 'not_personal' });
  if (providerMode(services, provider) === 'off')
    throw refusal(GOOGLE_OFF_TEXT, { connector: service, reason: 'off' });
  const personName = shortName(found.person);
  const c = found.connection;
  if (c?.status === 'needs_reauth')
    throw refusal(reauthText(personName, c.provider), { connector: service, reason: 'needs_reauth' });
  if (!c?.services.includes(service))
    throw refusal(connectorMissingText(personName, service, provider), {
      connector: service,
      reason: 'not_connected',
    });
  return {
    agent: found.agent,
    person: found.person,
    personName,
    accountId: found.accountId,
    connection: c,
    provider: c.provider,
  };
}

/**
 * Runs a call with a fresh access token for the account. Google answering 401 means the token went bad
 * before it expired: one retry with a forced refresh (the token store marks the connection `needs_reauth`
 * when the grant itself is gone).
 */
export async function withAccessToken<T>(
  services: Services,
  accountId: string,
  fn: (token: string) => Promise<T>,
  provider: ConnectorProvider = 'google',
): Promise<T> {
  const tokens = services.google.tokens;
  const token = await tokens.accessFor(accountId, provider);
  try {
    return await fn(token);
  } catch (err) {
    if (!(err instanceof GoogleApiError) || err.status !== 401) throw err;
    const fresh = await tokens.accessFor(accountId, provider, { forceRefresh: true });
    return fn(fresh);
  }
}

/**
 * A tool error from what went wrong behind a call. `forLog`: the text goes into the audit log (an approval
 * that failed), so Google's own message, which may quote an item, is left out.
 */
export function connectorError(
  err: unknown,
  access: Pick<PersonalAccess, 'personName' | 'provider'>,
  service: ConnectorService,
  options: { forLog?: boolean } = {},
): ApiError {
  if (err instanceof ApiError) return err;
  const label = serviceLabel(service, access.provider);
  const details = (reason: string, extra: Record<string, string> = {}) => ({
    details: { connector: service, reason, ...extra },
  });
  if (err instanceof ConnectionUnavailableError) {
    if (err.reason === 'needs_reauth')
      return new ApiError(
        'not_allowed',
        reauthText(access.personName, access.provider),
        details('needs_reauth'),
      );
    if (err.reason === 'no_app')
      return new ApiError(
        'not_allowed',
        `${access.provider === 'google' ? 'Google' : 'Microsoft'} isn’t set up on this Whombat yet. ${access.personName} can set it up in Settings → Connections.`,
        details('no_app'),
      );
    return new ApiError(
      'not_allowed',
      connectorMissingText(access.personName, service, access.provider),
      details('not_connected'),
    );
  }
  if (err instanceof GoogleApiError) {
    switch (err.reason) {
      case 'api_disabled': {
        const url = err.enableUrl ?? googleEnableApisUrl();
        return new ApiError(
          'not_allowed',
          `The ${label} API is turned off in this Whombat’s Google project. ${access.personName} can turn it on: ${url}`,
          details('api_disabled', { enableUrl: url }),
        );
      }
      case 'no_scope':
        return new ApiError(
          'not_allowed',
          `${access.personName} didn’t allow ${label} when connecting. They can connect it in Settings → Connections.`,
          details('no_scope'),
        );
      case 'unauthorized':
        return new ApiError(
          'not_allowed',
          reauthText(access.personName, access.provider),
          details('needs_reauth'),
        );
      case 'not_found':
        return new ApiError('not_found', `${label} has nothing with that id.`, details('not_found'));
      case 'rate_limited':
        return new ApiError(
          'rate_limited',
          `${label} is busy right now. Try again in a minute.`,
          details('rate_limited'),
        );
      default: {
        const logMessage = `${label} answered with an error (HTTP ${err.status}).`;
        return new ApiError(
          'conflict',
          options.forLog ? logMessage : `${label} answered: ${err.message}`.slice(0, 500),
          { ...details('provider_error'), logMessage },
        );
      }
    }
  }
  const logMessage = `${label} couldn’t be reached.`;
  return new ApiError(
    'internal',
    options.forLog
      ? logMessage
      : `${label} couldn’t be reached: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
    { ...details('network'), logMessage },
  );
}
