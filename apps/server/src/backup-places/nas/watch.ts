/**
 * What Whombat can watch about a NAS that keeps this Whombat's backups (docs/decisions/backup-places.md BPL-11): old
 * backups not being cleared there, and the NAS running out of room for them, as two lines on the TrueNAS, Synology and
 * QNAP pages' Worth a look. Both start off (watch-defaults.md): a cleanup that missed a week and a near limit aren't
 * urgent, and the box's own backup state stays the check that starts on.
 *
 * Read from the place's record and what the NAS keeps (the driver's `kept`, kept five minutes), only for a place
 * Whombat set up itself: one set up by hand has no cleanup to watch.
 */
import { BACKUP_PLACE_TEXT, type BackupPlaceKept } from '@whombat/core';
import type { CatalogConnectionRow } from '../../connections/types';
import { WHOMBAT_ACTOR } from '../../hosts/service';
import type { Services } from '../../services';
import type { KindModule } from '../../things/kinds/registry';
import type { KindCheck, KindNotice } from '../../things/quiet/types';
import { placeDriver } from '../drivers/index';
import { type BackupPlaceRow, loadPlaceRow } from '../store';
import { CLEANUP_LATE_MS } from '../watch';

const W = BACKUP_PLACE_TEXT.watch;
type NasKind = 'truenas' | 'synology' | 'qnap';

/** Less room than this is running out, whatever the backups' size. */
export const SPACE_LOW_BYTES = 20e9;

/** The two switches in What Whombat watches for a NAS kind. */
export function nasPlaceChecks(kind: NasKind): KindCheck[] {
  return [
    { check: `${kind}.backup_cleanup`, name: W.cleanupName, nature: 'you', perItem: false, startsOn: false },
    { check: `${kind}.backup_space`, name: W.spaceName, nature: 'fyi', perItem: false, startsOn: false },
  ];
}

/**
 * The lines (pure): the cleanup is off, failed, or hasn't run for more than nine days since it was set; the room left is
 * under 20 GB or a tenth of what the backups and the room together take.
 */
export function nasPlaceLines(
  kind: NasKind,
  place: Pick<BackupPlaceRow, 'name' | 'cleanupAt' | 'byHand'>,
  kept: BackupPlaceKept | null,
  now: Date,
): KindNotice[] {
  if (!kept || place.byHand) return [];
  const out: KindNotice[] = [];
  const started = place.cleanupAt?.getTime() ?? null;
  const last = kept.cleanup.lastAt ? Date.parse(kept.cleanup.lastAt) : Number.NaN;
  const since = Number.isFinite(last) ? last : started;
  const late = since !== null && now.getTime() - since > CLEANUP_LATE_MS;
  if (started !== null && (!kept.cleanup.on || kept.cleanup.ok === false || late))
    out.push({
      id: 'backup-place-cleanup',
      tone: 'warn',
      icon: 'backup',
      title: W.cleanupTitle(place.name),
      detail: W.cleanupDetail,
      nature: 'you',
      check: `${kind}.backup_cleanup`,
      ignore: { lifts: 'fixed', words: 'Until it clears them again.' },
    });
  const free = kept.freeBytes;
  if (free !== null && free < Math.max(SPACE_LOW_BYTES, 0.1 * (free + (kept.usedBytes ?? 0))))
    out.push({
      id: 'backup-place-space',
      tone: 'warn',
      icon: 'disk',
      title: W.spaceTitle(place.name),
      detail: W.spaceDetail(Math.round(free / 1e9)),
      nature: 'fyi',
      check: `${kind}.backup_space`,
      ignore: { lifts: 'fixed', words: 'Until there’s room again.' },
    });
  return out;
}

/** The lines of one NAS connection now (none when it keeps no backups of this Whombat, or can't be read). */
export async function nasPlaceNotices(
  services: Services,
  kind: NasKind,
  row: CatalogConnectionRow,
  now: Date,
): Promise<KindNotice[]> {
  if (row.access !== 'manage' || row.status !== 'active') return [];
  const id = `connection:${row.id}`;
  const place = await loadPlaceRow(services.db, id).catch(() => null);
  if (!place || place.byHand || !place.repositoryId) return [];
  const kept = await placeDriver({
    services,
    target: { id, ref: { type: 'connection', id: row.id }, kind, name: place.name },
    actor: WHOMBAT_ACTOR,
  })
    .kept(place.client)
    .catch(() => null);
  return nasPlaceLines(kind, place, kept, now);
}

/** A NAS kind's page and health pass with the backup place's two lines and their switches. */
export function withPlaceLines(kind: NasKind, module: KindModule): KindModule {
  const seen = module.seen;
  return {
    ...module,
    async page(ctx) {
      const view = await module.page(ctx);
      const extra = await nasPlaceNotices(ctx.services, kind, ctx.row, ctx.now);
      return extra.length ? { ...view, notices: [...(view.notices ?? []), ...extra] } : view;
    },
    ...(seen
      ? {
          async seen(services, row, now, timeZone) {
            const out = await seen(services, row, now, timeZone);
            const extra = await nasPlaceNotices(services, kind, row, now);
            return extra.length ? { ...out, notices: [...(out.notices ?? []), ...extra] } : out;
          },
        }
      : {}),
    checks: [...(module.checks ?? []), ...nasPlaceChecks(kind)],
  };
}
