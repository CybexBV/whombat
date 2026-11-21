/**
 * Where a connection may call (docs/decisions/connections-catalog.md CX-40): public `https` hosts, or a host on the
 * the home-network list (`vault_networks`, VT-12) with its port, where `http` is allowed too. One rule and one list
 * for the Vault and Connections: this reuses the Vault's (`vault/net.ts`), checked when a connection is saved
 * (`connectionDestinationProblem`, the reason in full) and on every call (`connectionPolicy`, DNS pinned to the checked
 * addresses, no redirects, a 30 s deadline, capped bodies).
 */
import type { VaultDestinationProblem } from '@whombat/core';
import type { OutboundPolicy } from '../lib/outbound';
import type { Services } from '../services';
import { destinationProblem, type VaultFetchOptions, vaultDestinationPolicy } from '../vault/net';

export interface ConnectionPolicyOptions extends VaultFetchOptions {
  /** A self-signed certificate on the home network, pinned by its SHA-256 fingerprint (Proxmox, CX-60). */
  pinnedCertSha256?: string;
}

/**
 * The outbound policy of one call to `url` (the connection's base or MCP URL decides; requests stay on its origin). A
 * pinned certificate holds only for home-network addresses (`lib/outbound.ts` refuses it anywhere else). The rule reads
 * the scheme, host and port only: a request's query (`?per_page=50`) is left out, as the Vault's address rule refuses
 * any `?…` (CX-40a).
 */
export async function connectionPolicy(
  services: Services,
  url: string,
  options: ConnectionPolicyOptions = {},
): Promise<OutboundPolicy> {
  const { pinnedCertSha256, ...rest } = options;
  const policy = await vaultDestinationPolicy(services, withoutQuery(url), rest);
  return pinnedCertSha256 ? { ...policy, pinnedCertSha256 } : policy;
}

/** `url` without its query and fragment (an unparsable URL as it is: the rule refuses it). */
function withoutQuery(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Why a connection may not call `url` now, or null (CX-40, CX-41): `save` gives the reason in full (with the network to
 * add, `suggestion`), `call` the short “isn’t allowed any more”.
 */
export function connectionDestinationProblem(
  services: Services,
  url: string,
  at: 'save' | 'call' = 'save',
): Promise<VaultDestinationProblem | null> {
  return destinationProblem(services, url, at);
}
