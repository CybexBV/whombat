/**
 * The guest this Whombat runs in (docs/decisions/incus-unraid.md IU-02; the build brief §2.1): the hub marks it `self`
 * and its server `hosts_this_whombat`. Changing it is refused here before the hub is asked (the hub refuses too), with
 * “That’s this Whombat itself.”; what stays allowed is the contract's `HOST_SELF_GUEST_ALLOWED` (snapshots, backups,
 * copies, consoles). Restarting or shutting down the server it runs on
 * still works, but the question says the Whombat goes down with it, so this module remembers which servers those are
 * (from every fleet read) for the approval's words, which are written without a lookup. The same memory names the server
 * a Servers call is about when Whombat decides whether it asks (server-asks.md SA-06).
 */
import {
  HOST_ERROR_WORDS,
  HOST_SELF_GUEST_ALLOWED,
  type HostGuestAction,
  type HostManageOp,
  selfGuestAllows,
} from '@whombat/core';
import { arr, obj } from './map';

export const SELF_GUEST_TEXT = HOST_ERROR_WORDS.self_guest;

/** Whether a power or snapshot action (the hub's names) is refused on the self guest (`HOST_SELF_GUEST_ALLOWED`). */
export function selfActionRefused(action: string): boolean {
  return !(HOST_SELF_GUEST_ALLOWED.actions as readonly string[]).includes(action as HostGuestAction);
}

/**
 * Whether a manage op on the self guest is refused (`selfGuestAllows`): a restore stays allowed when it makes a new
 * guest — always on Incus, on Proxmox with a new id or no guest to go over.
 */
export function selfOpRefused(op: string, asNew = false): boolean {
  return !selfGuestAllows({ op: op as HostManageOp, asNew });
}

/* The servers as the last fleet read named them ------------------------------------------------------------------- */

/** A server as calls name it (server-asks.md SA-06): its id, the name messages give it, and whether it runs Whombat. */
export interface KnownServer {
  id: string;
  /** The name a person gave it (“The Titan”), else the host name when it is the id with its own capitals (“BlackBox”), else the id. */
  name: string;
  hostsThisWhombat: boolean;
}

/** Every server of the last fleet read, by id, host name and given name (lower case). */
const known = new Map<string, KnownServer>();
/** The last fleet read, kept so a rename shows at once without reading the fleet again. */
let lastFleet: unknown = null;
/** The names people gave servers (the `server_names` rows), by id in lower case. */
let given: ReadonlyMap<string, string> = new Map();

/** The id a server's name is kept under: the hosts service's id in lower case (as `server_asks`). */
export const serverNameKey = (serverId: string): string => serverId.trim().toLowerCase();

/** The name a person gave a server, or null. */
export function givenServerName(serverId: string): string | null {
  return given.get(serverNameKey(serverId)) ?? null;
}

/**
 * What screens and messages call a server: the name a person gave it, else its host name's capitals, else its id
 * (as the last fleet read and the stored names say).
 */
export function serverLabel(serverId: string): string {
  return (givenServerName(serverId) ?? knownServer(serverId)?.name ?? serverId).slice(0, 120) || serverId;
}

/** Notes the names people gave servers (every `server_names` row, by lower-case id). */
export function noteServerNames(names: ReadonlyMap<string, string>): void {
  given = names;
  if (lastFleet) noteSelfServers(lastFleet);
}

/** Notes, from a fleet read, which servers there are and which hold this Whombat (by id and names, lower case). */
export function noteSelfServers(fleet: unknown): void {
  lastFleet = fleet;
  known.clear();
  const byHostname: [string, KnownServer][] = [];
  const byGiven: [string, KnownServer][] = [];
  for (const raw of arr(obj(fleet).servers)) {
    const card = obj(raw);
    if (typeof card.id !== 'string' || !card.id) continue;
    const hostname = typeof card.hostname === 'string' ? card.hostname : '';
    const named = givenServerName(card.id);
    const server: KnownServer = {
      id: card.id,
      name: named ?? (hostname && hostname.toLowerCase() === card.id.toLowerCase() ? hostname : card.id),
      hostsThisWhombat: card.hosts_this_whombat === true,
    };
    known.set(card.id.toLowerCase(), server);
    if (named) byGiven.push([named.toLowerCase(), server]);
    if (hostname) byHostname.push([hostname.toLowerCase(), server]);
  }
  // An id wins over another server's name, a given name over another's host name, as `resolveServer` looks them up.
  for (const [name, server] of [...byGiven, ...byHostname]) if (!known.has(name)) known.set(name, server);
}

/** Whether any fleet read was noted since the process started. */
export function fleetWasRead(): boolean {
  return lastFleet !== null;
}

/** The server an agent named (id, given name or host name, any case), as the last fleet read said; null when unknown. */
export function knownServer(server: unknown): KnownServer | null {
  return typeof server === 'string' ? (known.get(server.trim().toLowerCase()) ?? null) : null;
}

/** Whether the server an agent named (id or host name) runs this Whombat, as the last fleet read said. */
export function runsThisWhombat(server: unknown): boolean {
  return knownServer(server)?.hostsThisWhombat === true;
}
