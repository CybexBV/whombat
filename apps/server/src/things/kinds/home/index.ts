/**
 * The home services' kinds (service-dashboards.md SD-30…SD-34; brief `docs/implementation/service-dashboards/
 * assignment.md`): Home Assistant's Controls on top of its first kind, ESPHome, UniFi Protect, UniFi Access, Pi-hole and
 * AdGuard Home.
 */
import { HOME_ASSISTANT_KIND } from '../first';
import type { KindModule } from '../registry';
import { ACCESS_KIND } from './access';
import { ADGUARD_KIND, PIHOLE_KIND } from './dns';
import { ESPHOME_KIND } from './esphome';
import { FRIGATE_KIND } from './frigate';
import { CONTROLS_LIVE_S, HA_CONTROL_ACTIONS } from './ha-controls';
import { PROTECT_KIND } from './protect';

export const HOME_KINDS: Record<string, KindModule> = {
  // Its first kind (CP-07) with the Controls' buttons beside Restart (SD-30, SD-S04); the page part inserts the panel.
  homeassistant: {
    ...HOME_ASSISTANT_KIND,
    actions: { ...HOME_ASSISTANT_KIND.actions, ...HA_CONTROL_ACTIONS },
    liveS: CONTROLS_LIVE_S,
  },
  esphome: ESPHOME_KIND,
  frigate: FRIGATE_KIND,
  unifi_protect: PROTECT_KIND,
  unifi_access: ACCESS_KIND,
  // Their history is the services' own last 24 hours (SD-S21).
  pihole: { ...PIHOLE_KIND, ranges: ['24h'] },
  adguard: { ...ADGUARD_KIND, ranges: ['24h'] },
};
