/** The storage services' kinds (service-dashboards.md SD-50…SD-57; brief `docs/implementation/service-dashboards/assignment.md`). */
import { withPlaceLines } from '../../../backup-places/nas/watch';
import type { KindModule } from '../registry';
import { IMMICH_KIND } from './immich';
import { NEXTCLOUD_KIND } from './nextcloud';
import { PAPERLESS_KIND } from './paperless';
import { PBS_KIND } from './pbs';
import { QNAP_KIND } from './qnap';
import { SYNOLOGY_KIND } from './synology';
import { TRUENAS_KIND } from './truenas';

export const STORAGE_KINDS: Record<string, KindModule> = {
  paperless: PAPERLESS_KIND,
  nextcloud: NEXTCLOUD_KIND,
  proxmox_backup: PBS_KIND,
  // The NAS kinds also show the backup place's two lines when one keeps this Whombat's backups.
  truenas: withPlaceLines('truenas', TRUENAS_KIND),
  immich: IMMICH_KIND,
  synology: withPlaceLines('synology', SYNOLOGY_KIND),
  qnap: withPlaceLines('qnap', QNAP_KIND),
};
