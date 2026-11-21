/**
 * GitHub on a managed appliance (docs/decisions/managed-providers.md PV-06): an agent's git fetches and pushes use a
 * person's own GitHub sign-in in their credential home (`<root>/<account>/github`, gh's `hosts.yml`, from the device
 * flow or a pasted token) — never the host's gh account. No usable sign-in: the git operation is refused with the reason
 * and where a person fixes it.
 *
 * Whose (resourceful-agents.md RA-DS51, John: “We should not have to assign a developer agent to GitHub, this should be
 * the default setting”): the burrow's GitHub connection covers the agent: it works as the person who connected GitHub
 * (Settings → Connections → GitHub). One connected by someone who isn't on the box any more (one-person.md OP-S02) is
 * never used.
 *
 * The sign-ins are read wherever this runtime holds them (`signInsAvailable`, SUB-56): the appliance gives the
 * credentials root to the runner alone (appliance NX-20) and the server reads a token through the runner's sign-in
 * bridge, so the server's own `WHOMBAT_CREDENTIALS_ROOT` is never what decides (RA-DS50).
 */
import { ApiError } from '../../lib/errors';
import { loadPrincipalRow } from '../../read/principals';
import type { Services } from '../../services';
import { burrowGitHubOwner, type ConnectionOwner, NO_GITHUB_CONNECTION } from './github-adapter';
import { providerLogins, signInsAvailable } from './service';

export { NO_GITHUB_CONNECTION };

/** This runtime can't hold sign-ins at all (`signInsAvailable` false): a setup problem, not something the person fixes. */
export const NO_SIGNINS_HERE =
  'This Whombat has no place for sign-ins, so its agents can’t reach GitHub. Whoever runs it sets up where sign-ins are kept.';

/** The connection was made from an account that isn't on this Whombat any more: it is never used again. */
export function connectorLeftText(name: string): string {
  return `${name} connected GitHub from an account that isn’t on this Whombat any more. Connect it again in Settings → Connections → GitHub.`;
}

/** The connection's person has no GitHub sign-in any more (signed out, or it was removed). */
export function connectorSignedOutText(name: string): string {
  return `GitHub is connected as ${name}’s own GitHub sign-in, which is gone. Sign in to GitHub again in Settings → Connections → GitHub.`;
}

const refused = (message: string, code: string) => new ApiError('conflict', message, { details: { code } });

/**
 * The GitHub token for one of an agent's git operations (RA-DS51). Tokens from gh's device flow don't expire; the hour
 * is how long the runner may use this one (and a push grant counts).
 */
export async function managedGitToken(
  services: Services,
  agentId: string | undefined,
  burrowId?: string,
): Promise<{ token: string; expiresAt: string }> {
  if (!signInsAvailable(services.config)) throw refused(NO_SIGNINS_HERE, 'provider.not_configured');
  const agent = agentId ? await loadPrincipalRow(services.db, agentId) : undefined;
  const burrow = burrowId ?? agent?.burrowId;
  const logins = providerLogins(services);
  const token = async (_accountId: string) => {
    const value = await logins.githubToken();
    return value
      ? { token: value, expiresAt: new Date(services.clock().getTime() + 3600_000).toISOString() }
      : null;
  };

  if (agent && agent.kind !== 'agent') throw refused(NO_GITHUB_CONNECTION, 'provider.owner_required');
  // The agent: the burrow's GitHub connection covers it (one-agent.md OA-11).
  const connection: ConnectionOwner | null = burrow ? await burrowGitHubOwner(services, burrow) : null;
  if (connection?.accountId && connection.present) {
    const found = await token(connection.accountId);
    if (found) return found;
  }
  // Nothing usable: why, in words that say where it is fixed.
  if (!connection?.accountId) throw refused(NO_GITHUB_CONNECTION, 'provider.owner_required');
  if (!connection.present) throw refused(connectorLeftText(connection.name), 'provider.owner_departed');
  throw refused(connectorSignedOutText(connection.name), 'provider.not_signed_in');
}
