/**
 * What Whombat can watch about a server that keeps this Whombat's backups (docs/decisions/backup-places.md BPL-11):
 * old backups not being cleared there, and the place running out of room. Both are Whombat's own hints on the server
 * (`host.hint.backup_place.cleanup`, `host.hint.backup_place.space`), off at the start like every near limit
 * (watch-defaults.md): the box's own backup state stays the check that starts on. Worked out whenever the places are
 * read (the address follow reads them every few minutes) and kept for the hosts service's fleet and pages.
 */
import {
  BACKUP_PLACE_CLEANUP_HINT,
  BACKUP_PLACE_SPACE_HINT,
  BACKUP_PLACE_TEXT,
  type HostHint,
} from '@whombat/core';
import type { Services } from '../services';
import type { ServerFacts } from './places';
import type { BackupPlaceRow } from './store';

const W = BACKUP_PLACE_TEXT.watch;
const DAY_MS = 24 * 60 * 60_000;
/** The cleanup runs weekly: a run older than this is one that didn't happen. */
export const CLEANUP_LATE_MS = 9 * DAY_MS;
/** Less room than this share of the place is running out. */
export const SPACE_LOW_SHARE = 0.1;

/** The hints of the servers that keep this Whombat's backups (pure). */
export function placeHints(
  servers: readonly ServerFacts[],
  rows: readonly BackupPlaceRow[],
  client: string,
  now: Date,
): HostHint[] {
  const out: HostHint[] = [];
  for (const s of servers) {
    const row = rows.find((r) => r.id === `server:${s.id}`);
    const c = s.hub?.clients.find((x) => x.client === client);
    if (!row || !s.hub || !c) continue;
    const hint = (kind: string, title: string, detail: string): HostHint => ({
      serverId: s.id,
      kind,
      severity: 'warning',
      entity: client,
      title,
      detail,
      section: 'storage',
      id: `${kind}:${client}`,
    });
    const started = row.cleanupAt?.getTime() ?? null;
    const last = c.cleanup.lastAt ? Date.parse(c.cleanup.lastAt) : null;
    const late =
      started !== null &&
      now.getTime() - (Number.isFinite(last) && last !== null ? last : started) > CLEANUP_LATE_MS;
    if (started !== null && (!c.cleanup.set || c.cleanup.ok === false || late))
      out.push(hint(BACKUP_PLACE_CLEANUP_HINT, W.cleanupTitle(s.name), W.cleanupDetail));
    const { freeBytes, totalBytes } = s.hub;
    if (freeBytes !== null && totalBytes && freeBytes < totalBytes * SPACE_LOW_SHARE)
      out.push(
        hint(BACKUP_PLACE_SPACE_HINT, W.spaceTitle(s.name), W.spaceDetail(Math.round(freeBytes / 1e9))),
      );
  }
  return out;
}

const kept = new WeakMap<Services, HostHint[]>();

/** Keeps the hints worked out now for the hosts service to show. */
export function noteHints(services: Services, hints: HostHint[]): void {
  kept.set(services, hints);
}

/** The hints kept, for one server or all. */
export function keptHints(services: Services, serverId: string | null): HostHint[] {
  const all = kept.get(services) ?? [];
  return serverId === null ? all : all.filter((h) => h.serverId === serverId);
}
