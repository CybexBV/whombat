/**
 * The person's accounts, in a turn's preface (one-person.md OP-01; connectors.md PA-10, CM-19): which are connected
 * (every call to one acts as that account), which provider to name when two accounts share a service, and what to say
 * about a service they haven't connected. The privacy rules are `whombat.md`'s; the guided setups are `start_guide`'s
 * description.
 */
import type { OnBehalfOfContext } from '@whombat/core/contracts';
import {
  CONNECTOR_PROVIDER_LABELS,
  CONNECTOR_SERVICES,
  type ConnectorService,
  connectorMissingText,
  serviceLabel,
  shortNameOf,
} from '@whombat/core/domain';

export function personalLines(personal: OnBehalfOfContext): string[] {
  const owner = personal.person;
  const first = shortNameOf({ kind: 'person', name: owner.name });
  const connected = new Set<ConnectorService>();
  const accounts = personal.connections.map((c) => {
    for (const service of c.services) connected.add(service);
    const services = c.services.map((service) => serviceLabel(service, c.provider)).join(', ');
    return `${CONNECTOR_PROVIDER_LABELS[c.provider]} as ${c.email}${services ? ` (${services})` : ''}`;
  });
  const lines = [
    accounts.length
      ? `${first}’s connected accounts: ${accounts.join('; ')}. Every call to one acts as that account.`
      : `${first} hasn’t connected an account yet.`,
  ];
  // Two accounts with the same service (Gmail and a mailbox over IMAP): the tools need to be told which one.
  const shared = CONNECTOR_SERVICES.filter(
    (service) => personal.connections.filter((c) => c.services.includes(service)).length > 1,
  );
  if (shared.length)
    lines.push(
      `More than one account has ${shared.map((s) => serviceLabel(s)).join(', ')}: pass provider (${personal.connections.map((c) => c.provider).join(', ')}) to say which one each call uses.`,
    );
  const missing = CONNECTOR_SERVICES.filter((service) => !connected.has(service));
  if (missing.length)
    lines.push(
      `Not connected: ${missing.map((service) => serviceLabel(service, 'google')).join(', ')}. When ${first} asks for one of these, say so plainly: “${connectorMissingText(first, missing[0] as ConnectorService)}” (name the service they asked about).`,
    );
  return lines;
}
