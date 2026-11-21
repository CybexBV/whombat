/**
 * The demo world's connection and device pages (Whombat connection-pages.md CP-01…CP-15, dashboards.md DS-01…DS-14;
 * connection-pages-mobile.md AP-1966, dashboards-mobile.md AP-2134): `things.page` for Home Assistant (John's
 * dashboard mock `ha.png`: CPU, memory, disk and database with their small lines, 100 of 102 integrations; chart cards
 * for CPU, memory, disk space with its forecast, errors in the log per hour and the database; integrations not loading,
 * backups, nine things worth a look), UniFi (21 of 22 access points), Hetzner (`hetzner.png`: one server, its CPU,
 * network and disk), Mail (a connection without a page of its own: the generic Summary, DS-14) and the heat pump (its
 * readings once switched on, what Neo found while it is learned), each over the range asked (`?range=`, 1 h…30 d, on
 * the hosts service's time grid); `things.action` (Restart, recorded as Mara's change); `changes.list?thing=` and
 * `widgets.list?thing=` for the pages' own lists. Pure TypeScript over `Response`; every answer parses with its
 * endpoint's schema (`thingPages.test.ts`).
 *
 * The service pages (contracts 0.121, CT-1011; service-dashboards.md AP-4660): Plex, Seerr, SABnzbd, UniFi Protect and
 * Pi-hole from `@whombat/fixtures`' `createServicePages`, their buttons pressed through `things.action` (pausing,
 * approving and switching change what the next read shows), and Home Assistant's Controls at the top of its page's
 * main column, read again every 10 seconds (SD-30). Their pictures are drawn on the phone (`fixturePictureDataUrl`).
 * Their lines can be ignored, snoozed and stopped (`things.quiet`, `things.watch`, `things.setWatch`, contracts 0.122;
 * quiet-notices-mobile.md AP-4870).
 */
import type {
  ChangeEntry,
  HostSeriesRange,
  ThingLine,
  ThingPage,
  ThingPagePanel,
  ThingPageTab,
  Widget,
} from '@whombat/core';
import type { QuietNoticeBody, SetThingWatchBody, ThingActionBody } from '@whombat/core/contracts';
import {
  createServicePages,
  homeAssistantSlotPanels,
  mara,
  SERVICE_PAGE_THINGS,
  SERVICE_THINGS,
} from '@whombat/fixtures';
import { createPlexSettings } from './plexSettings';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The ranges a connection's page offers (DS-03). */
const RANGES: HostSeriesRange[] = ['1h', '6h', '24h', '7d', '30d'];
/** Each range's points (the hosts service's grid; a small line keeps at most 120). */
const GRID: Record<HostSeriesRange, { step: number; points: number }> = {
  '1h': { step: 5 * MINUTE, points: 13 },
  '6h': { step: 5 * MINUTE, points: 73 },
  '24h': { step: 15 * MINUTE, points: 97 },
  '7d': { step: 2 * HOUR, points: 85 },
  '30d': { step: 6 * HOUR, points: 120 },
  '90d': { step: 18 * HOUR, points: 120 },
};

type Json = (body: unknown, status?: number) => Response;

export interface ThingPageFixtureOptions {
  now: () => Date;
  json: Json;
  notFound: (text: string) => Response;
  bodyOf: <T>(init: RequestInit | undefined) => Promise<T>;
  /** Whether the heat pump's skill is switched on (else it is being learned). */
  heatOn: () => boolean;
  /** The assistant as it is called now (renaming it changes the panels' titles). */
  assistant: () => { id: string; name: string };
  /** Where the heat pump's chat is (its proposal card), for “Open the chat”: its thread in Chat, or its task chat. */
  heatChatHref: string;
}

/** A deterministic wave of `n` values: `base` ± `swing`, a spike now and then, a dip at `dipAt` (a restart). */
function wave(n: number, base: number, swing: number, seed: number, dipAt?: number): number[] {
  return Array.from({ length: n }, (_, i) => {
    if (dipAt !== undefined && i >= dipAt && i < dipAt + 2) return Math.round(base * 0.3 * 10) / 10;
    const spike = (i * 7 + seed) % 23 === 0 ? swing * 3 : 0;
    const v = base + Math.sin((i + seed) / 3) * swing + Math.cos((i * seed) / 11) * swing * 0.4 + spike;
    return Math.round(Math.max(0, v) * 10) / 10;
  });
}

/** `n` values climbing from `from` to `to`, with a little noise (a disk filling up). */
function ramp(n: number, from: number, to: number, seed: number): number[] {
  return Array.from({ length: n }, (_, i) => {
    const v = from + ((to - from) * i) / Math.max(1, n - 1) + Math.sin((i + seed) / 2) * (to - from) * 0.02;
    return Math.round(v * 100) / 100;
  });
}

/** “Avg **1.8 %**” and “Peak **4.6 %** Sun 04:05”. */
const avgPeak = (avg: string, peak: string, when: string): ThingLine[] => [
  [{ text: 'Avg ' }, { text: avg, strong: true }],
  [{ text: 'Peak ' }, { text: peak, strong: true }, { text: ` ${when}` }],
];

const iso = (ms: number) => new Date(ms).toISOString();

/** Home Assistant's thing in the phone's demo world. */
const HOME_ASSISTANT = 'connection:con_ha';
// Every service page `@whombat/fixtures` answers: the built-in ones and each group's (`servicePages/<group>.ts`).
const SERVICES: readonly string[] = SERVICE_PAGE_THINGS;

export function createThingPageFixtures(options: ThingPageFixtureOptions) {
  const { now, json, notFound, bodyOf } = options;
  // The service pages and Home Assistant's Controls (AP-4660), on the world's clock.
  const services = createServicePages({ now: () => now().getTime(), homeAssistant: HOME_ASSISTANT });
  // Plex's settings tab, its cards' Ask and its verdict (service-settings.md SST-01…SST-10).
  const plexSettings = createPlexSettings({
    now: () => now().getTime(),
    assistant: options.assistant,
    person: { id: mara.id, name: mara.name },
    thingId: SERVICE_THINGS.plex,
  });
  /** When Mara restarted Home Assistant here, if she did. */
  let restartedAt: number | null = null;
  const extraChanges: ChangeEntry[] = [];
  const removedWidgets = new Set<string>();

  /** The range's timestamps, ending at the last step before now. */
  const timestamps = (range: HostSeriesRange) => {
    const { step, points } = GRID[range];
    const end = Math.floor(now().getTime() / step) * step;
    return Array.from({ length: points }, (_, i) => iso(end - (points - 1 - i) * step));
  };
  const ago = (ms: number) => iso(now().getTime() - ms);
  const whombat = () => ({
    kind: 'whombat' as const,
    id: options.assistant().id,
    name: options.assistant().name,
  });
  const named = () => options.assistant().name;
  /** “18 Dec”, in the burrow's zone. */
  const day = (ms: number) =>
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/Amsterdam' }).format(
      ms,
    );
  /** What every connection page says about its range (CT-397). */
  const ranged = (range: HostSeriesRange) => ({ range, ranges: RANGES, refreshS: 60 });

  /* The pages' shared parts (CP-06) ------------------------------------------------------------------------------ */

  const changesPanel = (): ThingPagePanel => ({
    kind: 'changes',
    id: 'changes',
    width: 'wide',
    place: 'main',
    title: `${named()} did here`,
    limit: 5,
  });
  const access = (items: Extract<ThingPagePanel, { kind: 'access' }>['items']): ThingPagePanel => ({
    kind: 'access',
    id: 'access',
    width: 'narrow',
    place: 'side',
    title: `What ${named()} may do`,
    items,
    lookOnly: false,
  });
  const widgets = (suggestions: string[]): ThingPagePanel => ({
    kind: 'widgets',
    id: 'widgets',
    place: 'bottom',
    title: 'Show more here',
    suggestions,
  });
  const summary = (panels: ThingPagePanel[]): ThingPageTab => ({
    key: 'overview',
    label: 'Summary',
    panels,
  });
  /** Worth a look as a strip on top, as a real Whombat's page in slots has it. */
  const strip = (items: Extract<ThingPagePanel, { kind: 'notices' }>['items']): ThingPagePanel => ({
    kind: 'notices',
    id: 'looks',
    place: 'top',
    title: 'Worth a look',
    empty: 'Nothing needs a look.',
    items,
  });
  const looks = (items: Extract<ThingPagePanel, { kind: 'notices' }>['items']): ThingPagePanel => ({
    kind: 'notices',
    id: 'looks',
    width: 'narrow',
    place: 'side',
    title: 'Worth a look',
    empty: 'Nothing needs a look.',
    items,
  });

  /* Home Assistant (DS-10, ha.png) ------------------------------------------------------------------------------- */

  /**
   * The figures and chart cards of a page that isn't in slots (dashboards.md DS-10, the mock ha.png): CPU, memory, disk
   * with its forecast, errors in the log stacked, the database. The chart helpers' tests read them.
   */
  function dashboardSample(range: HostSeriesRange): ThingPagePanel[] {
    const ts = timestamps(range);
    const n = ts.length;
    const cpu = wave(n, 1.8, 0.5, 3);
    const memory = wave(n, 2.9, 0.06, 5);
    const disk = ramp(n, 71, 76, 11);
    const database = ramp(n, 5.6, 6.0, 4);
    const top = wave(n, 470, 25, 2).map((v, i) => (i === n - 6 ? 1060 : Math.round(v)));
    const rest = wave(n, 42, 6, 9).map(Math.round);
    const full = now().getTime() + 61 * DAY;
    return [
      {
        kind: 'kpis',
        id: 'figures',
        place: 'top',
        items: [
          {
            key: 'cpu',
            label: 'CPU',
            value: '2 %',
            sub: 'of 4 cores',
            spark: cpu.slice(-120),
            color: 'blue',
          },
          {
            key: 'memory',
            label: 'Memory',
            value: '3.0',
            rest: '/ 8 GB',
            sub: '38 % used',
            spark: memory.slice(-120),
            color: 'violet',
          },
          {
            key: 'disk',
            label: 'Disk',
            value: '30',
            rest: '/ 40 GB',
            sub: '76 % · full in about 2 months',
            tone: 'warn',
            spark: disk.slice(-120),
            color: 'amber',
          },
          {
            key: 'database',
            label: 'Database',
            value: '6.0',
            rest: 'GB',
            sub: '+ 110 MB a day',
            spark: database.slice(-120),
            color: 'green',
          },
          {
            key: 'integrations',
            label: 'Integrations',
            value: '100',
            rest: 'of 102',
            sub: '2 not loading',
            tone: 'warn',
            meter: 100 / 102,
          },
        ],
      },
      {
        kind: 'chart',
        id: 'cpu',
        width: 'wide',
        place: 'chart',
        span: 1,
        title: 'CPU',
        timestamps: ts,
        figure: { value: '2 %', rest: 'of 4 cores' },
        stats: avgPeak('1.8 %', '4.6 %', 'Sun 04:05'),
        series: [
          { key: 'cpu', label: 'CPU', unit: '%', values: cpu, color: 'blue', fill: true, latest: '2 %' },
        ],
        axis: { min: 0, max: 10, unit: '%' },
        foot: [
          { label: 'homeassistant', value: '1.6 %' },
          { label: 'core-mariadb', value: '0.4 %' },
        ],
      },
      {
        kind: 'chart',
        id: 'memory',
        place: 'chart',
        span: 1,
        title: 'Memory',
        timestamps: ts,
        figure: { value: '3.0 GB', rest: 'of 8 GB' },
        stats: avgPeak('2.9 GB', '3.1 GB', 'Sun 09:40'),
        series: [
          {
            key: 'memory',
            label: 'Memory',
            unit: 'GB',
            values: memory,
            color: 'violet',
            fill: true,
            latest: '3.0 GB',
          },
        ],
        axis: { min: 0, max: 8, unit: 'GB' },
        foot: [
          { label: 'homeassistant', value: '2.2 GB' },
          { label: 'core-mariadb', value: '0.8 GB' },
        ],
      },
      {
        kind: 'chart',
        id: 'disk',
        place: 'chart',
        span: 1,
        title: 'Disk space',
        timestamps: ts,
        figure: { value: '76 %', rest: '30 of 40 GB', tone: 'warn' },
        stats: [[{ text: '+ ' }, { text: '3.6 GB', strong: true }, { text: ' in 30 days' }]],
        series: [
          {
            key: 'disk',
            label: 'Disk',
            unit: '%',
            values: disk,
            color: 'amber',
            fill: true,
            latest: '76 %',
          },
        ],
        axis: { min: 50, max: 100, unit: '%' },
        forecast: { at: iso(full), value: 100, label: `full ~${day(full)}` },
        foot: [
          { label: 'Old backups', value: '8.7 GB', tone: 'warn' },
          { label: 'Database', value: '6.0 GB' },
          { label: 'Full', value: `about ${day(full)}`, tone: 'warn' },
        ],
      },
      {
        kind: 'chart',
        id: 'errors',
        place: 'chart',
        span: 2,
        title: 'Errors in the log',
        timestamps: ts,
        style: 'bars',
        stats: [
          [{ text: 'Since the restart on Thu 07:12' }],
          [
            { text: '12,286', strong: true },
            { text: ' errors · about ' },
            { text: '510', strong: true },
            { text: ' an hour' },
          ],
        ],
        series: [
          { key: 'modbus', label: 'Modbus', values: top, color: 'orange', latest: '11,280' },
          { key: 'rest', label: 'Everything else', values: rest, color: 'grey', latest: '1,006' },
        ],
      },
      {
        kind: 'chart',
        id: 'database',
        place: 'chart',
        span: 1,
        title: 'Database',
        timestamps: ts,
        figure: { value: '6.0 GB', rest: 'recorder' },
        stats: [[{ text: '+ ' }, { text: '3.3 GB', strong: true }, { text: ' in 30 days' }]],
        series: [
          {
            key: 'db',
            label: 'Database',
            unit: 'GB',
            values: database,
            color: 'green',
            fill: true,
            latest: '6.0 GB',
          },
        ],
        axis: { min: 0, max: 8, unit: 'GB' },
        foot: [
          { label: 'Keeps', value: '10 days' },
          { label: 'Biggest', value: 'sensor.evcs_*' },
        ],
      },
    ];
  }

  function homeAssistant(range: HostSeriesRange): ThingPage {
    const restarted = restartedAt ? 'just now' : '3 d 4 h';
    const integrations: [string, string, 'ok' | 'warn' | 'bad', string?][] = [
      ['Shelly · Pool pump', 'Retrying', 'warn', 'cannot reach 10.100.0.87 since Thu 07:12'],
      ['Shelly · Garage door', 'Retrying', 'warn', 'cannot reach 10.100.0.91 since Thu 07:12'],
      ['KNX', 'Loaded', 'ok'],
      ['MQTT', 'Loaded', 'ok'],
      ['ESPHome', 'Loaded', 'ok'],
      ['UniFi Network', 'Loaded', 'ok'],
      ['Mobile app', 'Loaded', 'ok'],
      ['Met.no', 'Loaded', 'ok'],
    ];
    const ask = (question: string) => ({ kind: 'ask' as const, label: 'Look into it', question });
    return {
      id: 'connection:con_ha',
      kind: 'connection',
      connectionId: 'con_ha',
      catalogId: 'homeassistant',
      name: 'Home Assistant',
      icon: 'home',
      status: 'warn',
      badge: 'Needs a look',
      facts: [
        [{ text: 'Home Assistant ' }, { text: '2026.10.2', strong: true }, { text: ' · Docker' }],
        [{ text: 'MariaDB ' }, { text: '10.11', strong: true }],
        [{ text: restartedAt ? 'Restarted ' : 'Up ' }, { text: restarted, strong: true }],
      ],
      address: '10.100.0.131:8123',
      open: { label: 'Open Home Assistant', url: 'http://10.100.0.131:8123/' },
      runsOn: {
        serverId: 'pve-02',
        guestId: 'pve:132',
        name: 'homeassistant (pve-02)',
        href: '/things/server%3Apve-02?guest=pve%3A132',
        how: 'address',
      },
      settings: true,
      ...ranged(range),
      tabs: [
        summary([
          // In slots, as a real Whombat's (Whombat service-slots.md): the Controls live beside what it has, the
          // cameras, the week's automation runs, who's home and the machine; its own panels below them.
          ...homeAssistantSlotPanels({
            now: now().getTime(),
            controls: services.homeAssistantControls(),
            machine: { name: 'homeassistant (pve-02)', href: '/things/server%3Apve-02?guest=pve%3A132' },
          }),
          {
            kind: 'table',
            id: 'not-loading',
            width: 'wide',
            place: 'main',
            title: 'Integrations not loading',
            meta: '2 of 102',
            link: { kind: 'tab', label: 'All integrations', tab: 'integrations' },
            columns: [
              { key: 'name', label: 'Integration' },
              { key: 'state', label: 'State' },
            ],
            rows: integrations
              .filter(([, , tone]) => tone !== 'ok')
              .map(([name, state, tone, note]) => ({
                id: name.toLowerCase().replace(/\W+/g, '-'),
                cells: {
                  name: { text: name, dot: tone },
                  state: { text: state, tone, ...(note ? { note } : {}) },
                },
              })),
          },
          {
            kind: 'list',
            id: 'backups',
            width: 'wide',
            place: 'main',
            title: 'Backups',
            link: { kind: 'tab', label: 'Backups', tab: 'backups' },
            items: [
              {
                id: 'pbs',
                title: 'Proxmox backs up CT 132 every day',
                detail: 'backup-homeassistant-daytime · today 07:30 · 4.2 GB',
                right: 'next in 21 h',
                tone: 'ok',
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
            {
              id: 'disk',
              tone: 'warn',
              icon: 'disk',
              title: 'Disk full in about 2 months',
              detail: '8.7 GB is old backups',
              link: ask('Why is Home Assistant’s disk filling up, and what can go?'),
            },
            {
              id: 'modbus',
              tone: 'warn',
              icon: 'log',
              title: 'Modbus fills the log',
              detail: '92 % of 12,286 errors, still coming in',
              link: { kind: 'tab', label: 'Show them', tab: 'logs' },
            },
            {
              id: 'integrations',
              tone: 'warn',
              icon: 'plug',
              title: '2 integrations not loading',
              detail: 'Shelly pool pump, garage door',
              link: ask('Why are two Shelly integrations not loading in Home Assistant?'),
            },
            {
              id: 'homewizard',
              tone: 'warn',
              icon: 'key',
              title: '3 HomeWizard meters need a new sign-in',
              detail: 'Zwembad Techniek, Schuilstal, WTW Zolder',
              link: { kind: 'url', label: 'Repair', url: 'http://10.100.0.131:8123/config/repairs' },
            },
            {
              id: 'update',
              tone: 'info',
              icon: 'update',
              title: 'Home Assistant has an update',
              detail: 'Two fixes for Modbus',
              link: ask('Should I update Home Assistant to 2026.10.3?'),
            },
            {
              id: 'recorder',
              tone: 'info',
              icon: 'database',
              title: 'The database grows 110 MB a day',
              detail: 'sensor.evcs_* writes every second',
              link: ask('Why does Home Assistant’s database grow so fast?'),
            },
            {
              id: 'battery',
              tone: 'info',
              icon: 'battery',
              title: '2 sensors have a low battery',
              detail: 'Hallway motion, Back door',
            },
            {
              id: 'backup-age',
              tone: 'info',
              icon: 'backup',
              title: 'Its own backups are 7 months old',
              detail: 'Proxmox backs up the whole machine instead',
            },
            {
              id: 'clock',
              tone: 'info',
              icon: 'clock',
              title: 'An automation ran 212 times today',
              detail: 'Garden lights at dusk',
              link: ask('Why did “Garden lights at dusk” run 212 times today?'),
            },
          ]),
          changesPanel(),
          access([
            { label: 'Read', tier: 'allowed', count: 4 },
            { label: 'Lights and switches', tier: 'allowed', count: 6 },
            { label: 'Locks and alarms', tier: 'ask', count: 5 },
          ]),
          widgets(['Errors per hour', 'Restarts this month']),
        ]),
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
                { key: 'state', label: 'State' },
              ],
              rows: integrations.map(([name, state, tone, note]) => ({
                id: name.toLowerCase().replace(/\W+/g, '-'),
                cells: {
                  name: { text: name },
                  state: {
                    text: state,
                    dot: tone,
                    tone: tone === 'ok' ? 'muted' : tone,
                    ...(note ? { note } : {}),
                  },
                },
              })),
            },
          ],
        },
        {
          key: 'logs',
          label: 'Log',
          panels: [
            {
              kind: 'list',
              id: 'errors',
              title: 'Errors and warnings today',
              meta: '12,286 errors since the restart',
              items: [
                {
                  id: 'modbus',
                  title: 'modbus: Pymodbus: No response received after 3 retries',
                  detail: 'Since Thu 07:12, every few seconds',
                  at: ago(0.1 * HOUR),
                  tone: 'bad',
                  icon: 'log',
                  right: '×11,280',
                },
                {
                  id: 'shelly',
                  title: 'shelly: Retrying setup in 80 seconds',
                  at: ago(0.2 * HOUR),
                  tone: 'warn',
                  icon: 'log',
                  right: '×412',
                },
                {
                  id: 'homewizard',
                  title: 'homewizard: The meter asks for a new sign-in',
                  at: ago(2.2 * HOUR),
                  tone: 'warn',
                  icon: 'log',
                  right: '×3',
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
              id: 'backups',
              title: 'Backups',
              items: [
                {
                  id: 'pbs-today',
                  title: 'Whole machine, by Proxmox',
                  detail: 'Every day at 07:30 · keeps 14 days · 4.2 GB',
                  at: ago(6.6 * HOUR),
                  tone: 'ok',
                  icon: 'backup',
                },
                {
                  id: 'pbs-yesterday',
                  title: 'Whole machine, by Proxmox',
                  detail: '4.2 GB',
                  at: ago(30.6 * HOUR),
                  tone: 'ok',
                  icon: 'backup',
                },
                {
                  id: 'old',
                  title: 'Home Assistant’s own backups',
                  detail: '23 files · 8.7 GB · oldest from March',
                  right: '17 Mar',
                  tone: 'warn',
                  icon: 'backup',
                },
              ],
            },
          ],
        },
      ],
      actions: [
        {
          id: 'restart',
          label: 'Restart',
          icon: 'restart',
          confirm: {
            title: 'Restart Home Assistant?',
            body: 'It’s gone for about a minute. Automations wait until it’s back.',
            button: 'Restart',
          },
          allowed: true,
        },
      ],
      readAt: now().toISOString(),
    };
  }

  /* UniFi (DS-13) ------------------------------------------------------------------------------------------------- */

  function unifi(range: HostSeriesRange): ThingPage {
    const ts = timestamps(range);
    const n = ts.length;
    const down = wave(n, 120, 60, 2);
    const up = wave(n, 18, 8, 7);
    const clients = wave(n, 170, 12, 4).map(Math.round);
    const gwCpu = wave(n, 12, 4, 6);
    const gwMem = wave(n, 54, 2, 8);
    const devices: [string, string, 'ok' | 'off', string, string][] = [
      ['Gateway', 'UniFi Dream Machine Pro', 'ok', '10.100.0.1', '4.1.13'],
      ['Switch rack', 'USW Pro 24 PoE', 'ok', '10.100.0.2', '7.1.26'],
      ['AP Living room', 'U7 Pro', 'ok', '10.100.0.21', '8.0.24'],
      ['AP Garage', 'U6 Lite', 'off', '10.100.0.34', '6.6.77'],
    ];
    const devicesTable = (place?: 'main'): ThingPagePanel => ({
      kind: 'table',
      id: 'devices',
      title: 'Devices',
      ...(place
        ? { place, width: 'wide' as const, link: { kind: 'tab', label: 'All devices', tab: 'devices' } }
        : {}),
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'model', label: 'Model' },
        { key: 'state', label: 'State' },
        { key: 'address', label: 'Address' },
        { key: 'firmware', label: 'Firmware', numeric: true },
      ],
      rows: devices.map(([name, model, dot, address, firmware]) => ({
        id: address,
        cells: {
          name: { text: name },
          model: { text: model },
          state: {
            text: dot === 'ok' ? 'Online' : 'Offline',
            dot,
            tone: dot === 'ok' ? 'muted' : 'warn',
          },
          address: { text: address, mono: true },
          firmware: { text: firmware, mono: true },
        },
      })),
    });
    return {
      id: 'connection:con_unifi',
      kind: 'connection',
      connectionId: 'con_unifi',
      catalogId: 'unifi',
      name: 'UniFi',
      icon: 'wifi',
      status: 'warn',
      badge: '1 access point offline',
      facts: [[{ text: 'UniFi Network ' }, { text: '9.4.19', strong: true }]],
      address: '10.100.0.1',
      open: { label: 'Open UniFi', url: 'https://10.100.0.1/' },
      runsOn: null,
      settings: true,
      ...ranged(range),
      tabs: [
        summary([
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
                sub: 'AP Garage offline',
                tone: 'warn',
                meter: 44 / 45,
              },
              { key: 'clients', label: 'Clients', value: '174', spark: clients.slice(-120), color: 'blue' },
              { key: 'internet', label: 'Internet now', value: '96', rest: '/ 14 Mb/s', sub: 'down / up' },
              {
                key: 'gateway',
                label: 'Gateway CPU',
                value: '12 %',
                sub: 'up 41 days',
                spark: gwCpu.slice(-120),
                color: 'blue',
              },
            ],
          },
          {
            kind: 'chart',
            id: 'internet',
            width: 'wide',
            place: 'chart',
            span: 2,
            title: 'Internet',
            timestamps: ts,
            stats: [[{ text: 'Peak down ' }, { text: '412 Mb/s', strong: true }, { text: ' Sun 03:05' }]],
            series: [
              { key: 'down', label: 'Down', unit: 'Mb/s', values: down, color: 'green', latest: '96 Mb/s' },
              { key: 'up', label: 'Up', unit: 'Mb/s', values: up, color: 'orange', latest: '14 Mb/s' },
            ],
          },
          {
            kind: 'chart',
            id: 'gateway',
            place: 'chart',
            span: 1,
            title: 'Gateway',
            timestamps: ts,
            figure: { value: '12 %', rest: 'CPU' },
            stats: avgPeak('11 %', '31 %', 'Sun 03:05'),
            series: [
              {
                key: 'cpu',
                label: 'CPU',
                unit: '%',
                values: gwCpu,
                color: 'blue',
                fill: true,
                latest: '12 %',
              },
              { key: 'mem', label: 'Memory', unit: '%', values: gwMem, color: 'violet', latest: '54 %' },
            ],
            axis: { min: 0, max: 100, unit: '%' },
          },
          devicesTable('main'),
          looks([
            {
              id: 'ap-garage',
              tone: 'warn',
              icon: 'network',
              title: 'AP Garage is offline',
              detail: 'Since 11:20 today',
              link: { kind: 'ask', label: 'Look into it', question: 'Why is AP Garage offline in UniFi?' },
            },
            {
              id: 'firmware',
              tone: 'info',
              icon: 'update',
              title: 'Firmware updates for 3 devices',
              link: { kind: 'tab', label: 'Show them', tab: 'devices' },
            },
          ]),
          changesPanel(),
          access([{ label: 'Read', tier: 'allowed', count: 3 }]),
          widgets(['Clients over the day']),
        ]),
        { key: 'devices', label: 'Devices', count: 45, panels: [devicesTable()] },
      ],
      actions: [],
      readAt: now().toISOString(),
    };
  }

  /* Hetzner (DS-12, hetzner.png) ---------------------------------------------------------------------------------- */

  function hetzner(range: HostSeriesRange): ThingPage {
    const ts = timestamps(range);
    const n = ts.length;
    const cpu = wave(n, 5, 1.5, 4);
    const netIn = wave(n, 2.1, 0.6, 3);
    const netOut = wave(n, 3.4, 0.9, 8);
    const read = wave(n, 0.2, 0.1, 5);
    const write = wave(n, 1.1, 0.3, 2);
    return {
      id: 'connection:con_hetzner',
      kind: 'connection',
      connectionId: 'con_hetzner',
      catalogId: 'hetzner',
      name: 'Hetzner Cloud',
      icon: 'cloud',
      status: 'ok',
      badge: 'All running',
      facts: [[{ text: '1 server' }], [{ text: 'Falkenstein' }]],
      address: 'Project Whombat',
      open: { label: 'Open in Hetzner', url: 'https://console.hetzner.cloud/' },
      runsOn: null,
      settings: true,
      ...ranged(range),
      tabs: [
        summary([
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
                spark: cpu.slice(-120),
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
              { key: 'cost', label: 'Cost', value: '€15', rest: 'a month', sub: 'server, IPv4, backups off' },
            ],
          },
          {
            kind: 'chart',
            id: 'cpu',
            place: 'chart',
            span: 1,
            title: 'CPU',
            timestamps: ts,
            figure: { value: '7 %', rest: 'whombat-prod' },
            stats: avgPeak('5.1 %', '38 %', 'Sun 02:00'),
            series: [
              { key: 'cpu', label: 'CPU', unit: '%', values: cpu, color: 'blue', fill: true, latest: '7 %' },
            ],
            axis: { min: 0, max: 100, unit: '%' },
          },
          {
            kind: 'chart',
            id: 'network',
            place: 'chart',
            span: 1,
            title: 'Network',
            timestamps: ts,
            series: [
              {
                key: 'in',
                label: 'In',
                unit: 'Mb/s',
                values: netIn,
                color: 'green',
                fill: true,
                latest: '2.1 Mb/s',
              },
              { key: 'out', label: 'Out', unit: 'Mb/s', values: netOut, color: 'orange', latest: '3.4 Mb/s' },
            ],
          },
          {
            kind: 'chart',
            id: 'disk',
            place: 'chart',
            span: 1,
            title: 'Disk I/O',
            timestamps: ts,
            series: [
              { key: 'read', label: 'Read', unit: 'MB/s', values: read, color: 'blue', latest: '0.2 MB/s' },
              {
                key: 'write',
                label: 'Write',
                unit: 'MB/s',
                values: write,
                color: 'violet',
                latest: '1.1 MB/s',
              },
            ],
          },
          {
            kind: 'table',
            id: 'servers',
            width: 'wide',
            place: 'main',
            title: 'Servers',
            columns: [
              { key: 'name', label: 'Server' },
              { key: 'type', label: 'Type' },
              { key: 'cpu', label: 'CPU', numeric: true },
              { key: 'day', label: '24 h' },
              { key: 'address', label: 'Address', numeric: true },
              { key: 'open', label: '' },
            ],
            rows: [
              {
                id: 'whombat-prod',
                cells: {
                  name: { text: 'whombat-prod', mono: true, dot: 'ok', note: 'Debian 13 · Falkenstein' },
                  type: { text: 'CX32', note: '4 vCPU · 8 GB · 80 GB' },
                  cpu: { text: '7 %', mono: true, meter: 0.07 },
                  day: { text: '', spark: cpu.slice(-120) },
                  address: { text: '203.0.113.44', mono: true },
                  open: { text: 'Open', button: true, href: '/things/server%3Apve-01' },
                },
              },
            ],
          },
          {
            kind: 'text',
            id: 'add-server',
            width: 'wide',
            place: 'main',
            body: 'Hetzner can’t see memory or disk space. Add whombat-prod as a server to see them here.',
            link: { kind: 'href', label: 'Add as a server', href: '/things/servers?add=1' },
          },
          looks([
            {
              id: 'backups',
              tone: 'warn',
              icon: 'backup',
              title: 'whombat-prod has no backups',
              detail: 'Hetzner backups are off · 20 % of the server price',
              link: {
                kind: 'ask',
                label: 'Turn on…',
                question: 'Should whombat-prod have Hetzner backups on?',
              },
            },
            {
              id: 'protection',
              tone: 'info',
              icon: 'key',
              title: 'Delete protection is off',
              detail: 'Anyone with the API token can delete it',
              link: {
                kind: 'ask',
                label: 'Turn on',
                question: 'Turn on delete protection for whombat-prod?',
              },
            },
          ]),
          changesPanel(),
          access([{ label: 'Read', tier: 'allowed', count: 2 }]),
          widgets(['Cost this month', 'Traffic used']),
        ]),
      ],
      actions: [],
      readAt: now().toISOString(),
    };
  }

  /* Mail: the generic Summary (DS-14) ----------------------------------------------------------------------------- */

  function mail(range: HostSeriesRange): ThingPage {
    const ts = timestamps(range);
    const rtt = wave(ts.length, 210, 40, 4);
    return {
      id: 'connection:con_mail',
      kind: 'connection',
      connectionId: 'con_mail',
      catalogId: 'google_mail',
      name: 'Mail',
      icon: 'mail',
      status: 'ok',
      badge: 'Running fine',
      facts: [[{ text: 'Gmail · ' }, { text: 'mara@lumio.example', mono: true }]],
      address: 'mara@lumio.example',
      open: { label: 'Open Gmail', url: 'https://mail.google.com/' },
      runsOn: null,
      settings: true,
      ...ranged(range),
      tabs: [
        summary([
          {
            kind: 'kpis',
            id: 'figures',
            place: 'top',
            items: [
              { key: 'status', label: 'Status', value: 'Working', tone: 'ok' },
              { key: 'rtt', label: 'Response time', value: '212 ms', spark: rtt.slice(-120), color: 'blue' },
              { key: 'used', label: 'Last used', value: '14:00' },
              { key: 'problems', label: 'Problems', value: '0', sub: 'in 24 h' },
            ],
          },
          {
            kind: 'chart',
            id: 'rtt',
            width: 'wide',
            place: 'chart',
            span: 2,
            title: 'Response time',
            timestamps: ts,
            figure: { value: '212 ms' },
            stats: avgPeak('208 ms', '334 ms', 'Sun 09:15'),
            series: [
              { key: 'rtt', label: 'Response time', unit: 'ms', values: rtt, color: 'blue', fill: true },
            ],
          },
          looks([]),
          changesPanel(),
          access([{ label: 'Read', tier: 'allowed', count: 1 }]),
        ]),
      ],
      actions: [],
      readAt: now().toISOString(),
    };
  }

  /* The heat pump (CP-13, DS-14) ---------------------------------------------------------------------------------- */

  function heatPump(range: HostSeriesRange): ThingPage {
    const base = {
      id: 'device:con_heatpump',
      kind: 'device' as const,
      name: 'Heat pump',
      icon: 'thermometer',
      runsOn: null,
      actions: [],
    };
    if (!options.heatOn())
      return {
        ...base,
        proposalId: 'dvp_heatpump',
        status: 'learning',
        badge: 'Learning',
        facts: [[{ text: 'Daikin Altherma · ' }, { text: '10.100.0.61', mono: true }]],
        settings: false,
        tabs: [
          summary([
            {
              kind: 'text',
              id: 'learning',
              title: `${named()} is learning it`,
              body: `${named()} found a Daikin Altherma and tested reading its temperatures. Switch it on in the chat to keep it here.`,
              link: { kind: 'href', label: 'Open the chat', href: options.heatChatHref },
            },
            {
              kind: 'facts',
              id: 'found',
              title: 'What it found',
              items: [
                { label: 'Model', value: 'Daikin Altherma 3' },
                { label: 'Address', value: '10.100.0.61', mono: true },
                { label: 'Tested', value: 'Room, water to radiators, mode' },
              ],
            },
          ]),
        ],
        readAt: null,
      };
    const ts = timestamps(range);
    const room = wave(ts.length, 21, 0.4, 1);
    const water = wave(ts.length, 34, 3, 6);
    return {
      ...base,
      connectionId: 'con_heatpump',
      catalogId: 'device',
      status: 'ok',
      badge: 'Running fine',
      facts: [[{ text: 'Daikin Altherma · read ' }, { text: '1 min', strong: true }, { text: ' ago' }]],
      address: '10.100.0.61',
      settings: true,
      ...ranged(range),
      tabs: [
        summary([
          {
            kind: 'kpis',
            id: 'readings',
            place: 'top',
            items: [
              { key: 'room', label: 'Room', value: '21.0 °C', spark: room.slice(-120), color: 'amber' },
              {
                key: 'water',
                label: 'Water to radiators',
                value: '34 °C',
                spark: water.slice(-120),
                color: 'blue',
              },
              { key: 'mode', label: 'Mode', value: 'Heating' },
            ],
          },
          {
            kind: 'chart',
            id: 'room',
            place: 'chart',
            span: 1,
            title: 'Room',
            timestamps: ts,
            figure: { value: '21.0 °C' },
            stats: avgPeak('20.9 °C', '21.6 °C', 'Sun 18:40'),
            series: [
              { key: 'room', label: 'Room', unit: '°C', values: room, color: 'amber', latest: '21.0 °C' },
            ],
          },
          {
            kind: 'chart',
            id: 'water',
            place: 'chart',
            span: 1,
            title: 'Water to radiators',
            timestamps: ts,
            figure: { value: '34 °C' },
            stats: avgPeak('33 °C', '42 °C', 'Sun 06:30'),
            series: [
              {
                key: 'water',
                label: 'Water to radiators',
                unit: '°C',
                values: water,
                color: 'blue',
                latest: '34 °C',
              },
            ],
          },
          {
            kind: 'table',
            id: 'all',
            width: 'wide',
            place: 'main',
            title: 'All readings',
            columns: [
              { key: 'name', label: 'Reading' },
              { key: 'value', label: 'Value', numeric: true },
            ],
            rows: [
              { id: 'room', cells: { name: { text: 'Room' }, value: { text: '21.0 °C', mono: true } } },
              {
                id: 'water',
                cells: { name: { text: 'Water to radiators' }, value: { text: '34 °C', mono: true } },
              },
              { id: 'outside', cells: { name: { text: 'Outside' }, value: { text: '9.5 °C', mono: true } } },
              { id: 'mode', cells: { name: { text: 'Mode' }, value: { text: 'Heating' } } },
            ],
          },
          looks([]),
          changesPanel(),
          access([
            { label: 'Read', tier: 'allowed', count: 1 },
            { label: 'Change the temperature', tier: 'ask', count: 1 },
          ]),
        ]),
      ],
      readAt: ago(60_000),
    };
  }

  /* Lists ----------------------------------------------------------------------------------------------------------- */

  function changesFor(thing: string): ChangeEntry[] {
    const base: ChangeEntry[] =
      thing === 'connection:con_ha'
        ? [
            {
              id: 'chg_ha-shelly',
              title: 'Reloaded the Shelly integration',
              detail: 'It kept retrying since 03:12.',
              at: ago(5.8 * HOUR),
              actor: whombat(),
              undo: { state: 'none' },
              thingId: thing,
            },
            {
              id: 'chg_ha-backups',
              title: 'Removed 3 old backups',
              detail: 'They used 5.2 GB on the same disk.',
              at: ago(26 * HOUR),
              actor: whombat(),
              undo: { state: 'none' },
              thingId: thing,
            },
            {
              id: 'chg_ha-automation',
              title: 'Paused the “Garden lights at dusk” automation',
              at: ago(1.5 * HOUR),
              actor: whombat(),
              undo: { state: 'available', until: ago(-22.5 * HOUR) },
              thingId: thing,
            },
          ]
        : [];
    const settings = thing === SERVICE_THINGS.plex ? plexSettings.changes() : [];
    return [...extraChanges.filter((c) => c.thingId === thing), ...settings, ...base].sort((a, b) =>
      b.at.localeCompare(a.at),
    );
  }

  function widgetsFor(thing: string): Widget[] {
    if (thing !== 'connection:con_ha' || removedWidgets.has('wdg_ha-db')) return [];
    const ts = timestamps('24h');
    const sizes = ts.map((_, i) => Math.round((5.8 + (i / (ts.length - 1)) * 0.2) * 100) / 100);
    return [
      {
        id: 'wdg_ha-db',
        title: 'Database size',
        subtitle: 'MariaDB',
        kind: 'line',
        series: [{ key: 'size', label: 'Size', unit: 'GB', color: 1 }],
        latest: [{ key: 'size', value: sizes.at(-1) ?? null, unit: 'GB' }],
        points: ts.map((t, i) => ({ t, values: { size: sizes[i] ?? null } })),
        refreshSec: 3600,
        updatedAt: ago(12 * 60_000),
        thingId: thing,
      },
    ];
  }

  /** Home Assistant's page with its Controls live (in its slots), read again every 10 s while open (SD-30). */
  function withControls(p: ThingPage): ThingPage {
    return { ...p, refreshS: 10 };
  }

  /** A thing's page over `range` (one it doesn't offer gives 24 hours, CT-397). */
  function page(thing: string, asked: string | null = null): ThingPage | null {
    const range = (RANGES as string[]).includes(asked ?? '') ? (asked as HostSeriesRange) : '24h';
    if (SERVICES.includes(thing)) {
      const found = services.page(thing);
      return found && thing === SERVICE_THINGS.plex ? plexSettings.page(found) : found;
    }
    switch (thing) {
      case HOME_ASSISTANT:
        return withControls(homeAssistant(range));
      case 'connection:con_unifi':
        return unifi(range);
      case 'connection:con_hetzner':
        return hetzner(range);
      case 'connection:con_mail':
        return mail(range);
      case 'device:con_heatpump':
        return heatPump(range);
      default:
        return null;
    }
  }

  return {
    page,
    dashboardSample,
    /** The service pages' rows for Home and the Connections tab (Plex, Seerr, SABnzbd, Protect, Pi-hole). */
    serviceThings: () => services.things(),
    /** The answer for a request about the pages, or null (the rest of the world answers). */
    async handle(
      id: string,
      params: Record<string, string>,
      init: RequestInit | undefined,
      url: URL,
    ): Promise<Response | null> {
      switch (id) {
        case 'things.page': {
          const found = page(params.thing ?? '', url.searchParams.get('range'));
          return found ? json(found) : notFound('Nothing here by that name.');
        }
        case 'things.action': {
          const thing = params.thing ?? '';
          const body = await bodyOf<ThingActionBody>(init);
          const { action } = body;
          const setting = thing === SERVICE_THINGS.plex ? plexSettings.action(body) : null;
          if (setting) return json(setting.body, setting.status);
          // The service pages' buttons and Home Assistant's Controls (AP-4660): their own answers, refusals included.
          if (SERVICES.includes(thing) || (thing === HOME_ASSISTANT && action !== 'restart')) {
            const answer = services.action(thing, body);
            return answer ? json(answer.body, answer.status) : notFound('No such action.');
          }
          if (thing !== HOME_ASSISTANT || action !== 'restart') return notFound('No such action.');
          restartedAt = now().getTime();
          const change: ChangeEntry = {
            id: `chg_ha-restart-${extraChanges.length + 1}`,
            title: 'Restarted Home Assistant',
            at: now().toISOString(),
            actor: { kind: 'person', id: mara.id, name: mara.name },
            undo: { state: 'none' },
            thingId: thing,
          };
          extraChanges.unshift(change);
          return json(
            { message: 'Restarting Home Assistant. It’s back in about a minute.', changeId: change.id },
            202,
          );
        }
        // Quiet notices on the service pages (contracts 0.122; quiet-notices-mobile.md AP-4870): Ignore, Remind me
        // tomorrow and Undo on a line, What Whombat watches and its switches, as `@whombat/fixtures` keeps them.
        case 'things.quiet': {
          const answer = services.quiet(params.thing ?? '', await bodyOf<QuietNoticeBody>(init));
          return answer ? json(answer.body, answer.status) : null;
        }
        case 'things.watch': {
          const watch = services.watch(params.thing ?? '');
          return watch ? json(watch) : null;
        }
        case 'things.setWatch': {
          const answer = services.setWatch(params.thing ?? '', await bodyOf<SetThingWatchBody>(init));
          return answer ? json(answer.body, answer.status) : null;
        }
        case 'changes.undo': {
          const answer = plexSettings.undo(params.changeId ?? '');
          return answer ? json(answer.body, answer.status) : null;
        }
        case 'changes.list': {
          const thing = url.searchParams.get('thing');
          if (!thing) return null;
          const limit = Number(url.searchParams.get('limit') ?? 20) || 20;
          const before = url.searchParams.get('before');
          const all = changesFor(thing);
          const start = before ? all.findIndex((c) => c.id === before) + 1 : 0;
          const changes = all.slice(start, start + limit);
          const more = start + limit < all.length;
          return json({ changes, before: more ? (changes.at(-1)?.id ?? null) : null });
        }
        case 'widgets.list': {
          const thing = url.searchParams.get('thing');
          return thing ? json({ widgets: widgetsFor(thing) }) : null;
        }
        case 'widgets.remove': {
          if (params.widgetId !== 'wdg_ha-db') return null;
          removedWidgets.add('wdg_ha-db');
          return json({ widgets: [] });
        }
        default:
          return null;
      }
    },
  };
}
