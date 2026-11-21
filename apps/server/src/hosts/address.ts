/**
 * An address change on the same Whombat is noticed (docs/decisions/backup-file.md BF-16; BF-S39, BF-S40): the hosts
 * service remembers the agents' address before the last change (`GET /hub` → `agent_url_previous`,
 * `agent_url_changed_at`); five minutes after it changed, the servers that haven't reported since — not connected and
 * last seen before the change — are waiting. Owners see one Needs you item with “Point them here”, which opens the
 * repoint (`/things/servers?repoint=1`, the app reads `hosts.addressChange` and starts `hosts.repoint`). It goes away
 * when they are back, and a newer change replaces it (its ref is the change's time).
 */
import { HOST_REPOINT_WORDS, hostsAddressChangeText, type NeedsYouItem } from '@whombat/core';
import { addressChangeText, type HubInfo } from './hub';
import { arr, obj, str, ts } from './map';

/** How long agents get to find the new address themselves (BF-17) before people are asked. */
export const ADDRESS_WAIT_MS = 5 * 60_000;

/** Where the app opens the repoint for the waiting servers. */
export const REPOINT_HREF = '/things/servers?repoint=1';

/** The Needs you ref kind of an address change (open text on the wire, CT-336). */
export const ADDRESS_REF_KIND = 'address_change';

/** A server still looking for the old address. */
export interface WaitingServer {
  id: string;
  name: string;
  /** Its own address as its agent last reported it (Add a server, filled in), when known. */
  address: string | null;
}

/** `hosts.addressChange` (contracts 0.117.0's `HostAddressChange`). */
export interface AddressChange {
  /** The old and the new address as people read them (“10.100.1.160”, “10.100.1.158”). */
  from: string;
  to: string;
  changedAt: string;
  waiting: WaitingServer[];
}

/**
 * The servers that haven't found the new address (pure): not connected, and not seen since `changedAt` (never seen
 * counts as not seen). Cards are `/fleet`'s; `addresses` maps a server id to its own address (`/agents`).
 */
export function waitingServers(
  cards: readonly unknown[],
  changedAt: string,
  addresses: ReadonlyMap<string, string> = new Map(),
): WaitingServer[] {
  const since = Date.parse(changedAt);
  const out: WaitingServer[] = [];
  for (const raw of cards) {
    const c = obj(raw);
    const id = str(c.id);
    if (!id || c.agent_connected === true) continue;
    const seen = ts(c.last_seen);
    if (seen && Date.parse(seen) >= since) continue;
    out.push({ id, name: str(c.hostname)?.trim() || id, address: addresses.get(id) ?? null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The address change people should hear about now, or null (pure): the hub changed address at least `waitMs` ago, the
 * two addresses read differently, and some servers are still waiting.
 */
export function addressChangeOf(
  hub: Pick<HubInfo, 'agentUrl' | 'agentUrlPrevious' | 'agentUrlChangedAt'>,
  cards: readonly unknown[],
  now: Date,
  options: { addresses?: ReadonlyMap<string, string>; waitMs?: number } = {},
): AddressChange | null {
  if (!hub.agentUrlPrevious || !hub.agentUrlChangedAt || !hub.agentUrl) return null;
  const words = addressChangeText(hub.agentUrlPrevious, hub.agentUrl);
  if (!words) return null;
  if (now.getTime() - Date.parse(hub.agentUrlChangedAt) < (options.waitMs ?? ADDRESS_WAIT_MS)) return null;
  const waiting = waitingServers(cards, hub.agentUrlChangedAt, options.addresses);
  if (waiting.length === 0) return null;
  return { ...words, changedAt: hub.agentUrlChangedAt, waiting };
}

/** Server ids → their own addresses, from `/agents`. */
export function agentAddresses(agents: readonly unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of arr(agents)) {
    const a = obj(raw);
    const id = str(a.server_id);
    const address = str(a.address)?.trim();
    if (id && address) out.set(id, address.replace(/\/\d{1,3}$/, ''));
  }
  return out;
}

/**
 * BF-16's item: “Your Whombat’s address changed from 10.100.1.160 to 10.100.1.158, and 5 servers haven’t found it yet.”
 * (`hostsAddressChangeText`) with Point them here.
 */
export function addressNeedsYou(change: AddressChange): NeedsYouItem {
  const one = change.waiting.length === 1;
  return {
    id: `hosts.address:${change.changedAt}`,
    ref: { kind: ADDRESS_REF_KIND, id: change.changedAt },
    // The servers' kind of item (its server glyph); the ref says what it is.
    kind: 'enrollment',
    severity: 'warn',
    title: hostsAddressChangeText(change).slice(0, 200),
    body: one
      ? 'Whombat can sign in to it with your Vault key and point it here.'
      : 'Whombat can sign in to them with your Vault keys and point them here.',
    at: change.changedAt,
    actions: [
      {
        id: 'repoint',
        label: one ? HOST_REPOINT_WORDS.pointItHere : HOST_REPOINT_WORDS.pointThemHere,
        style: 'primary',
        kind: 'open',
        href: REPOINT_HREF,
      },
    ],
  };
}
