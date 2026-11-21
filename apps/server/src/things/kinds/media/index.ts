/** The media services' kinds (service-dashboards.md SD-20…SD-24, SD-10; brief `docs/implementation/service-dashboards/assignment.md`). */
import type { KindModule } from '../registry';
import { RADARR_KIND, SONARR_KIND } from './arr';
import { JELLYFIN_KIND } from './jellyfin';
import { NZBHYDRA_KIND } from './nzbhydra';
import { PLEX_KIND } from './plex';
import { QBITTORRENT_KIND } from './qbittorrent';
import { SABNZBD_KIND } from './sabnzbd';
import { SEERR_KIND } from './seerr';

export const MEDIA_KINDS: Record<string, KindModule> = {
  jellyfin: JELLYFIN_KIND,
  nzbhydra: NZBHYDRA_KIND,
  overseerr: SEERR_KIND,
  plex: PLEX_KIND,
  qbittorrent: QBITTORRENT_KIND,
  radarr: RADARR_KIND,
  sabnzbd: SABNZBD_KIND,
  sonarr: SONARR_KIND,
};
