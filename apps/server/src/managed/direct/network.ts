/**
 * Where the direct listener answers (hermes-engine.md HE-50, HE-51; direct-connection.md DC-03): a connection counts
 * only when it arrived on an interface the config names — `lan` (the box's own network cards), `tailscale0`, `loopback`
 * (development), or interface names — and came from where that way can come from: the local network's private, on-link
 * or link-local addresses, Tailscale's addresses, loopback. Anything else (a container bridge, a public address a
 * router forwarded) is not the local network and is closed before a byte is read. The firewall opens the port on the
 * same interfaces (N4); this is the runtime's own check behind it.
 */
import { BlockList, isIP } from 'node:net';
import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';

/**
 * `door`: a stream the relay's door handed the box on its own address (own-address.md). Not a network card: its
 * `remote` is the visitor's address as the door saw it, for fair sharing only.
 */
export type DirectNetwork = 'lan' | 'tailscale' | 'loopback' | 'door';

/** One way in the config: `lan`, `tailscale0`, `loopback`, or an interface name that counts as the local network. */
export type DirectInterfaceSpec = string;

/** Tailscale's ranges: CGNAT 100.64.0.0/10 and its ULA prefix. */
const TAILSCALE = new BlockList();
TAILSCALE.addSubnet('100.64.0.0', 10, 'ipv4');
TAILSCALE.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');

/** The local network's own ranges: RFC 1918, link-local, unique local. */
const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('169.254.0.0', 16, 'ipv4');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');
PRIVATE.addSubnet('fe80::', 10, 'ipv6');

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/**
 * Interfaces that are never the local network even under `lan`: container and VM bridges (the agent's containers'
 * among them, one-person.md OP-16), tunnels. A LAN bridge the box itself sits on (`br0`) is not among them.
 */
const VIRTUAL = /^(incusbr|lxdbr|virbr|docker|br-|veth|vnet|tap|tun|podman|cni|flannel|wg|tailscale)/;

/** `::ffff:10.0.0.5` → `10.0.0.5`; a zone (`fe80::1%eth0`) dropped. */
export function plainAddress(address: string): string {
  const bare = address.split('%')[0] ?? address;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  return mapped?.[1] ?? bare;
}

function family(address: string): 'ipv4' | 'ipv6' | null {
  const v = isIP(address);
  return v === 4 ? 'ipv4' : v === 6 ? 'ipv6' : null;
}

function inList(list: BlockList, address: string): boolean {
  const f = family(address);
  return f !== null && list.check(address, f);
}

/** A private address (RFC 1918, link-local, unique local): the only peers the image's firewall lets reach the port. */
export function isPrivateAddress(address: string): boolean {
  return inList(PRIVATE, plainAddress(address));
}

export function isTailscaleAddress(address: string): boolean {
  return inList(TAILSCALE, plainAddress(address));
}

export function isLoopbackAddress(address: string): boolean {
  return inList(LOOPBACK, plainAddress(address));
}

export type InterfaceTable = NodeJS.Dict<NetworkInterfaceInfo[]>;

export interface DirectArrival {
  network: DirectNetwork;
  /** The interface the connection arrived on. */
  iface: string;
  /** The box's own address it arrived at (plain). */
  local: string;
  /** The peer's address (plain). */
  remote: string;
}

/**
 * Which way a connection came in, or null when it isn't one the listener takes. `interfaces` defaults to the host's
 * (`os.networkInterfaces()`), read per call (cheap; a DHCP change or Tailscale coming up needs no restart).
 */
export function arrival(
  specs: readonly DirectInterfaceSpec[],
  localAddress: string | undefined,
  remoteAddress: string | undefined,
  interfaces: InterfaceTable = networkInterfaces(),
): DirectArrival | null {
  if (!localAddress || !remoteAddress) return null;
  const local = plainAddress(localAddress);
  const remote = plainAddress(remoteAddress);
  for (const [iface, infos] of Object.entries(interfaces)) {
    const info = infos?.find((i) => plainAddress(i.address) === local);
    if (!info) continue;
    const network = networkOf(specs, iface, info);
    if (!network) return null;
    return remoteFits(network, remote, info) ? { network, iface, local, remote } : null;
  }
  return null;
}

function networkOf(
  specs: readonly DirectInterfaceSpec[],
  iface: string,
  info: NetworkInterfaceInfo,
): Exclude<DirectNetwork, 'door'> | null {
  if (info.internal) return specs.includes('loopback') ? 'loopback' : null;
  if (iface.startsWith('tailscale'))
    return specs.includes(iface) || specs.includes('tailscale0') ? 'tailscale' : null;
  if (specs.includes(iface)) return 'lan';
  if (specs.includes('lan') && !VIRTUAL.test(iface)) return 'lan';
  return null;
}

/** Whether the peer is where that way comes from (a public address on a LAN card is someone's port forward). */
function remoteFits(network: DirectNetwork, remote: string, info: NetworkInterfaceInfo): boolean {
  if (network === 'loopback') return inList(LOOPBACK, remote);
  if (network === 'tailscale') return inList(TAILSCALE, remote);
  if (inList(PRIVATE, remote)) return true;
  // On the same link: a global IPv6 address of the home's own prefix.
  const f = family(remote);
  if (!f || !info.cidr || (f === 'ipv4') !== (info.family === 'IPv4')) return false;
  const [net, prefix] = info.cidr.split('/');
  if (!net || !prefix) return false;
  const link = new BlockList();
  link.addSubnet(net, Number(prefix), f);
  return link.check(remote, f);
}

/** The box's addresses on the ways the config names, by network (for the routes it tells clients, DC-12). */
export function interfaceAddresses(
  specs: readonly DirectInterfaceSpec[],
  interfaces: InterfaceTable = networkInterfaces(),
): { network: Exclude<DirectNetwork, 'door'>; iface: string; address: string; family: 'IPv4' | 'IPv6' }[] {
  const out: {
    network: Exclude<DirectNetwork, 'door'>;
    iface: string;
    address: string;
    family: 'IPv4' | 'IPv6';
  }[] = [];
  for (const [iface, infos] of Object.entries(interfaces))
    for (const info of infos ?? []) {
      const network = networkOf(specs, iface, info);
      if (!network) continue;
      // Link-local IPv6 needs a zone a URL can't carry: not a way to tell anyone.
      if (info.family === 'IPv6' && info.address.toLowerCase().startsWith('fe80:')) continue;
      out.push({ network, iface, address: plainAddress(info.address), family: info.family });
    }
  return out;
}

/**
 * Whether the box's network gave it an IPv6 address and no IPv4 one: its local network's cards have at least one IPv6
 * address, of any kind (link-local and public ones count, though neither is a way to tell anyone), and no IPv4 address.
 */
export function lanIpv6Only(
  specs: readonly DirectInterfaceSpec[],
  interfaces: InterfaceTable = networkInterfaces(),
): boolean {
  let v6 = false;
  for (const [iface, infos] of Object.entries(interfaces))
    for (const info of infos ?? []) {
      if (networkOf(specs, iface, info) !== 'lan') continue;
      if (info.family === 'IPv4') return false;
      v6 = true;
    }
  return v6;
}

/** Parses `WHOMBAT_DIRECT_INTERFACES` (comma list). */
export function parseInterfaceSpecs(value: string): DirectInterfaceSpec[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}
