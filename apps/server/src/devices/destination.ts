/**
 * Where Whombat may reach a device (docs/decisions/one-whombat-devices.md): only on the local network, under the same
 * rule as the Vault and Connections (`vaultDestinationProblem`: the whole local network when it is open, LN-01, else the
 * home network list with its port; never loopback, link-local, metadata or this host's plumbing, LN-02). A device on the
 * internet is refused: the drivers speak plain Modbus and HTTP, which never cross it.
 *
 * The host is resolved once and the driver dials one of exactly the checked addresses (DNS pinned). Tests stand fakes on
 * 127.0.0.1 behind home-network addresses through the Vault's seam (`useVaultNetForTests`); no check is relaxed.
 */
import { addressIsPublic, parseVaultUrl, vaultDestinationProblem } from '@whombat/core';
import type { Services } from '../services';
import { resolveHost, vaultNetOf } from '../vault/net';
import { destinationReach } from '../vault/store';

export class DeviceDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceDestinationError';
  }
}

export const DEVICE_INTERNET_TEXT =
  'Whombat talks to devices on your local network only, and that address is on the internet.';

/** `http://host:port/` for the destination rule (it reads scheme, host and port). */
export function deviceRuleUrl(host: string, port: number): string {
  const literal = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${literal}:${port}/`;
}

/**
 * The address to dial for `host`:`port`, checked now (`at: 'call'` says the short “isn’t allowed any more”). Throws
 * `DeviceDestinationError` with a sentence for the agent.
 */
export async function deviceDialAddress(
  services: Services,
  host: string,
  port: number,
  at: 'save' | 'call' = 'save',
): Promise<string> {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new DeviceDestinationError('A port is 1–65535.');
  const url = deviceRuleUrl(host.trim(), port);
  const parsed = parseVaultUrl(url);
  if (!parsed.ok) throw new DeviceDestinationError('That isn’t a host name or an address.');
  const resolved = parsed.url.hostKind === 'name' ? await resolveHost(services, url) : [parsed.url.host];
  if (resolved.length === 0) throw new DeviceDestinationError('That host name doesn’t resolve.');
  if (resolved.some((a) => addressIsPublic(a))) throw new DeviceDestinationError(DEVICE_INTERNET_TEXT);
  const reach = await destinationReach(services);
  const problem = vaultDestinationProblem({ url, resolved, ...reach, at });
  if (problem) {
    const message =
      problem.code === 'never'
        ? 'Whombat can’t reach that address: it isn’t a device on your local network.'
        : problem.code === 'not_listed' && at === 'save'
          ? problem.message.replace(' in the Vault', '')
          : at === 'call'
            ? 'This device’s address isn’t allowed any more. Check the local network settings.'
            : problem.message;
    throw new DeviceDestinationError(message);
  }
  const address = resolved[0] as string;
  const dial = vaultNetOf(services).dialAddress;
  return dial ? dial(address) : address;
}
