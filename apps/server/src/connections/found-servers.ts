/**
 * Servers on the home network (connect-in-chat.md): Found on your network also finds computers that answer SSH, so the
 * person can add them as servers from the list or the assistant's card, typing only the password.
 *
 * - **How.** Port 22 is one of the scan's ports. On an open one Whombat reads the server's greeting (the SSH banner, the
 *   first line the server sends before anything is asked: `SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u3`), at most 255 bytes
 *   in 1.5 s, and sends nothing. Its system (“Debian”) names it. Dropbear, the small SSH of routers and appliances, isn't
 *   a computer Whombat's helper runs on: left out.
 * - **Not twice.** A computer where an entry Whombat looks after best as a server was found (Proxmox VE, its Backup
 *   Server, Unraid) is that entry's row, which offers “Add as a server” itself; one where an appliance was found (a
 *   UniFi console, a firewall, a NAS, Home Assistant) is looked after through its connection, so its SSH isn't offered.
 * - **Added already.** A find at the address of one of the Whombat's servers (as its helper last reported it) names that
 *   server (`serverIds`) and is left out, as a connected service is (CS-52).
 */
import { connect } from 'node:net';
import { catalogEntry, FOUND_SERVER_ID } from '@whombat/core';
import { obj, str } from '../hosts/map';
import { hostsFor } from '../hosts/service';
import type { Services } from '../services';
import type { DiscoveryNet } from './finder';

/** The port computers answer SSH on. */
export const SSH_DISCOVERY_PORT = 22;

const BANNER_MS = 1500;
const BANNER_MAX = 255;

/**
 * Entries whose machine runs its own system: an SSH find there isn't a server to add (UniFi consoles, firewalls, NAS
 * boxes, Home Assistant OS).
 */
export const APPLIANCE_IDS: readonly string[] = [
  'homeassistant',
  'unifi_network',
  'unifi_protect',
  'unifi_access',
  'opnsense',
  'synology',
  'qnap',
  'truenas',
];

/** The systems a banner may name, as people write them. */
const SYSTEMS: readonly [RegExp, string][] = [
  [/\bubuntu\b/i, 'Ubuntu'],
  [/\braspbian\b/i, 'Raspberry Pi OS'],
  [/\bdebian\b|\bdeb\d+u\d+/i, 'Debian'],
  [/\bfreebsd\b/i, 'FreeBSD'],
  [/\bfedora\b|\.fc\d+\b/i, 'Fedora'],
  [/\.el\d+\b|\brhel\b/i, 'Red Hat'],
];

/**
 * What a server's SSH greeting says (pure): null when it isn't one or is an appliance's (Dropbear); else its system
 * when the banner names one (“Debian”), or null for a plain OpenSSH.
 */
export function readSshBanner(line: string): { system: string | null } | null {
  const m = /^SSH-(?:2\.0|1\.99)-(\S+)(?:\s+(.*))?$/.exec(line.trim());
  if (!m) return null;
  const software = m[1] ?? '';
  if (/^dropbear/i.test(software)) return null;
  const text = `${software} ${m[2] ?? ''}`;
  for (const [pattern, name] of SYSTEMS) if (pattern.test(text)) return { system: name };
  return { system: null };
}

/** Reads the first line an SSH server sends at `address`:`port`, or null. Sends nothing. */
export function probeSshAt(net: DiscoveryNet, address: string, port: number): Promise<string | null> {
  const target = net.dial ? net.dial(address, port) : { address, port };
  if (!target) return Promise.resolve(null);
  return new Promise((resolve) => {
    let text = '';
    const socket = connect({ host: target.address, port: target.port });
    const finish = (line: string | null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(line);
    };
    const timer = setTimeout(() => finish(null), BANNER_MS);
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      text += chunk;
      const end = text.indexOf('\n');
      if (end >= 0) finish(text.slice(0, end).replace(/\r$/, ''));
      else if (text.length > BANNER_MAX) finish(null);
    });
    socket.once('error', () => finish(null));
    socket.once('end', () => finish(null));
  });
}

/** A find, as far as these rules read it. */
interface FindLike {
  catalogId: string;
  host: string;
}

/**
 * The finds as the list shows them (pure, the order kept): a found server at a host where an entry best added as a
 * server, or an appliance, was found is left out (that row stands for the machine).
 */
export function withoutDoubleServers<F extends FindLike>(found: readonly F[]): F[] {
  const covered = new Set(
    found
      .filter((f) => f.catalogId !== FOUND_SERVER_ID)
      .filter((f) => catalogEntry(f.catalogId)?.asServer || APPLIANCE_IDS.includes(f.catalogId))
      .map((f) => f.host),
  );
  return found.filter((f) => f.catalogId !== FOUND_SERVER_ID || !covered.has(f.host));
}

/** A Whombat server at an address: its id and the address its helper last reported. */
export interface KnownServer {
  id: string;
  host: string;
}

/** The Whombat's servers by address (its helpers' `/agents` rows, cached by the hosts service); none when unknown. */
export async function knownServers(services: Services): Promise<KnownServer[]> {
  try {
    const rows = await hostsFor(services).agentsRaw();
    return rows.map(obj).flatMap((a) => {
      const id = str(a.server_id);
      const host = str(a.address)
        ?.trim()
        .replace(/\/\d{1,3}$/, '')
        .toLowerCase();
      return id && host ? [{ id, host }] : [];
    });
  } catch {
    // No hosts service (or it is down): nothing is known to be added.
    return [];
  }
}

/** The servers a find is (pure): those at its host, for a found server or an entry best added as one. */
export function serversAt(f: FindLike, servers: readonly KnownServer[]): string[] {
  if (f.catalogId !== FOUND_SERVER_ID && !catalogEntry(f.catalogId)?.asServer) return [];
  return servers.filter((s) => s.host === f.host.toLowerCase()).map((s) => s.id);
}
