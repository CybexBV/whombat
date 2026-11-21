/**
 * What a scan found, as the screen and the assistant name it (docs/decisions/desk-found.md DF-03, DF-05, DF-08;
 * DF-S03…DF-S05): pure. The order things found are listed in, their names and short lines, and the address as shown. The
 * assistant's words about them are the welcome's (`guides/welcome.ts`).
 */
import { CATALOG, catalogEntry, FOUND_SERVER_ID, FOUND_SERVER_TAGLINE, foundServerName } from '@whombat/core';
import { DEVICE_CATALOG_ID } from '../devices/store';
import { addressKey, type Found } from './discover';

/**
 * Home Assistant and the machines that hold the rest first (DF-03, DF-S03): the hypervisors and storage boxes, then
 * other servers (computers that answer SSH, connect-in-chat.md), then the catalog's order, then a device (Modbus), then
 * by address and port.
 */
const FIRST: readonly string[] = [
  'homeassistant',
  'proxmox',
  'unraid',
  'truenas',
  'synology',
  'qnap',
  FOUND_SERVER_ID,
];

const CATALOG_INDEX = new Map(CATALOG.map((e, i) => [e.id, i]));

function rank(catalogId: string): number {
  const first = FIRST.indexOf(catalogId);
  if (first >= 0) return first;
  if (catalogId === DEVICE_CATALOG_ID) return Number.MAX_SAFE_INTEGER;
  return FIRST.length + (CATALOG_INDEX.get(catalogId) ?? CATALOG.length);
}

/** The found services in DF-03's order (a new array). */
export function orderFound<F extends Pick<Found, 'catalogId' | 'host' | 'port'>>(found: readonly F[]): F[] {
  return [...found].sort(
    (a, b) =>
      rank(a.catalogId) - rank(b.catalogId) || addressKey(a.host) - addressKey(b.host) || a.port - b.port,
  );
}

/** The page Found on your network is at the top of: Add a connection (DF-05, AP-3804). */
export const FOUND_PAGE_PATH = '/settings?tab=connections&found=1';

/** A device's name when it didn't say its model (DF-S04). */
export const DEVICE_NAME = 'Modbus device';
/** The short line of an entry without one (never expected: the catalog's tests require it of every findable entry). */
export const FALLBACK_TAGLINE = 'On your network';

/** The name a found service goes by: the entry's, or a device's model as it reported it (DF-S04). */
export function foundName(f: Pick<Found, 'catalogId' | 'version'>): string {
  if (f.catalogId === DEVICE_CATALOG_ID) return f.version?.trim() || DEVICE_NAME;
  if (f.catalogId === FOUND_SERVER_ID) return foundServerName(f.version);
  return catalogEntry(f.catalogId)?.name ?? f.catalogId;
}

/** The entry's short line (DF-08; a device's is the `device` entry's, “A device Whombat can learn to read”). */
export function foundTagline(f: Pick<Found, 'catalogId'>): string {
  if (f.catalogId === FOUND_SERVER_ID) return FOUND_SERVER_TAGLINE;
  return catalogEntry(f.catalogId)?.tagline?.trim() || FALLBACK_TAGLINE;
}

/**
 * The address as the screen shows it (DF-S05): the host alone, the port added only when it isn't one the entry is
 * found on (its discovery targets', a device's 502) or the same entry is at that host on another port too.
 */
export function foundAddress(
  f: Pick<Found, 'catalogId' | 'host' | 'port'>,
  all: readonly Pick<Found, 'catalogId' | 'host' | 'port'>[],
): string {
  const own =
    f.catalogId === DEVICE_CATALOG_ID
      ? f.port === 502
      : f.catalogId === FOUND_SERVER_ID
        ? f.port === 22
        : (catalogEntry(f.catalogId)?.discovery?.targets.some((t) => t.port === f.port) ?? false);
  const twice = all.some((g) => g.catalogId === f.catalogId && g.host === f.host && g.port !== f.port);
  return own && !twice ? f.host : `${f.host}:${f.port}`;
}
