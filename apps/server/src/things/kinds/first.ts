/**
 * The four first kinds with a page of their own (connection-pages.md CP-07, CP-09, CP-11; fusebox-page.md FP-*) as
 * registry modules (service-dashboards.md SD-S01): Home Assistant, UniFi Network, Hetzner and Fusebox, showing what they
 * showed before the registry. Each keeps its own reader, page and glance; this file only puts them together.
 *
 * - They keep the response-time chart when they have no chart card of their own (before SD-S02 an empty `charts`
 *   meant “none of mine”; for the new kinds it means “no response chart”). A page in slots never has one.
 * - Home Assistant's machine for its disk points is its Supervisor's when Whombat doesn't watch the machine (CP-16).
 * - Fusebox's card reads the accounts the gateway poller kept this minute and its overview (FP-02, FP-03, FP-S02); its
 *   prefetch takes the burrow's time zone (this month's spend).
 * - Their health pass's look comes from each kind's own `…Seen` with its lines (quiet-notices.md QN-S03).
 *
 * A group file may extend one of these under the same catalog id (`{ ...HOME_ASSISTANT_KIND, actions: {
 * ...HOME_ASSISTANT_KIND.actions, … } }`): `index.ts` spreads the groups after these, so the group's entry wins.
 */

import { fuseboxLatest, fuseboxPage, fuseboxSeen } from './fusebox';
import { FUSEBOX_CHECKS } from './fusebox-lines';
import { HETZNER_CHECKS, hetznerLatest, hetznerPage, hetznerSeen } from './hetzner';
import {
  HOME_ASSISTANT_CHECKS,
  homeAssistantLatest,
  homeAssistantPage,
  homeAssistantSeen,
} from './homeassistant';
import { restartHomeAssistant } from './homeassistant-restart';
import type { KindModule } from './registry';
import type { KindPage } from './types';
import { UNIFI_CHECKS, unifiLatest, unifiPage, unifiSeen } from './unifi';

/** Home Assistant's points (DS-11), kept with its kind. */
export { haSeenPoints } from './homeassistant';

/**
 * A first kind's page, with the response-time chart kept when it has no chart card of its own (as before SD-S02);
 * one in slots stays as it is.
 */
function keepsResponseChart(page: KindPage): KindPage {
  return async (ctx) => {
    const view = await page(ctx);
    if (view.slots || view.charts?.length) return view;
    const { charts: _none, ...rest } = view;
    return rest;
  };
}

/*
 * The health pass's look of each (quiet-notices.md QN-S03): the card, its points, Worth a look's lines as the page
 * shows them and what the read skipped, from each kind's own `…Seen`; What Whombat watches from its `…_CHECKS`.
 */

export const HOME_ASSISTANT_KIND: KindModule = {
  page: keepsResponseChart(homeAssistantPage),
  prefetch: (services, row, now) => homeAssistantLatest(services, row, now),
  // How it runs (CP-16): version, integrations loaded, errors today, updates; its disk is the machine's (Supervisor's).
  seen: homeAssistantSeen,
  checks: HOME_ASSISTANT_CHECKS,
  asksFirst: 'locks and alarms ask first',
  actions: { restart: restartHomeAssistant },
};

export const UNIFI_KIND: KindModule = {
  page: keepsResponseChart(unifiPage),
  prefetch: (services, row, now) => unifiLatest(services, row, now),
  // The internet line, access points online and clients; the line's down and up, the gateway's CPU and memory.
  seen: (services, row, now) => unifiSeen(services, row, now),
  checks: UNIFI_CHECKS,
  asksFirst: 'restarts and firewall changes ask first',
};

export const HETZNER_KIND: KindModule = {
  page: keepsResponseChart(hetznerPage),
  prefetch: (services, row, now) => hetznerLatest(services, row, now),
  // Servers running.
  seen: (services, row, now) => hetznerSeen(services, row, now),
  checks: HETZNER_CHECKS,
};

export const FUSEBOX_KIND: KindModule = {
  page: keepsResponseChart(fuseboxPage),
  // This month's spend is the burrow's month: the read takes its time zone.
  prefetch: (services, row, now, timeZone) => fuseboxLatest(services, row, now, timeZone),
  // Its card (FP-02, FP-03, FP-S02): the accounts the gateway poller read this minute, its overview, its lines.
  seen: fuseboxSeen,
  checks: FUSEBOX_CHECKS,
};

export const FIRST_KINDS: Record<string, KindModule> = {
  homeassistant: HOME_ASSISTANT_KIND,
  unifi_network: UNIFI_KIND,
  hetzner: HETZNER_KIND,
  fusebox: FUSEBOX_KIND,
};
