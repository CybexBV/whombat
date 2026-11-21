/**
 * Where on a place the backups can be kept (docs/decisions/backup-places.md BPL-13): what a driver reports about each
 * Unraid share, TrueNAS pool or Synology and QNAP shared folder, turned into what people choose from — the recommended
 * one first, the ones that hold other things last, and a plain sentence on what to know about the rest.
 */
import { BACKUP_PLACE_TEXT, type BackupPlaceKind, type BackupPlaceLocation } from '@whombat/core';

const L = BACKUP_PLACE_TEXT.location;

/** What a driver knows about one location. */
export interface LocationFacts {
  id: string;
  /** As the NAS's own page calls it. */
  name: string;
  freeBytes: number | null;
  /** Whombat makes it when it is chosen. */
  isNew: boolean;
  /** The driver's pick (a share or folder only Whombat uses, else the NAS's own place for apps). */
  recommended: boolean;
  /** Open on the network (an SMB or NFS export): anyone who can open it could delete the backups. */
  shared: boolean;
  /** The pool its data is kept on first when that isn't the array (Unraid's cache), else null. */
  pool: string | null;
  /** It holds the NAS's own things (Unraid's apps, virtual machines, disk images). */
  holdsOther: boolean;
}

/** The most a place lists (the contract's bound). */
const MAX_LOCATIONS = 50;

/** One location's note: the most important thing to know about it, or null. */
export function locationNote(f: LocationFacts): string | null {
  if (f.shared) return L.shared;
  if (f.holdsOther) return L.holdsOther;
  // Only the ones people pick against the recommended one: the recommended share needs no warning of its own.
  if (f.pool && !f.recommended) return L.onPool(f.pool);
  return null;
}

/**
 * The locations people choose from (pure): the recommended one first, then by free space, the ones that hold other
 * things last; none at all when there is no choice (one location or none), so the person isn't asked.
 */
export function placeLocations(facts: readonly LocationFacts[]): BackupPlaceLocation[] {
  const seen = new Set<string>();
  const unique = facts.filter((f) => f.id && !seen.has(f.id) && seen.add(f.id));
  if (unique.length < 2) return [];
  const rank = (f: LocationFacts) => (f.recommended ? 0 : f.holdsOther ? 2 : 1);
  const recommended = unique.find((f) => f.recommended)?.id ?? null;
  return [...unique]
    .sort((a, b) => rank(a) - rank(b) || (b.freeBytes ?? -1) - (a.freeBytes ?? -1))
    .slice(0, MAX_LOCATIONS)
    .map((f) => ({
      id: f.id.slice(0, 200),
      name: (f.name || f.id).slice(0, 200),
      freeBytes: f.freeBytes,
      isNew: f.isNew,
      recommended: f.id === recommended,
      note: locationNote(f),
    }));
}

/** A location in a sentence (“the share whombat-backups”), or null when the place has no choice. */
export function locationSaid(
  kind: BackupPlaceKind,
  locations: readonly BackupPlaceLocation[],
  id: string | null,
): string | null {
  if (!id || !locations.length) return null;
  const name = locations.find((l) => l.id === id)?.name ?? id;
  return L.said(kind, name);
}
