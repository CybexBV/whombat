/**
 * Connections' and devices' own pages in fixture mode (contracts 0.88/0.89, CT-390…CT-398; Whombat connection-pages.md
 * CP-01…CP-20, dashboards.md DS-01…DS-17; app connection-pages-web.md AP-1900…, dashboards-web.md AP-2050…):
 * `things.page` (with its `range`), `things.action` and `connections.setRunsOn` for Mara's things in the one-Whombat
 * world (`oneFixtures.ts`), built the way the server builds them — every panel placed and worded, its figures
 * formatted, its points on the range's grid (`?range=`, 24 hours without one):
 *
 * - **Home Assistant** as the dashboards mock draws it (`ha.png`): 2026.10.2 in Docker at 10.100.0.5:8123 on pve-02 ·
 *   CT 131, CPU 2 %, memory 3.0 / 8 GB, disk 30 / 40 GB (76 %, full about two months on), the database 6.0 GB, 100 of
 *   102 integrations; chart cards CPU, Memory, Disk space with its forecast, Errors in the log (bars), Database; the
 *   integrations not loading, backups, nine notices (five shown); tabs Integrations, Log and Backups; Restart.
 * - **UniFi** (DS-13): 44 of 45 devices online, 174 clients, internet and the gateway, the container it runs in; tab
 *   Devices. No client lists (CP-09).
 * - **Hetzner** (`hetzner.png`, DS-12): whombat-prod running, its CPU, network and disk I/O, traffic and cost, the note
 *   that Hetzner can't see memory or disk space.
 * - **Acme Desk dev** (`con_fixture_tracker`, a made-up report tracker): the generic page every connection gets, with
 *   the logo its driver gave it.
 * - **Pool** (`device:con_pool`): a switched-on device with a chart card per reading (CP-13, DS-14); the **heat pump**
 *   is learned until its card switches it on, then the same.
 * - **Proxmox VE API** (`con_pve-02-api`): part of pve-02 (CP-10).
 * - **Find My** (`con_findmy`): the Find My tab naming studio, which the apps draw from the Mac's own Find My
 *   (findmy-connection.md).
 * - Any other connection: the generic page from its summary.
 *
 * Their Settings tabs read `connections.tools` for these connections, which this layer answers too (the catalog's world
 * has its own, other ids). State (what each runs on, restarts) lives in the closure.
 */
import { localAt } from '@whombat/client';
import { DASHBOARD_RANGE_WORDS, dashboardNumber, seriesStats } from '@whombat/client/hosts';
import {
  FIND_MY_CONNECTION_FIELDS,
  FIND_MY_CONNECTION_ID,
  FIND_MY_THING,
  findMyConnectionPage,
} from '@whombat/client/hosts/fixtures';
import {
  type ChangeEntry,
  type HostSeriesRange,
  openThingFigures,
  parseThingId,
  type ThingLine,
  type ThingLogo,
  type ThingPage,
  type ThingPageNotice,
  type ThingPagePanel,
  type ThingPageRow,
  type ThingRunsOn,
  type ThingSummary,
  thingHref,
} from '@whombat/core';
import type {
  QuietNoticeBody,
  SetRunsOnBody,
  SetThingWatchBody,
  ThingActionBody,
} from '@whombat/core/contracts';
import {
  type ConnectionToolView,
  type ConnectionView,
  catalogEntry,
  isAccountPageId,
} from '@whombat/core/domain';
import {
  burrow,
  GROUP_SERVICE_PAGES,
  homeAssistantSlotPanels,
  mara,
  SERVICE_PAGE_THINGS,
  SERVICE_THINGS,
  type ServicePages,
} from '@whombat/fixtures';
import { handleServicePagesRequest } from '@whombat/fixtures/fetch';
import { fixtureConnectionView, fixtureEntryTools } from './catalogFixtures';
import type { OneFixtures } from './oneFixtures';
import { createPlexSettingsFixtures } from './plexSettingsFixtures';
import { createQuietFixtures, type FixtureCheck } from './quietFixtures';

const API = '/api/v1';
const B = `${API}/burrows/${burrow.slug}`;
const TZ = 'Europe/Amsterdam';
const MIN = 60_000;
const HOUR = 60 * MIN;
/** The ranges a connection's page offers (DS-03): its points are kept 30 days. */
const RANGES: readonly HostSeriesRange[] = ['1h', '6h', '24h', '7d', '30d'];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function refused(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

/** Deterministic noise in [0, 1) (the mock's generator). */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** A server's page, or one of its guests'. */
function serverHref(serverId: string, guestId?: string | null): string {
  return `${thingHref('server', serverId)}${guestId ? `?guest=${encodeURIComponent(guestId)}` : ''}`;
}

/** The guests these pages know by id, for a chosen guest's name (“CT 131”). */
const GUEST_WORDS: Record<string, string> = {
  'pve:131': 'CT 131',
  'pve:136': 'CT 136',
  'pve:139': 'CT 139',
  'pve:118': 'VM 118',
};

/** The things whose page is drawn here, by thingId. */
const HA = 'connection:con_home-assistant';
/** Home Assistant's thing, for the service pages' Controls and buttons (service-dashboards.md AP-4571). */
export const HOME_ASSISTANT_THING = HA;
// Every service page `@whombat/fixtures` answers: the built-in ones and each group's (`servicePages/<group>.ts`).
const SERVICES: readonly string[] = SERVICE_PAGE_THINGS;
const UNIFI = 'connection:con_unifi';
const HETZNER = 'connection:con_hetzner';
const TRACKER = 'connection:con_fixture_tracker';
/** The made-up tracker's own logo, as its driver gives it: a blue tile with a white check. */
const ACME_DESK_LOGO: ThingLogo = {
  viewBox: '0 0 24 24',
  shapes: [
    { d: 'M5 2h14a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3Z', fill: '#2f6fde' },
    {
      d: 'M7 12.5l3.2 3.2L17 9',
      fill: 'none',
      stroke: '#ffffff',
      strokeWidth: 2.2,
      linecap: 'round',
      linejoin: 'round',
    },
  ],
};
const POOL = 'device:con_pool';
const HEAT = 'device:con_heat-pump';
const PVE_API = 'connection:con_pve-02-api';

/** What Whombat watches on UniFi (Whombat QN-S2x; the quiet mock's panel 4). */
const UNIFI_CHECKS: readonly FixtureCheck[] = [
  { check: 'unifi.gateway_offline', name: 'The gateway going offline', nature: 'problem', perItem: false },
  {
    check: 'unifi.device_offline',
    name: 'Access points and switches going offline',
    nature: 'problem',
    perItem: true,
  },
  { check: 'unifi.gateway_busy', name: 'The gateway being very busy', nature: 'problem', perItem: false },
  { check: 'unifi.firmware', name: 'Firmware updates waiting', nature: 'fyi', perItem: false },
];

/** What each runs on when Whombat finds it by its address (CP-08). */
const FOUND: Record<string, ThingRunsOn> = {
  [HA]: {
    serverId: 'pve-02',
    guestId: 'pve:131',
    name: 'homeassistant (pve-02)',
    href: serverHref('pve-02', 'pve:131'),
    how: 'address',
  },
  [UNIFI]: {
    serverId: 'pve-02',
    guestId: 'pve:136',
    name: 'unifi (pve-02)',
    href: serverHref('pve-02', 'pve:136'),
    how: 'address',
  },
};

/** The Settings tab's connection for the pages' own connections (`connections.tools`). */
const CONNECTIONS: Record<string, { catalogId: string; fields: Record<string, string>; label?: string }> = {
  'con_home-assistant': { catalogId: 'homeassistant', fields: { url: 'http://10.100.0.5:8123' } },
  con_unifi: { catalogId: 'unifi', fields: { url: 'https://10.100.0.100:11443' }, label: 'UniFi' },
  con_hetzner: { catalogId: 'hetzner', fields: {}, label: 'Hetzner' },
  'con_pve-02-api': {
    catalogId: 'proxmox',
    fields: { url: 'https://10.100.0.2:8006' },
    label: 'Proxmox VE API',
  },
  // The service pages' connections (`@whombat/fixtures` `createServicePages`; service-dashboards.md AP-4571).
  con_plex: { catalogId: 'plex', fields: { url: 'http://10.100.0.20:32400' }, label: 'Plex' },
  con_seerr: { catalogId: 'overseerr', fields: { url: 'http://10.100.0.20:5055' }, label: 'Seerr' },
  con_sabnzbd: { catalogId: 'sabnzbd', fields: { url: 'http://10.100.0.20:8080' }, label: 'SABnzbd' },
  con_protect: { catalogId: 'unifi_protect', fields: { url: 'https://10.100.0.1' }, label: 'UniFi Protect' },
  con_pihole: { catalogId: 'pihole', fields: { url: 'http://10.100.0.53' }, label: 'Pi-hole' },
  // Find My through studio (findmy-connection.md): its Mac and how often it reads in the background.
  [FIND_MY_CONNECTION_ID]: {
    catalogId: 'findmy',
    fields: { ...FIND_MY_CONNECTION_FIELDS },
    label: 'Find My',
  },
  con_pool: { catalogId: 'device', fields: {}, label: 'Pool' },
  'con_heat-pump': { catalogId: 'device', fields: {}, label: 'Heat pump' },
  // Each group's service pages (`@whombat/fixtures` `servicePages/<group>.ts`): their Settings tab's tools. An
  // account's Connection tab is its own settings page, from the connectors' world.
  ...Object.fromEntries(
    GROUP_SERVICE_PAGES.filter((g) => !isAccountPageId(g.catalogId)).map((g) => [
      g.thing.slice('connection:'.length),
      { catalogId: g.catalogId, fields: g.fields ?? {}, label: g.name },
    ]),
  ),
};

export interface ThingPageFixtures {
  /** `inner` answers what this world doesn't know: another layer's connection gets the generic page from it. */
  handle(req: Request, inner?: (req: Request) => Promise<Response>): Promise<Response | null>;
  /** A page as the server would answer it now, for a range (tests check every one against the contract). */
  page(thingId: string, range?: HostSeriesRange): ThingPage | null;
}

export function createThingPageFixtures(
  one: Pick<OneFixtures, 'things' | 'addChange' | 'now'>,
  options: {
    /**
     * The service pages (`@whombat/fixtures` `createServicePages`; service-dashboards.md AP-4571): Plex, Seerr,
     * SABnzbd, Protect and Pi-hole answered by them, Home Assistant's buttons and pictures too.
     */
    services?: ServicePages | null;
    /** Home Assistant's Controls first on its page, above the figures, live every 10 s (SD-30). */
    controls?: boolean;
  } = {},
): ThingPageFixtures {
  const services = options.services ?? null;
  const made = one.now();
  // Plex's own settings tab, Ask on its cards and its verdict (service-settings.md SST-01…SST-10).
  const plexSettings = createPlexSettingsFixtures({
    thing: SERVICE_THINGS.plex,
    now: one.now,
    addChange: (entry) => one.addChange(entry),
  });
  const at = (day: number, hhmm: string) => localAt(made, TZ, hhmm, day);
  /** What a person chose a connection runs on (`connections.setRunsOn`): absent is automatic. */
  const chosen = new Map<string, ThingRunsOn | null>();
  let restartedAt = made - 79 * HOUR;
  let seq = 0;

  const runsOn = (thing: string): ThingRunsOn | null =>
    chosen.has(thing) ? (chosen.get(thing) ?? null) : (FOUND[thing] ?? null);

  const summary = (thing: string): ThingSummary | undefined => one.things().find((t) => t.id === thing);

  /* The range's points (DS-03, DS-11) ------------------------------------------------------------------ */

  /** A range's time grid ending now: 5-minute points for an hour and six, 15 minutes for a day, then 2 h and 6 h. */
  const GRID: Record<HostSeriesRange, { points: number; step: number }> = {
    '1h': { points: 12, step: 5 * MIN },
    '6h': { points: 72, step: 5 * MIN },
    '24h': { points: 96, step: 15 * MIN },
    '7d': { points: 84, step: 2 * HOUR },
    '30d': { points: 120, step: 6 * HOUR },
    '90d': { points: 90, step: 24 * HOUR },
  };

  /** The range's grid ending on the last whole step (the server puts points on it, DS-11). */
  const times = (points: number, step: number) => {
    const last = Math.floor(made / step) * step;
    return Array.from({ length: points }, (_, k) => last - (points - 1 - k) * step);
  };

  /** Amsterdam's hour of day (CEST in October: UTC + 2). */
  const hourOf = (t: number) => (((t / HOUR + 2) % 24) + 24) % 24;

  /** The 03:00 backups: a bump between 03:00 and 03:40. */
  const night = (t: number) => (hourOf(t) >= 3 && hourOf(t) < 3.7 ? 1 : 0);

  /** A series over `ts`: `base`, a shape in units of `amp`, noise of `noise` × `amp`; the last point `last` when given. */
  function wave(
    ts: readonly number[],
    seed: number,
    base: number,
    amp: number,
    shape: (t: number, k: number) => number = () => 0,
    opts: { noise?: number; last?: number; digits?: number; floor?: number } = {},
  ): number[] {
    const r = rng(seed);
    const noise = opts.noise ?? 0.25;
    return ts.map((t, k) =>
      k === ts.length - 1 && opts.last !== undefined
        ? opts.last
        : round(
            Math.max(opts.floor ?? 0, base + shape(t, k) * amp + (r() - 0.5) * amp * noise),
            opts.digits ?? 1,
          ),
    );
  }

  const iso = (ts: readonly number[]) => ts.map((t) => new Date(t).toISOString());

  /** “Avg **14.2 %**”, “Peak **63 %** Sun 03:10” over a series (DS-06, DS-15). */
  function avgPeak(values: readonly number[], ts: readonly number[], unit: string): ThingLine[] {
    const s = seriesStats(values, iso(ts), { timeZone: TZ, now: made });
    const u = unit ? ` ${unit}` : '';
    return [
      [{ text: 'Avg ' }, { text: `${dashboardNumber(s.avg)}${u}`, strong: true }],
      [
        { text: 'Peak ' },
        { text: `${dashboardNumber(s.peak)}${u}`, strong: true },
        { text: ` ${s.peakWhen ?? ''}` },
      ],
    ];
  }

  /** At most 60 points of a series for a small line (the server's spark downsampling). */
  const spark = (values: readonly number[]) => {
    const step = Math.max(1, Math.ceil(values.length / 60));
    return values.filter((_, k) => k % step === 0 || k === values.length - 1);
  };

  /** What every page says about its ranges (CT-397): it shows `range`, offers these, reads again every minute. */
  const ranged = (range: HostSeriesRange) => ({ range, ranges: [...RANGES], refreshS: 60 });

  /* Shared panels ---------------------------------------------------------------------------------- */

  const changes = (title = 'Changes here'): ThingPagePanel => ({
    kind: 'changes',
    id: 'changes',
    place: 'main',
    width: 'wide',
    title,
    limit: 5,
  });

  const access = (items: { label: string; tier: 'allowed' | 'ask' | 'off' | 'mixed'; count: number }[]) =>
    ({
      kind: 'access',
      id: 'access',
      place: 'main',
      width: 'wide',
      title: 'What Whombat may do',
      lookOnly: false,
      items,
    }) satisfies ThingPagePanel;

  const widgets = (suggestions: string[]): ThingPagePanel => ({
    kind: 'widgets',
    id: 'more',
    place: 'bottom',
    title: 'Show more here',
    suggestions,
  });

  /** Worth a look as a strip on top, as a real Whombat's page in slots has it. */
  const strip = (items: ThingPageNotice[]): ThingPagePanel => ({
    kind: 'notices',
    id: 'worth',
    place: 'top',
    title: 'Worth a look',
    empty: 'Nothing needs a look.',
    items,
  });

  const worth = (items: ThingPageNotice[]): ThingPagePanel => ({
    kind: 'notices',
    id: 'worth',
    place: 'side',
    width: 'narrow',
    title: 'Worth a look',
    empty: 'Nothing needs a look.',
    items,
  });

  /* Home Assistant (ha.png) ------------------------------------------------------------------------ */

  function homeAssistant(range: HostSeriesRange): ThingPage {
    const up = Math.round((made - restartedAt) / HOUR);
    const integrations = INTEGRATIONS.map(
      ([domain, title, state, note]): ThingPageRow => ({
        id: `${domain}-${title}`,
        cells: {
          name: { text: domain },
          entry: { text: title, tone: 'muted' },
          state: {
            text: state === 'ok' ? 'Loaded' : state === 'warn' ? 'Retrying' : 'Failed',
            dot: state,
            ...(note ? { note } : {}),
          },
        },
      }),
    );
    return {
      id: HA,
      kind: 'connection',
      connectionId: 'con_home-assistant' as ThingPage['connectionId'],
      catalogId: 'homeassistant',
      name: 'Home Assistant',
      icon: 'home',
      status: 'warn',
      badge: 'Needs a look',
      facts: [
        [{ text: 'Home Assistant ' }, { text: '2026.10.2', strong: true }, { text: ' · Docker' }],
        [{ text: 'MariaDB ' }, { text: '10.11', strong: true }],
        [
          { text: 'Up ' },
          { text: up < 48 ? `${up} h` : `${Math.floor(up / 24)} d ${up % 24} h`, strong: true },
        ],
        [{ text: 'Checked 2 min ago' }],
      ],
      address: '10.100.0.5:8123',
      open: { label: 'Open Home Assistant', url: 'http://10.100.0.5:8123/' },
      runsOn: runsOn(HA),
      settings: true,
      actions: [
        {
          id: 'restart',
          label: 'Restart',
          icon: 'restart',
          confirm: {
            title: 'Restart Home Assistant?',
            body: 'It stops for about a minute. Automations that would run in that minute are skipped.',
            button: 'Restart',
          },
          allowed: true,
        },
      ],
      readAt: new Date(made).toISOString(),
      ...ranged(range),
      tabs: [
        {
          key: 'overview',
          label: 'Summary',
          panels: [
            // In slots, as a real Whombat's (Whombat service-slots.md): the Controls live beside what it has, the
            // cameras, the week's automation runs, who's home and the machine; its own panels below them.
            ...homeAssistantSlotPanels({
              now: made,
              controls: services && options.controls ? services.homeAssistantControls() : null,
              machine: runsOn(HA)
                ? { name: 'homeassistant (pve-02)', href: serverHref('pve-02', 'pve:131') }
                : null,
            }),
            {
              kind: 'list',
              id: 'loading',
              place: 'main',
              width: 'wide',
              title: 'Integrations not loading',
              meta: '2 of 102',
              link: { kind: 'tab', label: 'All integrations', tab: 'integrations' },
              items: [
                {
                  id: 'shelly-pool',
                  title: 'Shelly · Pool pump',
                  detail: 'Retrying · cannot reach 10.100.0.87 since Thu 07:12',
                  tone: 'warn',
                },
                {
                  id: 'shelly-garage',
                  title: 'Shelly · Garage door',
                  detail: 'Retrying · cannot reach 10.100.0.91 since Thu 07:12',
                  tone: 'warn',
                },
              ],
            },
            {
              kind: 'list',
              id: 'backups',
              place: 'main',
              width: 'wide',
              title: 'Backups',
              link: { kind: 'tab', label: 'Backups', tab: 'backups' },
              items: [
                {
                  id: 'proxmox',
                  title: 'Proxmox backs up CT 131 every day',
                  detail: 'backup-homeassistant-daytime · today 07:30 · 4.2 GB',
                  tone: 'ok',
                  right: 'next in 21 h',
                },
                {
                  id: 'old',
                  title: '8.7 GB of old Home Assistant backups on its own disk',
                  detail: '23 files, oldest from March',
                  tone: 'warn',
                },
              ],
            },
            strip([
              // A forecast this far off is a heads-up, as the server words it (machine.ts `diskNotice`).
              {
                id: 'disk',
                tone: 'info',
                icon: 'disk',
                title: 'Disk full in about 2 months',
                detail: '8.7 GB is old backups',
                nature: 'fyi',
                check: 'machine.disk_forecast',
              },
              {
                id: 'log',
                tone: 'warn',
                icon: 'log',
                title: 'Modbus fills the log',
                detail: '92 % of 12,286 errors, still coming in',
                link: { kind: 'tab', label: 'Show them', tab: 'logs' },
              },
              {
                id: 'integrations',
                tone: 'bad',
                icon: 'plug',
                title: '2 integrations not loading',
                detail: 'Shelly pool pump, garage door',
                link: {
                  kind: 'ask',
                  label: 'Look into it',
                  question: 'Why are two integrations not loading in Home Assistant?',
                },
              },
              {
                id: 'repairs',
                tone: 'warn',
                icon: 'warn',
                title: '3 HomeWizard meters need a new sign-in',
                detail: 'Zwembad Techniek, Schuilstal, WTW Zolder',
                link: {
                  kind: 'ask',
                  label: 'Repair',
                  question:
                    'Three HomeWizard meters in Home Assistant need a new sign-in. Can you repair them?',
                },
              },
              {
                id: 'update',
                tone: 'info',
                icon: 'update',
                title: 'Home Assistant has an update',
                detail: 'Version 2026.10.3, with a fix for the Modbus integration',
                link: {
                  kind: 'ask',
                  label: 'Decide',
                  question: 'Should I update Home Assistant to 2026.10.3?',
                },
              },
              {
                id: 'recorder',
                tone: 'info',
                icon: 'database',
                title: 'The database grows 110 MB a day',
                detail: 'sensor.evcs_* writes every second',
                link: {
                  kind: 'ask',
                  label: 'Look into it',
                  question: 'Why does Home Assistant’s database grow 110 MB a day?',
                },
              },
              {
                id: 'zigbee',
                tone: 'info',
                icon: 'device',
                title: '2 Zigbee sensors report a low battery',
                detail: 'Hallway motion, Garage door contact',
              },
              {
                id: 'cert',
                tone: 'info',
                icon: 'key',
                title: 'Its certificate ends in 24 days',
                detail: 'Let’s Encrypt renews it by itself',
              },
              {
                id: 'backup-age',
                tone: 'info',
                icon: 'backup',
                title: 'No backup of its own in 40 days',
                detail: 'Proxmox backs up the whole machine every day',
              },
            ]),
            changes(),
            access([
              { label: 'Read states and history', tier: 'allowed', count: 4 },
              { label: 'Switch and set things', tier: 'allowed', count: 3 },
              { label: 'Locks, alarms and doors', tier: 'ask', count: 2 },
            ]),
            widgets(['Database size', 'Errors per hour', 'Integrations loading']),
          ],
        },
        {
          key: 'integrations',
          label: 'Integrations',
          count: 102,
          panels: [
            {
              kind: 'table',
              id: 'integrations',
              title: 'Integrations',
              meta: '100 of 102 loaded',
              columns: [
                { key: 'name', label: 'Integration' },
                { key: 'entry', label: 'Entry' },
                { key: 'state', label: 'State' },
              ],
              rows: integrations,
            },
          ],
        },
        {
          key: 'logs',
          label: 'Log',
          panels: [
            {
              kind: 'list',
              id: 'log',
              title: 'Errors since the restart',
              meta: '12,286 errors · 112 warnings',
              items: [
                {
                  id: 'modbus',
                  title: 'Modbus: no answer from the EV charger',
                  detail: 'modbus · since Thu 07:12, still coming in',
                  tone: 'bad',
                  icon: 'log',
                  right: '×11,280',
                },
                {
                  id: 'shelly',
                  title: 'Shelly: cannot reach 10.100.0.87',
                  detail: 'shelly · retrying since Thu 07:12',
                  tone: 'bad',
                  icon: 'plug',
                  right: '×612',
                },
                {
                  id: 'homewizard',
                  title: 'HomeWizard: the sign-in expired',
                  detail: 'homewizard · three meters',
                  tone: 'bad',
                  icon: 'key',
                  right: '×288',
                },
                {
                  id: 'recorder',
                  title: 'The recorder is slow to write',
                  detail: 'recorder · during the backup at 07:30',
                  tone: 'warn',
                  icon: 'database',
                  right: '×84',
                },
                {
                  id: 'esphome',
                  title: 'ESPHome: garden-sensor came back',
                  detail: 'esphome · 12:04',
                  tone: 'warn',
                  icon: 'device',
                  right: '×28',
                },
              ],
            },
          ],
        },
        {
          key: 'backups',
          label: 'Backups',
          panels: [
            {
              kind: 'list',
              id: 'proxmox',
              title: 'Whole machine, by Proxmox',
              meta: 'every day at 07:30 · keeps 14 days',
              items: Array.from({ length: 6 }, (_, d) => ({
                id: `vzdump-${d}`,
                title: d === 0 ? 'Today’s backup' : `Backup of ${d === 1 ? 'yesterday' : `${d} days ago`}`,
                detail: 'On pbs-01 · 4.2 GB',
                at: at(-d, '07:31'),
                tone: 'ok' as const,
              })),
            },
            {
              kind: 'list',
              id: 'own',
              title: 'Home Assistant’s own',
              items: [
                {
                  id: 'kiosk',
                  title: 'Settings copy before the kiosk update',
                  detail: 'In its own backups folder · 1.8 GB',
                  at: at(-1, '16:02'),
                  tone: 'ok',
                },
                {
                  id: 'old',
                  title: 'Copies from before 2026.9',
                  detail: '23 old copies on the same disk',
                  at: at(-40, '09:00'),
                  tone: 'warn',
                  right: '8.7 GB',
                },
              ],
            },
          ],
        },
      ],
    };
  }

  /* UniFi (DS-13; no client lists, CP-09) --------------------------------------------------------------- */

  function unifi(range: HostSeriesRange): ThingPage {
    const g = GRID[range];
    const ts = times(g.points, g.step);
    const evening = (t: number) => (hourOf(t) >= 19 && hourOf(t) < 23 ? 1 : 0);
    const down = wave(ts, 3, 90, 80, (t) => evening(t) * 9 + night(t) * 4, {
      noise: 0.9,
      last: 84,
      digits: 0,
    });
    const upload = wave(ts, 5, 14, 8, (t) => night(t) * 6, { noise: 0.9, last: 12, digits: 0 });
    const clients = wave(ts, 7, 160, 14, (t) => evening(t) + (hourOf(t) < 6 ? -1.5 : 0), {
      noise: 0.3,
      last: 174,
      digits: 0,
    });
    const gwCpu = wave(ts, 11, 13, 6, (t) => evening(t) * 0.8, { noise: 0.5, last: 14, digits: 0 });
    const gwMem = wave(ts, 13, 41, 2, () => 0, { noise: 0.4, last: 41, digits: 0 });
    const ctCpu = wave(ts, 17, 3, 2, (t) => night(t) * 2, { noise: 0.6, last: 3 });
    const ctMem = wave(ts, 19, 1.4, 0.06, () => 0, { noise: 0.4, last: 1.4, digits: 2 });
    const devices: [string, string, 'ok' | 'bad', string, string][] = [
      ['UDM Pro Max', 'Gateway', 'ok', '10.100.0.1', '4.1.13'],
      ['USW Pro Max 24', 'Switch', 'ok', '10.100.0.3', '7.0.50'],
      ['USW Lite 8 PoE', 'Switch', 'ok', '10.100.0.4', '7.0.50'],
      ['AP Kantoor', 'U7 Pro', 'ok', '10.100.0.21', '8.0.24'],
      ['AP Bioscoop', 'U7 Pro', 'ok', '10.100.0.22', '8.0.24'],
      ['AP Paardenstal', 'U6 Mesh', 'bad', '10.100.0.23', '8.0.24'],
      ['AP Keuken', 'U7 Pro', 'ok', '10.100.0.24', '8.0.24'],
    ];
    const rows = Array.from({ length: 45 }, (_, i): ThingPageRow => {
      const [name, model, state, address, firmware] = devices[i] ?? [
        `AP ${i - 6}`,
        i % 3 ? 'U6 Lite' : 'U7 Pro',
        'ok',
        `10.100.0.${20 + i}`,
        '8.0.24',
      ];
      return {
        id: `dev-${i}`,
        cells: {
          name: { text: name, dot: state, ...(state === 'bad' ? { note: 'offline since 02:41' } : {}) },
          model: { text: model, tone: 'muted' },
          clients: { text: state === 'ok' ? String(4 + ((i * 7) % 19)) : '—' },
          address: { text: address, mono: true },
          firmware: { text: firmware, mono: true },
        },
      };
    });
    const machine = runsOn(UNIFI);
    return {
      id: UNIFI,
      kind: 'connection',
      connectionId: 'con_unifi' as ThingPage['connectionId'],
      catalogId: 'unifi',
      name: 'UniFi',
      icon: 'wifi',
      status: 'warn',
      badge: '1 access point offline',
      facts: [
        [{ text: 'UniFi Network ' }, { text: '9.4', strong: true }],
        [{ text: '45', strong: true }, { text: ' devices' }],
        [{ text: 'Checked 1 min ago' }],
      ],
      address: '10.100.0.100:11443',
      open: { label: 'Open UniFi', url: 'https://10.100.0.100:11443/' },
      runsOn: machine,
      settings: true,
      actions: [],
      readAt: new Date(made).toISOString(),
      ...ranged(range),
      tabs: [
        {
          key: 'overview',
          label: 'Summary',
          panels: [
            {
              kind: 'kpis',
              id: 'figures',
              place: 'top',
              items: [
                {
                  key: 'devices',
                  label: 'Devices online',
                  value: '44',
                  rest: 'of 45',
                  sub: '1 access point offline',
                  tone: 'warn',
                  meter: 44 / 45,
                },
                {
                  key: 'clients',
                  label: 'Clients',
                  value: '174',
                  sub: '131 Wi-Fi · 43 wired',
                  spark: spark(clients),
                  color: 'green',
                },
                {
                  key: 'internet',
                  label: 'Internet now',
                  value: '84',
                  rest: '/ 12 Mb/s',
                  sub: 'down / up · 12 ms',
                  spark: spark(down),
                  color: 'green',
                  // The charts these figures open (contracts 0.94 CT-449; connections-page.md CN-06, AP-2510).
                  charts: ['internet'],
                },
                {
                  key: 'gateway',
                  label: 'Gateway CPU',
                  value: '14 %',
                  sub: 'UDM Pro Max · memory 41 %',
                  spark: spark(gwCpu),
                  color: 'blue',
                  charts: ['gateway'],
                },
              ],
            },
            {
              kind: 'chart',
              id: 'internet',
              place: 'chart',
              span: 2,
              title: 'Internet',
              stats: [
                avgPeak(down, ts, 'Mb/s')[1] as ThingLine,
                [{ text: 'Fibre · ' }, { text: '1000 / 1000', strong: true }, { text: ' Mb/s' }],
              ],
              timestamps: iso(ts),
              series: [
                { key: 'wan_rx_mbps', label: 'Down', unit: 'Mb/s', values: down, color: 'green', fill: true },
                { key: 'wan_tx_mbps', label: 'Up', unit: 'Mb/s', values: upload, color: 'orange' },
              ],
              axis: { min: 0, unit: 'Mb/s' },
            },
            {
              kind: 'chart',
              id: 'gateway',
              place: 'chart',
              span: 1,
              title: 'Gateway',
              timestamps: iso(ts),
              series: [
                { key: 'gw_cpu', label: 'CPU', unit: '%', values: gwCpu, color: 'blue', fill: true },
                { key: 'gw_mem', label: 'Memory', unit: '%', values: gwMem, color: 'violet' },
              ],
              axis: { min: 0, max: 100, unit: '%' },
            },
            ...(machine
              ? ([
                  {
                    kind: 'chart',
                    id: 'machine-cpu',
                    place: 'chart',
                    span: 1,
                    title: 'CPU',
                    figure: { value: '3 %', rest: `of 2 cores · ${machine.name}` },
                    stats: avgPeak(ctCpu, ts, '%'),
                    timestamps: iso(ts),
                    series: [
                      { key: 'cpu', label: 'CPU', unit: '%', values: ctCpu, color: 'blue', fill: true },
                    ],
                    axis: { min: 0, unit: '%' },
                  },
                  {
                    kind: 'chart',
                    id: 'machine-memory',
                    place: 'chart',
                    span: 1,
                    title: 'Memory',
                    figure: { value: '1.4 GB', rest: 'of 2 GB' },
                    stats: avgPeak(ctMem, ts, 'GB'),
                    timestamps: iso(ts),
                    series: [
                      {
                        key: 'memory',
                        label: 'Memory',
                        unit: 'GB',
                        values: ctMem,
                        color: 'violet',
                        fill: true,
                      },
                    ],
                    axis: { min: 0, max: 2, unit: 'GB' },
                  },
                ] satisfies ThingPagePanel[])
              : []),
            {
              kind: 'table',
              id: 'devices',
              place: 'main',
              width: 'wide',
              title: 'Devices',
              meta: '44 of 45 online',
              link: { kind: 'tab', label: 'All 45 devices', tab: 'devices' },
              columns: [
                { key: 'name', label: 'Device' },
                { key: 'model', label: 'Model' },
                { key: 'clients', label: 'Clients', numeric: true },
                { key: 'firmware', label: 'Firmware' },
              ],
              rows: rows.slice(0, 7),
            },
            worth([
              {
                id: 'ap-offline',
                tone: 'bad',
                icon: 'network',
                title: 'AP Paardenstal is offline',
                detail: 'Since 02:41 · its switch port is up',
                link: {
                  kind: 'ask',
                  label: 'Look into it',
                  question: 'Why is AP Paardenstal offline while its switch port is up?',
                },
                nature: 'problem',
                check: 'unifi.device_offline',
                subject: { id: 'device:ap-paardenstal', name: 'AP Paardenstal' },
                ignore: { lifts: 'fixed', words: 'Until it’s back online.' },
              },
              {
                id: 'firmware',
                tone: 'info',
                icon: 'update',
                title: 'Firmware 7.1 for 3 switches',
                detail: 'Each restarts for about a minute',
                link: { kind: 'tab', label: 'Show them', tab: 'devices' },
                nature: 'fyi',
                check: 'unifi.firmware',
                ignore: { lifts: 'newer', words: 'Until there’s a newer version.' },
              },
            ]),
            changes(),
            access([
              { label: 'Read devices and traffic', tier: 'allowed', count: 6 },
              { label: 'Restart and set things', tier: 'mixed', count: 4 },
            ]),
            widgets(['Clients over the day', 'Speed tests']),
          ],
        },
        {
          key: 'devices',
          label: 'Devices',
          count: 45,
          panels: [
            {
              kind: 'table',
              id: 'devices',
              title: 'Devices',
              meta: '44 of 45 online',
              columns: [
                { key: 'name', label: 'Device' },
                { key: 'model', label: 'Model' },
                { key: 'clients', label: 'Clients', numeric: true },
                { key: 'address', label: 'Address' },
                { key: 'firmware', label: 'Firmware' },
              ],
              rows,
            },
          ],
        },
      ],
    };
  }

  /* Hetzner (hetzner.png, DS-12) ------------------------------------------------------------------------- */

  function hetzner(range: HostSeriesRange): ThingPage {
    const g = GRID[range];
    const ts = times(g.points, g.step);
    const deploy = (t: number) => (hourOf(t) >= 2 && hourOf(t) < 2.4 ? 1 : 0);
    const cpu = wave(ts, 41, 4.5, 3, (t) => deploy(t) * 11, { noise: 0.6, last: 7 });
    const rx = wave(ts, 43, 2, 1.2, (t) => 0.4 * Math.sin(t / 5e6), { noise: 0.6, last: 2.1 });
    const tx = wave(ts, 47, 3, 1.5, (t) => deploy(t) * 4 + 0.4 * Math.sin(t / 7e6), {
      noise: 0.6,
      last: 3.4,
    });
    const read = wave(ts, 53, 0.2, 0.2, (t) => deploy(t) * 6, { noise: 0.6, last: 0.2 });
    const write = wave(ts, 59, 1, 0.6, (t) => deploy(t) * 3, { noise: 0.6, last: 1.1 });
    return {
      id: HETZNER,
      kind: 'connection',
      connectionId: 'con_hetzner' as ThingPage['connectionId'],
      catalogId: 'hetzner',
      name: 'Hetzner',
      icon: 'cloud',
      status: 'ok',
      badge: 'All running',
      facts: [
        [{ text: 'Project ' }, { text: 'Whombat', strong: true }],
        [{ text: '1', strong: true }, { text: ' server' }],
        [{ text: 'Falkenstein' }],
        [{ text: 'Checked 1 min ago' }],
      ],
      open: { label: 'Open in Hetzner', url: 'https://console.hetzner.cloud/' },
      runsOn: null,
      settings: true,
      actions: [],
      readAt: new Date(made).toISOString(),
      ...ranged(range),
      tabs: [
        {
          key: 'overview',
          label: 'Summary',
          panels: [
            {
              kind: 'kpis',
              id: 'figures',
              place: 'top',
              items: [
                {
                  key: 'servers',
                  label: 'Servers',
                  value: '1',
                  rest: 'of 1 running',
                  sub: '4 vCPU · 8 GB in total',
                  meter: 1,
                  color: 'green',
                },
                {
                  key: 'cpu',
                  label: 'CPU',
                  value: '7 %',
                  sub: 'of 4 vCPU',
                  spark: spark(cpu),
                  color: 'blue',
                },
                {
                  key: 'traffic',
                  label: 'Traffic this month',
                  value: '0.4',
                  rest: '/ 20 TB',
                  sub: 'outgoing · included',
                  meter: 0.02,
                  color: 'green',
                },
                {
                  key: 'cost',
                  label: 'Cost',
                  value: '€15',
                  rest: 'a month',
                  sub: 'server, IPv4, backups off',
                },
              ],
            },
            {
              kind: 'chart',
              id: 'cpu',
              place: 'chart',
              span: 1,
              title: 'CPU',
              figure: { value: '7 %', rest: 'whombat-prod' },
              stats: avgPeak(cpu, ts, '%'),
              timestamps: iso(ts),
              series: [{ key: 'cpu', label: 'CPU', unit: '%', values: cpu, color: 'blue', fill: true }],
              axis: { min: 0, max: 100, unit: '%' },
            },
            {
              kind: 'chart',
              id: 'network',
              place: 'chart',
              span: 1,
              title: 'Network',
              timestamps: iso(ts),
              series: [
                { key: 'net_in', label: 'In', unit: 'Mb/s', values: rx, color: 'green', fill: true },
                { key: 'net_out', label: 'Out', unit: 'Mb/s', values: tx, color: 'orange' },
              ],
              axis: { min: 0 },
            },
            {
              kind: 'chart',
              // The server's id (`kinds/hetzner.ts`): Traffic opens it beside the network's.
              id: 'disk-io',
              place: 'chart',
              span: 1,
              title: 'Disk I/O',
              timestamps: iso(ts),
              series: [
                { key: 'disk_read', label: 'Read', unit: 'MB/s', values: read, color: 'blue', fill: true },
                { key: 'disk_write', label: 'Write', unit: 'MB/s', values: write, color: 'violet' },
              ],
              axis: { min: 0 },
            },
            {
              kind: 'table',
              id: 'servers',
              place: 'main',
              width: 'wide',
              title: 'Servers',
              link: { kind: 'tab', label: 'All servers', tab: 'servers' },
              columns: [
                { key: 'name', label: 'Server' },
                { key: 'type', label: 'Type' },
                { key: 'cpu', label: 'CPU', numeric: true },
                { key: 'day', label: range === '24h' ? '24 h' : DASHBOARD_RANGE_WORDS[range] },
                { key: 'address', label: 'Address' },
              ],
              rows: [
                {
                  id: 'whombat-prod',
                  cells: {
                    name: { text: 'whombat-prod', mono: true, dot: 'ok', note: 'Debian 13 · Falkenstein' },
                    type: { text: 'CX32', mono: true, note: '4 vCPU · 8 GB · 80 GB' },
                    cpu: { text: '7 %', meter: 0.07 },
                    day: { text: 'CPU', spark: spark(cpu) },
                    address: { text: '203.0.113.44', mono: true },
                  },
                },
              ],
            },
            {
              kind: 'text',
              id: 'agent',
              place: 'main',
              width: 'wide',
              body: 'Hetzner can’t see memory or disk space. Add whombat-prod as a server to see them here.',
              link: { kind: 'href', label: 'Add as a server', href: '/things/servers?add=1' },
            },
            worth([
              {
                id: 'backups',
                tone: 'warn',
                icon: 'warn',
                title: 'whombat-prod has no backups',
                detail: 'Hetzner backups are off · 20 % of the server price',
                link: {
                  kind: 'ask',
                  label: 'Turn on…',
                  question: 'Should I switch on Hetzner’s backups for whombat-prod?',
                },
              },
              {
                id: 'protection',
                tone: 'info',
                icon: 'info',
                title: 'Delete protection is off',
                detail: 'Anyone with the API token can delete it',
                link: {
                  kind: 'ask',
                  label: 'Turn on',
                  question: 'Turn on delete protection for whombat-prod in Hetzner.',
                },
              },
            ]),
            changes(),
            access([
              { label: 'Read servers, firewalls and costs', tier: 'allowed', count: 12 },
              { label: 'Create and change', tier: 'allowed', count: 8 },
              { label: 'Delete', tier: 'ask', count: 4 },
            ]),
            widgets(['Cost this month', 'Traffic used', 'Snapshots']),
          ],
        },
        {
          key: 'servers',
          label: 'Servers',
          count: 1,
          panels: [
            {
              kind: 'facts',
              id: 'whombat-prod',
              title: 'whombat-prod',
              items: [
                { label: 'State', value: 'Running' },
                { label: 'Type', value: 'CX32 · 4 vCPU · 8 GB · 80 GB' },
                { label: 'Location', value: 'Falkenstein (fsn1)' },
                { label: 'Address', value: '203.0.113.44', mono: true },
                { label: 'Backups', value: 'Off' },
                { label: 'Delete protection', value: 'Off' },
              ],
            },
          ],
        },
        {
          key: 'volumes',
          label: 'Volumes',
          count: 0,
          panels: [
            {
              kind: 'list',
              id: 'volumes',
              title: 'Volumes',
              items: [],
              empty: 'No volumes in this project.',
            },
          ],
        },
      ],
    };
  }

  /* The generic page, in slots (Whombat service-slots.md: the page of a connection without a kind) ----------- */

  /** “With Whombat” and “Answer time”, as the server words them from its checks (`things/generic.ts`). */
  function answering(): ThingPagePanel[] {
    const DAY = 24 * HOUR;
    const days = Array.from({ length: 7 }, (_, i) => made - (6 - i) * DAY);
    const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short' });
    return [
      {
        kind: 'list',
        id: 'answers',
        look: 'counts',
        place: 'chart',
        span: 1,
        width: 'full',
        title: 'With Whombat',
        meta: 'Its checks and use',
        items: [
          {
            id: 'answers',
            title: 'Answers',
            icon: 'network',
            detail: '2,016 checks in 7 days',
            right: '99.9 %',
            figure: { value: '99.9 %', note: '2 didn’t answer', tone: 'warn' },
          },
          {
            id: 'answer-time',
            title: 'Answers in',
            icon: 'clock',
            detail: 'Typical today',
            right: '182 ms',
            figure: { value: '182 ms', note: '−6 % on last week' },
          },
        ],
      },
      {
        kind: 'chart',
        id: 'week',
        place: 'chart',
        span: 2,
        width: 'full',
        title: 'Answer time',
        meta: 'Typical per day',
        style: 'bars',
        timestamps: days.map((d) => new Date(d).toISOString()),
        labels: days.map((d, i) => (i === 6 ? 'Today' : weekday.format(d))),
        series: [
          {
            key: 'values',
            label: 'Answer time',
            unit: 'ms',
            values: [191, 188, 205, 179, 184, 176, 182],
            color: 'blue',
          },
        ],
        figure: { value: '186 ms', rest: 'typical this week' },
        stats: [[{ text: '−6 %', strong: true }, { text: ' on last week' }]],
        axis: { min: 0 },
      },
    ];
  }

  function generic(
    thing: string,
    range: HostSeriesRange,
    base: Partial<ThingPage> & Pick<ThingPage, 'name' | 'icon'>,
    notices: ThingPageNotice[] = [],
  ): ThingPage {
    const parsed = parseThingId(thing);
    return {
      id: thing,
      kind: 'connection',
      ...(parsed ? { connectionId: parsed.id as ThingPage['connectionId'] } : {}),
      status: 'ok',
      badge: 'Running fine',
      facts: [],
      runsOn: null,
      settings: false,
      actions: [],
      readAt: new Date(made).toISOString(),
      // Nothing on it follows the range: the page offers only its own.
      range,
      ranges: [range],
      refreshS: 60,
      tabs: [
        {
          key: 'overview',
          label: 'Summary',
          panels: [
            ...(notices.length ? [{ ...worth(notices), place: 'top' as const, width: 'full' as const }] : []),
            ...answering(),
            changes(),
          ],
        },
      ],
      ...base,
    };
  }

  function tracker(range: HostSeriesRange): ThingPage {
    return generic(TRACKER, range, {
      catalogId: 'tracker',
      name: 'Acme Desk dev',
      icon: 'plug',
      logo: ACME_DESK_LOGO,
      settings: true,
      address: 'dev.desk.acme.example',
      open: { label: 'Open Acme Desk', url: 'https://dev.desk.acme.example/' },
      facts: [
        [{ text: 'Development · Acme Desk ' }, { text: '0.1.174', strong: true }],
        [{ text: 'Used by ' }, { text: 'automations', strong: true }],
        [{ text: 'Checked 2 min ago' }],
      ],
    });
  }

  function partOfServer(range: HostSeriesRange): ThingPage {
    const page = generic(PVE_API, range, {
      catalogId: 'proxmox',
      name: 'Proxmox VE API',
      icon: 'server',
      settings: true,
      address: '10.100.0.2:8006',
      partOf: 'server:pve-02',
      facts: [[{ text: 'Proxmox VE ' }, { text: '9.2', strong: true }]],
    });
    const [overview] = page.tabs;
    if (overview)
      overview.panels = [
        {
          kind: 'text',
          id: 'part',
          place: 'top',
          body: 'This is how Whombat reaches pve-02’s Proxmox API.',
          link: { kind: 'href', label: 'Open pve-02', href: thingHref('server', 'pve-02') },
        },
        ...overview.panels,
      ];
    return page;
  }

  /* Devices (CP-13, DS-14) ----------------------------------------------------------------------------- */

  function device(thing: string, range: HostSeriesRange, name: string, icon: string): ThingPage {
    const g = GRID[range];
    const ts = times(g.points, g.step);
    const ph = wave(ts, 17, 7.35, 0.2, (t) => (hourOf(t) > 9 ? 0.6 : 0) + 0.4 * Math.sin(t / 2e7), {
      noise: 0.3,
      last: 7.6,
      digits: 2,
    });
    const chlorine = wave(ts, 19, 1.15, 0.2, (t) => 0.5 * Math.sin(t / 3e7), {
      noise: 0.3,
      last: 1.2,
      digits: 2,
    });
    const water = wave(ts, 23, 25.6, 0.8, (t) => Math.sin(((hourOf(t) - 10) / 24) * Math.PI * 2), {
      noise: 0.2,
      last: 26.4,
    });
    const parsed = parseThingId(thing);
    const reading = (
      id: string,
      title: string,
      figure: string,
      unit: string,
      values: number[],
      color: 'blue' | 'green' | 'orange' | 'amber',
      extra: Partial<Extract<ThingPagePanel, { kind: 'chart' }>> = {},
    ): ThingPagePanel => ({
      kind: 'chart',
      id,
      place: 'chart',
      span: 1,
      title,
      figure: { value: figure, ...(extra.figure ?? {}) },
      stats: avgPeak(values, ts, unit),
      timestamps: iso(ts),
      series: [{ key: `r_${id}`, label: title, ...(unit ? { unit } : {}), values, color, fill: true }],
      ...extra,
    });
    return {
      id: thing,
      kind: 'device',
      ...(parsed ? { connectionId: parsed.id as ThingPage['connectionId'] } : {}),
      catalogId: 'device',
      name,
      icon,
      status: 'warn',
      badge: 'pH too high',
      facts: [
        [{ text: 'Pool controller' }, { text: ' · Modbus' }],
        [{ text: 'Read ' }, { text: '1 min ago', strong: true }],
        [
          { text: 'Whombat may ' },
          { text: 'change 2 things', strong: true },
          { text: ' · within your limits' },
        ],
      ],
      address: '10.100.0.57:502',
      runsOn: null,
      settings: true,
      actions: [],
      readAt: new Date(made - 60_000).toISOString(),
      ...ranged(range),
      tabs: [
        {
          key: 'overview',
          label: 'Summary',
          panels: [
            {
              kind: 'kpis',
              id: 'figures',
              place: 'top',
              items: [
                {
                  key: 'ph',
                  label: 'pH',
                  value: '7.6',
                  sub: 'aim 7.0 to 7.4',
                  tone: 'warn',
                  spark: spark(ph),
                },
                {
                  key: 'chlorine',
                  label: 'Chlorine',
                  value: '1.2',
                  rest: 'mg/l',
                  sub: 'fine',
                  spark: spark(chlorine),
                  color: 'green',
                },
                {
                  key: 'water',
                  label: 'Water',
                  value: '26.4',
                  rest: '°C',
                  sub: 'heating on',
                  spark: spark(water),
                  color: 'orange',
                },
                { key: 'pump', label: 'Pump', value: 'Running', sub: 'until 20:00' },
              ],
            },
            reading('ph', 'pH', '7.6', '', ph, 'amber', {
              figure: { value: '7.6', rest: 'aim 7.0 to 7.4', tone: 'warn' },
              line: { value: 7.4, label: 'pH 7.4' },
            }),
            reading('chlorine', 'Chlorine', '1.2 mg/l', 'mg/l', chlorine, 'green', { axis: { min: 0 } }),
            reading('water', 'Water', '26.4 °C', '°C', water, 'orange'),
            {
              kind: 'table',
              id: 'readings-all',
              place: 'main',
              width: 'wide',
              title: 'All readings',
              columns: [
                { key: 'name', label: 'Reading' },
                { key: 'value', label: 'Now', numeric: true },
                { key: 'range', label: 'Today' },
              ],
              rows: [
                ['pH', '7.6', '7.2 to 7.6'],
                ['Chlorine', '1.2 mg/l', '0.9 to 1.4 mg/l'],
                ['Water', '26.4 °C', '25.1 to 26.4 °C'],
                ['Pump', 'Running', 'ran 9 h'],
                ['Acid dosing', 'Off', 'dosed 3 times'],
              ].map(([n, v, span]) => ({
                id: String(n),
                cells: {
                  name: { text: String(n) },
                  value: { text: String(v) },
                  range: { text: String(span), tone: 'muted' },
                },
              })),
            },
            worth([
              {
                id: 'ph',
                tone: 'warn',
                icon: 'device',
                title: 'pH 7.6, above 7.4 since 09:10',
                detail: 'The acid tank may be nearly empty',
                link: {
                  kind: 'ask',
                  label: 'Look into it',
                  question: 'Why is the pool’s pH above 7.4 since this morning?',
                },
              },
            ]),
            {
              kind: 'list',
              id: 'failed',
              place: 'side',
              width: 'narrow',
              title: 'Reads that failed',
              items: [
                {
                  id: 'timeout',
                  title: 'No answer for 2 minutes',
                  detail: 'The gateway restarted',
                  at: at(0, '04:12'),
                  tone: 'warn',
                },
              ],
            },
            changes(),
            access([
              { label: 'Read it', tier: 'allowed', count: 1 },
              { label: 'Run the pump', tier: 'allowed', count: 1 },
              { label: 'Dose acid', tier: 'ask', count: 1 },
            ]),
          ],
        },
      ],
    };
  }

  function learning(thing: string, s: ThingSummary): ThingPage {
    return {
      id: thing,
      kind: 'device',
      proposalId: 'dvp_heat-pump' as ThingPage['proposalId'],
      catalogId: 'device',
      name: s.name,
      icon: s.icon,
      status: 'learning',
      badge: 'Learning',
      facts: [[{ text: 'Daikin Altherma heat pump' }]],
      runsOn: null,
      settings: false,
      actions: [],
      readAt: null,
      tabs: [
        {
          key: 'overview',
          label: 'Summary',
          panels: [
            {
              kind: 'text',
              id: 'learning',
              place: 'main',
              width: 'wide',
              title: 'Being learned',
              body: 'Neo found your Daikin heat pump and can read its temperatures. Want Neo to be able to change them too?',
              link: { kind: 'href', label: 'Choose', href: '/chats/cnv_chat-heat-pump' },
            },
            {
              kind: 'list',
              id: 'tested',
              place: 'side',
              width: 'narrow',
              title: 'What Whombat tested',
              items: [
                {
                  id: 'room',
                  title: 'Room temperature',
                  detail: 'Read 21.0 °C, the display shows 21.0 °C',
                  tone: 'ok',
                },
                {
                  id: 'water',
                  title: 'Water to the radiators',
                  detail: 'Read 34 °C, the display shows 34 °C',
                  tone: 'ok',
                },
                {
                  id: 'outside',
                  title: 'Outside temperature',
                  detail: 'Read 9 °C, the display shows 9 °C',
                  tone: 'ok',
                },
                { id: 'mode', title: 'Mode', detail: 'Heating, as the display shows', tone: 'ok' },
              ],
            },
          ],
        },
      ],
    };
  }

  /* Pages by thingId ------------------------------------------------------------------------------- */

  /** Home Assistant's page with its Controls live (in its slots), read again every 10 s while open (SD-30). */
  function withControls(p: ThingPage): ThingPage {
    return services && options.controls ? { ...p, refreshS: 10 } : p;
  }

  /** As a real Whombat lays out a Summary: each figure names the charts it opens (`openThingFigures`). */
  function laidOut(p: ThingPage | null): ThingPage | null {
    if (!p) return p;
    const keys = p.tabs.map((t) => t.key);
    return {
      ...p,
      tabs: p.tabs.map((t, i) => (i === 0 ? { ...t, panels: openThingFigures(t.panels, keys) } : t)),
    };
  }

  function page(thing: string, range: HostSeriesRange = '24h'): ThingPage | null {
    return laidOut(pageOf(thing, range));
  }

  function pageOf(thing: string, range: HostSeriesRange): ThingPage | null {
    if (thing === HA) return withControls(homeAssistant(range));
    if (services && thing === SERVICE_THINGS.plex) {
      const plex = services.page(thing);
      return plex ? plexSettings.decorate(plex) : null;
    }
    if (services && SERVICES.includes(thing)) return services.page(thing);
    if (thing === UNIFI) return unifi(range);
    if (thing === HETZNER) return hetzner(range);
    if (thing === TRACKER) return tracker(range);
    if (thing === PVE_API) return partOfServer(range);
    // Find My's page names its Mac; the apps draw its tab from studio's Find My (answered by address always).
    if (thing === FIND_MY_THING) return findMyConnectionPage(new Date(made).toISOString(), range);
    if (thing === POOL) return device(POOL, range, 'Pool', 'device');
    const s = summary(thing);
    if (thing === HEAT && s) {
      if (s.status === 'learning') return learning(thing, s);
      return { ...device(thing, range, s.name, s.icon), badge: 'Running fine', status: 'ok' };
    }
    if (!s || s.kind === 'server') return null;
    return generic(thing, range, {
      kind: s.kind,
      name: s.name,
      icon: s.icon,
      ...(s.catalogId ? { catalogId: s.catalogId } : {}),
      status: s.status === 'learning' ? 'unknown' : s.status,
      ...(s.line ? { facts: [[{ text: s.line }]] } : {}),
    });
  }

  function restart(thing: string): Response {
    const p = page(thing);
    const action = p?.actions.find((a) => a.id === 'restart');
    if (!p || !action) return refused(404, 'not_found', 'There’s nothing to restart here.');
    restartedAt = one.now();
    const change: ChangeEntry = {
      id: `chg_restart-${++seq}` as ChangeEntry['id'],
      title: `Restarted ${p.name}`,
      at: new Date(restartedAt).toISOString(),
      actor: { kind: 'person', id: mara.id, name: mara.name },
      undo: { state: 'none' },
      thingId: thing,
      link: thingHref(p.kind, parseThingId(thing)?.id ?? thing),
    };
    one.addChange(change);
    return json({ message: `Restarting ${p.name}. It’s back in about a minute.`, changeId: change.id }, 202);
  }

  function setRunsOn(connectionId: string, choice: SetRunsOnBody): Response {
    const thing = `connection:${connectionId}`;
    if (!page(thing)) return refused(404, 'not_found', 'That connection isn’t here any more.');
    if (choice.mode === 'auto') chosen.delete(thing);
    else if (choice.mode === 'none') chosen.set(thing, null);
    else {
      const guest = choice.guestId ? (GUEST_WORDS[choice.guestId] ?? choice.guestId) : null;
      chosen.set(thing, {
        serverId: choice.serverId,
        guestId: choice.guestId,
        name: guest ? `${choice.serverId} · ${guest}` : choice.serverId,
        href: serverHref(choice.serverId, choice.guestId),
        how: 'chosen',
      });
    }
    return json({ runsOn: runsOn(thing) });
  }

  function tools(connectionId: string): Response | null {
    const known = CONNECTIONS[connectionId];
    if (!known) return null;
    const connection = fixtureConnectionView(connectionId, known.catalogId, known.fields, {
      ...(known.label ? { label: known.label } : {}),
      createdAt: at(-10, '09:12'),
      checkedAt: new Date(made - 4 * 60_000).toISOString(),
      lastUsedAt: at(0, '11:20'),
    });
    const list =
      known.catalogId === 'device' ? DEVICE_TOOLS.map((t) => ({ ...t })) : fixtureEntryTools(known.catalogId);
    return json({
      connection: { ...connection, toolCount: list.length },
      tools: list,
      guide: catalogEntry(known.catalogId)?.guide ?? '',
      truncated: false,
    });
  }

  /** Another layer's connection (the catalog's Todoist, Nextcloud, Fusebox…): the generic page from its view. */
  async function fromCatalog(
    thing: string,
    origin: string,
    range: HostSeriesRange,
    inner: (req: Request) => Promise<Response>,
  ): Promise<ThingPage | null> {
    const parsed = parseThingId(thing);
    if (parsed?.kind !== 'connection') return null;
    const res = await inner(new Request(`${origin}${B}/connections/${parsed.id}/tools`));
    if (!res.ok) return null;
    const { connection: c, tools: list } = (await res.json()) as {
      connection: ConnectionView;
      tools: ConnectionToolView[];
    };
    const needs = c.status !== 'active';
    const host = c.fields.url ? c.fields.url.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '') : undefined;
    const reads = list.filter((t) => t.access === 'read');
    const changes = list.filter((t) => t.access !== 'read');
    const tier = (ts: ConnectionToolView[]) =>
      ts.every((t) => t.tier === 'off')
        ? ('off' as const)
        : ts.every((t) => t.tier === 'can' && !t.sensitive)
          ? ('allowed' as const)
          : ts.every((t) => t.tier === 'ask' || t.sensitive)
            ? ('ask' as const)
            : ('mixed' as const);
    const reauth: ThingPageNotice = {
      id: 'reauth',
      tone: 'bad',
      icon: 'key',
      title: 'Needs to be connected again',
      detail: 'It signed Whombat out',
      link: { kind: 'tab', label: 'Connect again', tab: 'settings' },
    };
    const base = generic(
      thing,
      range,
      {
        ...(c.catalogId ? { catalogId: c.catalogId } : {}),
        name: c.label.split(' · ')[0] ?? c.label,
        icon: c.catalogId,
        settings: true,
        status: needs ? 'bad' : 'ok',
        badge: needs ? 'Needs to be connected again' : 'Running fine',
        ...(host ? { address: host } : c.detail ? { address: c.detail } : {}),
        facts: [
          [
            { text: 'Connected by ' },
            { text: c.connectedBy.name.split(' ')[0] ?? c.connectedBy.name, strong: true },
          ],
        ],
      },
      needs ? [reauth] : [],
    );
    const [overview] = base.tabs;
    if (overview) {
      if (list.length)
        overview.panels.push({
          kind: 'access',
          id: 'access',
          place: 'main',
          width: 'wide',
          title: 'What Whombat may do',
          lookOnly: c.access === 'read',
          items: [
            ...(reads.length ? [{ label: 'Read', tier: tier(reads), count: reads.length }] : []),
            ...(changes.length
              ? [{ label: 'Change things', tier: tier(changes), count: changes.length }]
              : []),
          ],
        });
    }
    return base;
  }

  /* Quiet notices (quiet-notices.md AP-4831) --------------------------------------------------------------------- */

  const quiets = createQuietFixtures({
    now: () => made,
    by: { id: mara.id, name: 'Mara' },
    checks: (thing) => (thing === UNIFI ? UNIFI_CHECKS : []),
  });

  async function quietRequest(thing: string, what: string, req: Request): Promise<Response> {
    const p = page(thing, '24h');
    if (!p) return refused(404, 'not_found', 'There’s nothing here by that name.');
    if (what === '/watch' && req.method === 'GET') return json(quiets.watch(thing));
    if (req.method !== 'POST') return refused(404, 'not_found', 'Not here.');
    const answer =
      what === '/quiet'
        ? quiets.quiet(thing, (await req.json()) as QuietNoticeBody, quiets.settle(thing, p))
        : quiets.setWatch(thing, (await req.json()) as SetThingWatchBody);
    return json(answer.body, answer.status);
  }

  return {
    page,
    async handle(req, inner) {
      const url = new URL(req.url, 'http://fixtures.local');
      if (!url.pathname.startsWith(`${B}/`)) return null;
      const rest = url.pathname.slice(B.length);
      // Putting a Plex setting back (SST-03): this layer puts the value back; the world's changes list marks it undone.
      const undo = /^\/changes\/(chg_fx_plex_[A-Za-z0-9_]+)\/undo$/.exec(rest);
      if (undo && req.method === 'POST') {
        const done = plexSettings.undo(undo[1] as string);
        if (done && 'answer' in done) return json(done.answer.body, done.answer.status);
        return null;
      }
      const thingPath = /^\/things\/([^/]+)(\/actions|\/quiet|\/watch|\/images\/([^/]+))?$/.exec(rest);
      if (thingPath) {
        const thing = decodeURIComponent(thingPath[1] as string);
        // Plex's page with its settings, and its settings' and Scan all's presses (SST-01…SST-10).
        if (services && thing === SERVICE_THINGS.plex) {
          if (req.method === 'GET' && !thingPath[2]) {
            const p = page(thing);
            return p ? json(p) : refused(404, 'not_found', 'There’s nothing here by that name.');
          }
          if (req.method === 'POST' && thingPath[2] === '/actions') {
            const answer = plexSettings.action((await req.clone().json()) as ThingActionBody);
            if (answer) return json(answer.body, answer.status);
          }
        }
        // The service pages answer their own things: pages, buttons, pictures and quiet lines (AP-4571, AP-4831).
        if (services && SERVICES.includes(thing)) return handleServicePagesRequest(services, req);
        // A server's quiet lines are the servers' layer's (hostsFixtures.ts).
        if (thing.startsWith('server:')) return null;
        if (thingPath[2] === '/quiet' || thingPath[2] === '/watch')
          return quietRequest(thing, thingPath[2], req);
        if (thingPath[3] !== undefined) {
          // Home Assistant's pictures (a camera's snapshot in its Controls).
          const picture = thing === HA && services ? services.image(decodeURIComponent(thingPath[3])) : null;
          if (!picture || req.method !== 'GET') return new Response(null, { status: 404 });
          return new Response(picture.bytes.slice().buffer as ArrayBuffer, {
            status: 200,
            headers: { 'content-type': picture.contentType, 'cache-control': 'private, max-age=300' },
          });
        }
        if (req.method === 'GET' && !thingPath[2]) {
          // A range the page doesn't offer gives its default (CT-397).
          const asked = url.searchParams.get('range');
          const range = RANGES.find((r) => r === asked) ?? '24h';
          const p = page(thing, range) ?? (inner ? await fromCatalog(thing, url.origin, range, inner) : null);
          return p
            ? json(quiets.settle(thing, p))
            : refused(404, 'not_found', 'There’s nothing here by that name.');
        }
        if (req.method === 'POST' && thingPath[2]) {
          const body = (await req.json()) as ThingActionBody;
          if (body.action === 'restart') return restart(thing);
          // Home Assistant's Controls (SD-30): switches, steppers and buttons of the service pages' world.
          const answer = thing === HA && services ? services.action(HA, body) : null;
          if (answer) return json(answer.body, answer.status);
          return refused(404, 'not_found', 'There’s nothing to do by that name.');
        }
      }
      const runs = /^\/connections\/(con_[A-Za-z0-9_-]+)\/runs-on$/.exec(rest);
      if (runs && req.method === 'POST')
        return setRunsOn(runs[1] as string, (await req.json()) as SetRunsOnBody);
      const toolsPath = /^\/connections\/(con_[A-Za-z0-9_-]+)\/tools$/.exec(rest);
      if (toolsPath && req.method === 'GET') return tools(toolsPath[1] as string);
      return null;
    },
  };
}

/** A switched-on device's tools: reading it, and each action with its tier (CP-13). */
const DEVICE_TOOLS = [
  {
    name: 'pool_read',
    description: 'Read every reading: pH, chlorine, water temperature, the pump and acid dosing.',
    access: 'read' as const,
    tier: 'can' as const,
    sensitive: false,
    isNew: false,
  },
  {
    name: 'pool_pump',
    description: 'Run the pump or stop it, between 06:00 and 22:00.',
    access: 'write' as const,
    tier: 'can' as const,
    sensitive: false,
    isNew: false,
  },
  {
    name: 'pool_dose_acid',
    description: 'Dose acid, at most 200 ml a day.',
    access: 'write' as const,
    tier: 'ask' as const,
    sensitive: false,
    isNew: false,
  },
];

/** Home Assistant's integrations as its page lists them: the two not loading first. */
const INTEGRATIONS: [string, string, 'ok' | 'warn' | 'bad', string?][] = (() => {
  const out: [string, string, 'ok' | 'warn' | 'bad', string?][] = [
    ['Shelly', 'Pool pump', 'warn', 'since Thu 07:12'],
    ['Shelly', 'Garage door', 'warn', 'since Thu 07:12'],
  ];
  const named: [string, string][] = [
    ['MQTT', 'Mosquitto'],
    ['KNX', 'KNX tunnel'],
    ['Zigbee Home Automation', 'SkyConnect'],
    ['UniFi Network', 'UDM Pro Max'],
    ['Sonos', 'Living room'],
    ['Met.no', 'Home'],
    ['Google Cast', 'Kitchen display'],
    ['HomeKit Bridge', 'Whole house'],
    ['Mobile App', 'Mara’s phone'],
    ['Mobile App', 'John’s phone'],
    ['Philips Hue', 'Bridge'],
    ['Solar', 'Inverter'],
    ['P1 meter', 'Energy'],
  ];
  for (const [d, t] of named) out.push([d, t, 'ok']);
  const rooms = ['kitchen', 'hall', 'garden', 'bathroom', 'office', 'bedroom', 'garage', 'attic', 'shed'];
  for (let i = 0; out.length < 102; i++) {
    const room = rooms[i % rooms.length] as string;
    const kind = i % 3 === 0 ? 'ESPHome' : i % 3 === 1 ? 'Shelly' : 'Tasmota';
    out.push([
      kind,
      `${room}-${kind === 'ESPHome' ? 'sensor' : 'plug'}-${Math.floor(i / rooms.length) + 1}`,
      'ok',
    ]);
  }
  return out;
})();
