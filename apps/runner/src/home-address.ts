/**
 * The Whombat's address on the home network (one-person.md OP-19, OP-S135): what the link to one of the agent's services
 * names, as the server lists it (`agent-services/service.ts` `homeNetworkAddress`): the first IPv4 address of a network
 * card that isn't virtual, a tunnel or Tailscale, else such an IPv6 address (not link-local); null when there is none.
 */
import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';

/** Cards that aren't the home network (the server's `managed/direct/network.ts` `VIRTUAL`). */
const VIRTUAL = /^(incusbr|lxdbr|virbr|docker|br-|veth|vnet|tap|tun|podman|cni|flannel|wg|tailscale)/;

export function homeNetworkAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string | null {
  const lan: NetworkInterfaceInfo[] = [];
  for (const [name, infos] of Object.entries(interfaces))
    for (const info of infos ?? [])
      if (!info.internal && !VIRTUAL.test(name) && !info.address.toLowerCase().startsWith('fe80:'))
        lan.push(info);
  const found = lan.find((i) => i.family === 'IPv4') ?? lan[0];
  if (!found) return null;
  return found.family === 'IPv6' ? `[${found.address}]` : found.address;
}
