/**
 * Fixture pages of the first group: UniFi Network, Hetzner Cloud and Fusebox, their Summary in slots as the server
 * builds it (`apps/server/src/things/kinds/unifi.ts`, `hetzner.ts`, `fusebox.ts`). Each entry shows in the web's and
 * the phone's fixture mode at `/things/<thing>` and in the sidebar; its shape and an example are in `types.ts`. UniFi
 * and Hetzner replace the pages the web's world drew before (`connection:con_unifi`, `connection:con_hetzner`).
 */
import type {
  NoticeIgnore,
  NoticeNature,
  NoticeSubject,
  ThingGalleryItem,
  ThingLine,
  ThingPage,
  ThingPageItem,
  ThingPageNotice,
  ThingPagePanel,
  ThingPageRow,
  ThingWatchCheck,
} from '@whombat/core/domain';
import { thingHref } from '@whombat/core/domain';
import type { FixtureServiceCtx, FixtureServicePage } from './types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const DAY_WORDS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type Check = Omit<ThingWatchCheck, 'on' | 'off' | 'exceptions'>;

/** The page's head as the server sends it, without its tabs. */
function head(
  ctx: FixtureServiceCtx,
  p: {
    thing: `connection:${string}`;
    catalogId: string;
    name: string;
    status: ThingPage['status'];
    badge: string;
    facts: ThingLine[];
    address?: string;
    open: { label: string; url: string };
    runsOn?: ThingPage['runsOn'];
  },
): Omit<ThingPage, 'tabs'> {
  return {
    id: p.thing,
    kind: 'connection',
    connectionId: p.thing.slice('connection:'.length) as ThingPage['connectionId'],
    catalogId: p.catalogId,
    name: p.name,
    icon: p.catalogId,
    status: p.status,
    badge: p.badge,
    facts: p.facts,
    ...(p.address ? { address: p.address } : {}),
    open: p.open,
    runsOn: p.runsOn ?? null,
    settings: true,
    actions: [],
    readAt: ctx.ago(4_000),
  };
}

/** A Worth a look line with its kind, check, item and Ignore; no Ignore on Look only. */
function notice(
  ctx: FixtureServiceCtx,
  n: ThingPageNotice,
  nature: NoticeNature,
  check: string,
  ignore: NoticeIgnore,
  subject?: NoticeSubject,
): ThingPageNotice {
  return { ...n, nature, check, ...(subject ? { subject } : {}), ...(ctx.lookOnly ? {} : { ignore }) };
}

const strip = (items: ThingPageNotice[]): ThingPagePanel[] =>
  items.length ? [{ kind: 'notices', id: 'notices', place: 'top', title: 'Worth a look', items }] : [];

/** A line of counts (Inventory) or of a live list: its figure large on the right with what changed under it. */
function count(
  id: string,
  title: string,
  value: string,
  more: Omit<ThingPageItem, 'id' | 'title' | 'right' | 'figure'> & {
    note?: string;
    noteTone?: 'ok' | 'warn' | 'bad';
  } = {},
): ThingPageItem {
  const { note, noteTone, ...rest } = more;
  return {
    id,
    title,
    ...rest,
    right: value,
    figure: { value, ...(note ? { note } : {}), ...(noteTone ? { tone: noteTone } : {}) },
  };
}

/** The last seven days, today last: their times and the words under their bars. */
function week(now: number): { timestamps: string[]; labels: string[] } {
  const days = Array.from({ length: 7 }, (_, i) => new Date(now - (6 - i) * DAY));
  return {
    timestamps: days.map((d) => d.toISOString()),
    labels: days.map((d, i) => (i === 6 ? 'Today' : (DAY_WORDS[d.getDay()] ?? ''))),
  };
}

/** `n` points `step` apart up to now, as a wave around `base`. */
function wave(now: number, n: number, step: number, base: number, swing: number, seed: number) {
  const timestamps = Array.from({ length: n }, (_, i) => new Date(now - (n - 1 - i) * step).toISOString());
  const values = timestamps.map((_, i) =>
    Math.max(
      0,
      Math.round((base + Math.sin(i / 5 + seed) * swing + (((i * seed) % 7) - 3) * (swing / 10)) * 10) / 10,
    ),
  );
  return { timestamps, values };
}

/* UniFi Network ----------------------------------------------------------------------------------------------------- */

const UNIFI = 'connection:con_unifi' as const;

const UNIFI_CHECKS: Check[] = [
  { check: 'unifi.gateway_offline', name: 'The gateway going offline', nature: 'problem', perItem: false },
  {
    check: 'unifi.device_offline',
    name: 'Access points and switches going offline',
    nature: 'problem',
    perItem: true,
  },
  { check: 'unifi.gateway_busy', name: 'A busy gateway', nature: 'problem', perItem: false },
  { check: 'unifi.firmware', name: 'Firmware updates', nature: 'fyi', perItem: false },
];

/** About how much came down the line per day, in GB (Whombat's readings), the oldest first. */
const UNIFI_WEEK_GB = [182, 164, 241, 205, 198, 276, 131];

function unifiPage(ctx: FixtureServiceCtx): ThingPage {
  const now = ctx.now();
  const devices: [string, string, 'ok' | 'bad', string, string, boolean][] = [
    ['AP Paardenstal', 'U6-Mesh', 'bad', '10.100.0.23', '8.0.24', false],
    ['UDM Pro Max', 'UDM-Pro-Max', 'ok', '10.100.0.1', '4.1.13', false],
    ['AP Bioscoop', 'U7-Pro', 'ok', '10.100.0.22', '8.0.24', false],
    ['AP Kantoor', 'U7-Pro', 'ok', '10.100.0.21', '8.0.19', true],
    ['AP Keuken', 'U7-Pro', 'ok', '10.100.0.24', '8.0.19', true],
    ['USW Lite 8 PoE', 'USW-Lite-8-PoE', 'ok', '10.100.0.4', '7.0.50', false],
    ['USW Pro Max 24', 'USW-Pro-Max-24', 'ok', '10.100.0.3', '7.0.50', false],
  ];
  const rows = Array.from({ length: 45 }, (_, i): ThingPageRow => {
    const [name, model, state, address, firmware, update] = devices[i] ?? [
      `AP ${String(i - 6).padStart(2, '0')}`,
      i % 3 ? 'U6-Lite' : 'U7-Pro',
      'ok',
      `10.100.0.${20 + i}`,
      i === 12 ? '8.0.19' : '8.0.24',
      i === 12,
    ];
    return {
      id: `dev-${i}`,
      cells: {
        name: { text: name },
        model: { text: model, mono: true },
        state: state === 'ok' ? { text: 'Online', dot: 'ok' } : { text: 'Offline', dot: 'bad' },
        address: { text: address, mono: true },
        firmware: {
          text: firmware,
          mono: true,
          ...(update ? { note: 'update', tone: 'warn' as const } : {}),
        },
      },
    };
  });
  const columns = [
    { key: 'name', label: 'Device' },
    { key: 'model', label: 'Model' },
    { key: 'state', label: 'State' },
    { key: 'address', label: 'Address' },
    { key: 'firmware', label: 'Firmware' },
  ];
  const days = week(now);
  const down = wave(now, 96, 15 * MIN, 92, 60, 3);
  const up = wave(now, 96, 15 * MIN, 14, 6, 5);
  const total = UNIFI_WEEK_GB.reduce((a, b) => a + b, 0);
  const notices = [
    notice(
      ctx,
      {
        id: 'offline-ap-paardenstal',
        tone: 'warn',
        icon: 'network',
        title: 'AP Paardenstal is offline',
        detail: 'Offline',
        link: { kind: 'ask', label: 'Look into it', question: 'Why is AP Paardenstal offline in UniFi?' },
      },
      'problem',
      'unifi.device_offline',
      { lifts: 'fixed', words: 'Until it’s back online.' },
      { id: 'device:dev-0', name: 'AP Paardenstal' },
    ),
    notice(
      ctx,
      {
        id: 'firmware',
        tone: 'info',
        icon: 'update',
        title: '3 devices have updates',
        detail: 'AP 06 and 2 more',
      },
      'fyi',
      'unifi.firmware',
      { lifts: 'newer', words: 'Until there’s newer firmware.' },
    ),
  ];
  return {
    ...head(ctx, {
      thing: UNIFI,
      catalogId: 'unifi_network',
      name: 'UniFi',
      status: 'warn',
      badge: 'AP Paardenstal is offline',
      facts: [
        [{ text: 'UniFi Network ' }, { text: '9.4.19', strong: true }],
        [{ text: 'Gateway up ' }, { text: '12 days', strong: true }],
      ],
      address: '10.100.0.100:11443',
      open: { label: 'Open UniFi', url: 'https://10.100.0.100:11443' },
      runsOn: {
        serverId: 'pve-02',
        guestId: 'pve:136',
        name: 'unifi (pve-02)',
        href: `${thingHref('server', 'pve-02')}?guest=pve%3A136`,
        how: 'address',
      },
    }),
    refreshS: 30,
    // The internet below the slots follows the range: the page offers the picker (the fixture draws the last day).
    range: '24h',
    ranges: ['1h', '6h', '24h', '7d', '30d'],
    tabs: [
      {
        key: 'overview',
        label: 'Summary',
        panels: [
          ...strip(notices),
          {
            kind: 'list',
            id: 'now',
            place: 'chart',
            span: 2,
            title: 'The network now',
            meta: 'Gateway up 12 days',
            items: [
              count('internet', 'Internet', '84 / 12 Mb/s', {
                icon: 'network',
                detail: 'Down · up now · busiest today 412 Mb/s',
                note: 'down · up now',
              }),
              count('clients', 'Connected now', '174', {
                icon: 'device',
                detail: 'Phones, laptops and more · most today 191',
                note: 'phones, laptops and more',
              }),
              count('online', 'Devices online', '44 of 45', {
                icon: 'network',
                tone: 'warn',
                detail: 'AP Paardenstal is offline',
                note: 'AP Paardenstal is offline',
                noteTone: 'warn',
              }),
              count('gateway', 'Gateway', '14 %', {
                icon: 'network',
                detail: 'UDM Pro Max busy now · memory 41 %',
                note: 'busy now',
              }),
            ],
          },
          {
            kind: 'list',
            id: 'equipment',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'On the network',
            meta: '45 devices',
            link: { kind: 'tab', label: 'All devices', tab: 'devices' },
            items: [
              count('access-points', 'Access points', '41', {
                icon: 'network',
                note: '1 offline',
                noteTone: 'warn',
              }),
              count('switches', 'Switches', '2', { icon: 'network', note: 'All online' }),
              count('gateway', 'Gateway', '1', {
                icon: 'network',
                detail: 'UDM-Pro-Max',
                note: 'All online',
              }),
              count('updates', 'Updates waiting', '3', {
                icon: 'update',
                detail: 'AP 06 and 2 more',
                note: 'Firmware to install',
                noteTone: 'warn',
              }),
            ],
          },
          {
            kind: 'chart',
            id: 'week',
            place: 'chart',
            span: 1,
            title: 'Internet this week',
            meta: 'About, from Whombat’s readings',
            style: 'bars',
            ...days,
            series: [
              { key: 'values', label: 'Downloaded', values: UNIFI_WEEK_GB, color: 'green', unit: 'GB' },
            ],
            figure: { value: `about ${(total / 1000).toFixed(1)} TB`, rest: 'down this week' },
            stats: [[{ text: '+6 %', strong: true }, { text: ' on last week' }]],
            axis: { min: 0 },
          },
          {
            kind: 'bars',
            id: 'machine',
            place: 'chart',
            span: 1,
            title: 'The machine',
            meta: 'unifi (pve-02)',
            link: {
              kind: 'href',
              label: 'See unifi (pve-02)',
              href: `${thingHref('server', 'pve-02')}?guest=pve%3A136`,
            },
            items: [
              { id: 'cpu', label: 'Processor', note: 'of 2 cores', value: '3 %', pct: 0.03 },
              { id: 'memory', label: 'Memory', value: '1.4 of 4 GB', pct: 0.35 },
              { id: 'disk', label: 'Disk', value: '9.8 of 32 GB', pct: 0.31 },
              { id: 'unifi-version', label: 'UniFi Network', value: '9.4.19', pct: null },
              {
                id: 'gateway-firmware',
                label: 'Gateway firmware',
                value: '4.1.13',
                mono: true,
                pct: null,
                sub: 'Up to date',
              },
              { id: 'gateway-up', label: 'Gateway up', value: '12 days', pct: null },
            ],
          },
          {
            kind: 'chart',
            id: 'internet',
            place: 'main',
            title: 'Internet',
            timestamps: down.timestamps,
            series: [
              {
                key: 'down',
                label: 'Down',
                unit: 'Mb/s',
                values: down.values,
                color: 'green',
                fill: true,
                latest: '84 Mb/s',
              },
              { key: 'up', label: 'Up', unit: 'Mb/s', values: up.values, color: 'orange', latest: '12 Mb/s' },
            ],
            figure: { value: '84 Mb/s', rest: 'down · 12 Mb/s up' },
            stats: [
              [{ text: 'Average ' }, { text: '92 Mb/s', strong: true }],
              [{ text: 'Peak ' }, { text: '412 Mb/s', strong: true }, { text: ' at 21:10' }],
            ],
            axis: { min: 0, unit: 'Mb/s' },
          },
          {
            kind: 'table',
            id: 'devices',
            place: 'main',
            title: 'Devices',
            meta: '1 offline',
            link: { kind: 'tab', label: 'All devices', tab: 'devices' },
            columns,
            rows: rows.slice(0, 10),
          },
        ],
      },
      {
        key: 'devices',
        label: 'Devices',
        count: rows.length,
        panels: [{ kind: 'table', id: 'devices', title: 'Devices', columns, rows }],
      },
    ],
  };
}

/* Hetzner Cloud ----------------------------------------------------------------------------------------------------- */

const HETZNER = 'connection:con_hetzner' as const;

const HETZNER_CHECKS: Check[] = [
  { check: 'hetzner.not_running', name: 'Servers not running', nature: 'problem', perItem: true },
  { check: 'hetzner.traffic', name: 'Traffic past what’s included', nature: 'problem', perItem: false },
  { check: 'hetzner.no_backups', name: 'Servers without Hetzner backups', nature: 'fyi', perItem: false },
  { check: 'hetzner.delete_protection', name: 'Delete protection off', nature: 'fyi', perItem: false },
];

/** About how much the servers sent per day, in GB (Hetzner's hourly readings), the oldest first. */
const HETZNER_WEEK_GB = [21.4, 18.9, 24.2, 30.6, 19.8, 16.1, 9.7];

function hetznerPage(ctx: FixtureServiceCtx): ThingPage {
  const now = ctx.now();
  const servers: [string, string, string, string, number, string, string][] = [
    ['whombat-prod', 'CPX31', '4 vCPU · 8 GB', 'Falkenstein', 0.18, '4.2 Mb/s in · 11 Mb/s out', '€ 16.18'],
    ['web-1', 'CX22', '2 vCPU · 4 GB', 'Nuremberg', 0.07, '2.1 Mb/s in · 3.4 Mb/s out', '€ 4.51'],
    ['mail-1', 'CX22', '2 vCPU · 4 GB', 'Helsinki', 0.03, '0.3 Mb/s in · 0.2 Mb/s out', '€ 4.51'],
  ];
  const days = week(now);
  const cpu = (seed: number, base: number) => wave(now, 96, 15 * MIN, base, base * 0.5, seed);
  const lines = [cpu(2, 18), cpu(4, 7), cpu(6, 3)];
  const net = [
    wave(now, 96, 15 * MIN, 15, 8, 3),
    wave(now, 96, 15 * MIN, 5, 3, 5),
    wave(now, 96, 15 * MIN, 1, 0.5, 7),
  ];
  const colors = ['blue', 'orange', 'green'] as const;
  const rows: ThingPageRow[] = servers.map(([name, type, size, city, , , cost], i) => ({
    id: `srv-${i}`,
    cells: {
      name: { text: name },
      state: { text: 'Running', dot: 'ok' },
      type: { text: type, mono: true, note: size },
      location: { text: city },
      address: { text: `49.12.1.${2 + i}`, mono: true },
      cost: { text: cost, mono: true },
    },
  }));
  return {
    ...head(ctx, {
      thing: HETZNER,
      catalogId: 'hetzner',
      name: 'Hetzner',
      status: 'ok',
      badge: 'All running',
      facts: [
        [{ text: '3', strong: true }, { text: ' servers' }],
        [{ text: 'Falkenstein · Nuremberg · Helsinki' }],
      ],
      open: { label: 'Open in Hetzner', url: 'https://console.hetzner.cloud/' },
    }),
    tabs: [
      {
        key: 'overview',
        label: 'Summary',
        panels: [
          ...strip([
            notice(
              ctx,
              {
                id: 'no-backups',
                tone: 'info',
                icon: 'backup',
                title: '2 servers have no backups',
                detail: 'web-1 and mail-1 · Hetzner’s backups are 20 % of the server price',
              },
              'fyi',
              'hetzner.no_backups',
              { lifts: 'newer', words: 'Until another server has none.' },
            ),
          ]),
          {
            kind: 'gallery',
            id: 'servers',
            place: 'chart',
            span: 2,
            look: 'rows',
            shape: 'square',
            title: 'Servers now',
            meta: 'All running · € 25.20 a month',
            items: servers.map(([name, type, size, city, load, traffic], i) => ({
              id: `srv-${i}`,
              title: name,
              sub: `${type} · ${size} · ${city}`,
              progress: load,
              note: `CPU ${Math.round(load * 100)} %`,
              noteEnd: traffic,
            })),
            empty: 'No servers in this project.',
          },
          {
            kind: 'list',
            id: 'project',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'In this project',
            link: { kind: 'tab', label: 'All servers', tab: 'servers' },
            items: [
              count('servers', 'Servers', '3', {
                icon: 'device',
                detail: '8 vCPU · 16 GB in all',
                note: '+1 this week',
                noteTone: 'ok',
              }),
              count('volumes', 'Volumes', '2', {
                icon: 'disk',
                detail: '150 GB in all',
                note: 'Nothing new',
              }),
              count('snapshots', 'Snapshots', '4', {
                icon: 'backup',
                detail: '38 GB in all',
                note: '+2 this week',
                noteTone: 'ok',
              }),
              count('traffic', 'Traffic this month', '0.4 TB', {
                icon: 'network',
                detail: 'Going out, all servers',
                note: '1 % of 60 TB',
              }),
              count('cost', 'Cost a month', '€ 25.20', { icon: 'money', note: 'servers, before traffic' }),
            ],
          },
          {
            kind: 'chart',
            id: 'week',
            place: 'chart',
            span: 1,
            title: 'Traffic out this week',
            meta: 'Sent per day, all servers',
            style: 'bars',
            ...days,
            series: [{ key: 'values', label: 'Sent', values: HETZNER_WEEK_GB, color: 'orange', unit: 'GB' }],
            figure: { value: 'about 141 GB', rest: 'out this week' },
            stats: [[{ text: '−8 %', strong: true }, { text: ' on last week' }]],
            axis: { min: 0 },
          },
          {
            kind: 'chart',
            id: 'cpu',
            place: 'main',
            title: 'CPU',
            timestamps: lines[0]?.timestamps ?? [],
            series: lines.map((l, i) => ({
              key: `s${i + 1}`,
              label: servers[i]?.[0] ?? '',
              unit: '%',
              values: l.values,
              color: colors[i] ?? 'grey',
              latest: `${Math.round((servers[i]?.[4] ?? 0) * 100)} %`,
            })),
            figure: { value: '9 %', rest: 'average' },
            axis: { min: 0, max: 100, unit: '%' },
          },
          {
            kind: 'chart',
            id: 'network',
            place: 'main',
            title: 'Network',
            meta: 'in and out',
            timestamps: net[0]?.timestamps ?? [],
            series: net.map((l, i) => ({
              key: `s${i + 1}`,
              label: servers[i]?.[0] ?? '',
              unit: 'Mb/s',
              values: l.values,
              color: colors[i] ?? 'grey',
            })),
            axis: { min: 0, unit: 'Mb/s' },
          },
          {
            kind: 'text',
            id: 'agent-note',
            place: 'main',
            body: 'Hetzner can’t see memory or disk space. Add whombat-prod, web-1 and 1 more as servers to see them here.',
            link: { kind: 'href', label: 'Add a server', href: '/things/servers?add=1' },
          },
        ],
      },
      {
        key: 'servers',
        label: 'Servers',
        count: rows.length,
        panels: [
          {
            kind: 'table',
            id: 'servers',
            title: 'Servers',
            columns: [
              { key: 'name', label: 'Server' },
              { key: 'state', label: 'State' },
              { key: 'type', label: 'Type' },
              { key: 'location', label: 'Location' },
              { key: 'address', label: 'Address' },
              { key: 'cost', label: 'A month', numeric: true },
            ],
            rows,
          },
        ],
      },
    ],
  };
}

/* Fusebox ------------------------------------------------------------------------------------------------------------ */

const FUSEBOX = 'connection:con_fusebox' as const;
const FUSEBOX_URL = 'http://10.100.0.235:8317';

const FUSEBOX_CHECKS: Check[] = [
  { check: 'fusebox.used_up', name: 'Claude or ChatGPT used up', nature: 'you', perItem: true },
  { check: 'fusebox.signin', name: 'Expired sign-ins', nature: 'you', perItem: true },
  { check: 'fusebox.credit', name: 'API keys out of credit', nature: 'you', perItem: true },
  { check: 'fusebox.week_runs_out', name: 'A week running out early', nature: 'fyi', perItem: true },
  { check: 'fusebox.failing', name: 'Failing requests', nature: 'problem', perItem: false },
  { check: 'fusebox.storage', name: 'Saving its usage history', nature: 'problem', perItem: false },
  { check: 'fusebox.fault', name: 'Fusebox’s own warnings', nature: 'problem', perItem: true },
];

/** Requests per day through Fusebox, the oldest first (its counters). */
const FUSEBOX_WEEK = [1180, 1342, 964, 410, 388, 1512, 1206];

/** Who used it this month: name, what it is worth, requests. */
const FUSEBOX_CLIENTS: [string, number, number, string?][] = [
  ['John’s laptop', 980, 4120],
  ['This Whombat', 412, 2210, 'Whombat (Lumio)'],
  ['Mac Studio', 296, 1530],
  ['CI runner', 148, 960],
  ['Anna’s laptop', 70, 402],
];

function fuseboxPage(ctx: FixtureServiceCtx): ThingPage {
  const now = ctx.now();
  const days = week(now);
  const total = FUSEBOX_WEEK.reduce((a, b) => a + b, 0);
  const pool = (seed: number, to: number) => {
    const w = wave(now, 84, 2 * HOUR, to * 0.55, to * 0.1, seed);
    return {
      timestamps: w.timestamps,
      values: w.values.map((v, i) => Math.round(v * (0.4 + (0.6 * i) / 83) * 10) / 10),
    };
  };
  const claude = pool(3, 68);
  const codex = pool(5, 22);
  const most = FUSEBOX_CLIENTS[0]?.[1] ?? 1;
  const limitRow = (
    id: string,
    title: string,
    subs: string,
    used: number,
    end: string,
    badge?: ThingGalleryItem['badge'],
  ): ThingGalleryItem => ({
    id,
    title,
    sub: subs,
    progress: used / 100,
    note: `${used} % used`,
    noteEnd: end,
    ...(badge ? { badge } : {}),
  });
  const subscriptions: [string, string, string, string, string][] = [
    ['john@lumio', 'Claude · Max 20x', '41 %', '81 %', 'Thu 09:00'],
    ['ops@lumio', 'Claude · Max 20x', '12 %', '72 %', 'Fri 18:00'],
    ['dev@lumio', 'Claude · Pro', '0 %', '51 %', 'Sat 07:00'],
    ['john@openai', 'ChatGPT · Pro', 'No limit', '22 %', 'Mon 11:00'],
  ];
  return {
    ...head(ctx, {
      thing: FUSEBOX,
      catalogId: 'fusebox',
      name: 'Fusebox',
      status: 'ok',
      badge: 'All 4 subscriptions working',
      facts: [
        [
          { text: '3 Claude', strong: true },
          { text: ' and ' },
          { text: '1 ChatGPT', strong: true },
          { text: ' subscriptions' },
        ],
        [{ text: 'Fusebox ' }, { text: '0.13.2', strong: true }],
        [{ text: 'Up ' }, { text: '3 days', strong: true }],
      ],
      address: '10.100.0.235:8317',
      open: { label: 'Open Fusebox', url: FUSEBOX_URL },
    }),
    tabs: [
      {
        key: 'overview',
        label: 'Summary',
        panels: [
          ...strip([
            notice(
              ctx,
              {
                id: 'runs-out-claude',
                tone: 'info',
                icon: 'clock',
                title: 'Claude’s week runs out Wed around 15:00',
                detail: '18 h before the first reset. john@lumio is at 81 %.',
              },
              'fyi',
              'fusebox.week_runs_out',
              { lifts: 'period', words: 'Until the week resets.' },
              { id: 'tool:claude', name: 'Claude' },
            ),
          ]),
          {
            kind: 'gallery',
            id: 'limits',
            place: 'chart',
            span: 2,
            look: 'rows',
            shape: 'square',
            title: 'Limits now',
            meta: 'All 4 subscriptions working',
            items: [
              limitRow('claude-week', 'Claude · week', '3 subscriptions', 68, 'out about Wed 15:00', {
                text: 'Runs out early',
                tone: 'warn',
              }),
              limitRow('claude-5h', 'Claude · 5 hours', '2 subscriptions', 18, 'resets 17:40'),
              limitRow('codex-week', 'ChatGPT · week', '1 subscription', 22, 'resets Mon 11:00'),
            ],
          },
          {
            kind: 'list',
            id: 'gateway',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'Through Fusebox',
            items: [
              count('subscriptions', 'Subscriptions', '4', { icon: 'key', note: 'All working' }),
              count('clients', 'Clients', '5', {
                icon: 'device',
                detail: 'Used it this month',
                note: '2 connected now',
                noteTone: 'ok',
              }),
              count('requests', 'Requests this month', '9,222', {
                icon: 'network',
                note: `+${total.toLocaleString('en-US')} this week`,
                noteTone: 'ok',
                url: `${FUSEBOX_URL}/#/requests`,
              }),
              count('worth', 'Worth this month', '$ 1,906', {
                icon: 'money',
                detail: 'At API prices',
                note: '+$ 412 this week',
                noteTone: 'ok',
                url: `${FUSEBOX_URL}/#/usage`,
              }),
            ],
          },
          {
            kind: 'chart',
            id: 'week',
            place: 'chart',
            span: 1,
            title: 'Requests this week',
            meta: '99.2 % worked',
            style: 'bars',
            ...days,
            series: [{ key: 'values', label: 'Requests', values: FUSEBOX_WEEK, color: 'green' }],
            figure: { value: total.toLocaleString('en-US'), rest: 'requests this week' },
            stats: [[{ text: '+12 %', strong: true }, { text: ' on last week' }]],
            axis: { min: 0 },
          },
          {
            kind: 'bars',
            id: 'people',
            place: 'chart',
            span: 1,
            title: 'Who used it most',
            meta: 'This month',
            items: FUSEBOX_CLIENTS.map(([name, worth, requests, note], i) => ({
              id: `person-${i}`,
              label: name,
              person: true,
              ...(note ? { note } : {}),
              value: `$ ${worth}`,
              sub: `${requests.toLocaleString('en-US')} requests`,
              pct: worth / most,
            })),
          },
          {
            kind: 'bars',
            id: 'machine',
            place: 'chart',
            span: 1,
            title: 'Fusebox itself',
            items: [
              {
                id: 'fusebox-version',
                label: 'Fusebox',
                value: '0.13.2+gui.81f9ff12',
                mono: true,
                pct: null,
              },
              { id: 'routing', label: 'New sessions', value: 'Most left first · sessions stay', pct: null },
              { id: 'history', label: 'Usage history', value: '1.2 GB', pct: null, sub: '+ 30 MB a day' },
              { id: 'models', label: 'Models', value: '38', pct: null },
              { id: 'up', label: 'Up', value: '3 days', pct: null },
            ],
          },
          {
            kind: 'chart',
            id: 'claude-week',
            place: 'main',
            title: 'Claude · weekly limit',
            timestamps: claude.timestamps,
            series: [
              {
                key: 'pool',
                label: 'Together',
                unit: '%',
                values: claude.values,
                color: 'amber',
                fill: true,
                latest: '68 %',
              },
            ],
            figure: { value: '68 %', rest: 'of 3 subscriptions', tone: 'warn' },
            stats: [
              [{ text: 'At this pace ' }, { text: '100 %', strong: true }, { text: ' Wed around 15:00' }],
              [{ text: 'Resets ' }, { text: 'Thu 09:00', strong: true }],
            ],
            axis: { min: 0, max: 100, unit: '%' },
          },
          {
            kind: 'chart',
            id: 'codex-week',
            place: 'main',
            title: 'ChatGPT · weekly limit',
            timestamps: codex.timestamps,
            series: [
              {
                key: 'pool',
                label: 'john@openai',
                unit: '%',
                values: codex.values,
                color: 'green',
                fill: true,
                latest: '22 %',
              },
            ],
            figure: { value: '22 %', rest: 'used' },
            stats: [
              [{ text: 'At this pace ' }, { text: '41 %', strong: true }, { text: ' at the reset' }],
              [{ text: 'Resets ' }, { text: 'Mon 11:00', strong: true }],
            ],
            axis: { min: 0, max: 100, unit: '%' },
          },
          {
            kind: 'table',
            id: 'subscriptions',
            place: 'main',
            title: 'Subscriptions',
            meta: '4 working',
            columns: [
              { key: 'subscription', label: 'Subscription' },
              { key: 'five', label: '5 hours', numeric: true },
              { key: 'week', label: 'Week', numeric: true },
              { key: 'resets', label: 'Week resets' },
              { key: 'status', label: 'Status' },
            ],
            rows: subscriptions.map(([name, plan, five, wk, resets], i) => ({
              id: `sub-${i}`,
              cells: {
                subscription: { text: name, note: plan },
                five:
                  five === 'No limit'
                    ? { text: five, tone: 'muted' }
                    : { text: five, mono: true, meter: Number.parseInt(five, 10) / 100 },
                week: {
                  text: wk,
                  mono: true,
                  meter: Number.parseInt(wk, 10) / 100,
                  ...(Number.parseInt(wk, 10) >= 80 ? { tone: 'warn' as const } : {}),
                },
                resets: { text: resets, mono: true },
                status: { text: 'Working', dot: 'ok', note: i === 0 ? 'now' : `${i * 7} min ago` },
              },
            })),
          },
          {
            kind: 'bars',
            id: 'who-claude',
            place: 'main',
            title: 'Who used Claude this week',
            meta: '68 % used',
            items: [
              { id: 'client-laptop', label: 'John’s laptop', value: '31 %', pct: 0.46 },
              {
                id: 'client-whombat',
                label: 'This Whombat',
                note: 'Whombat (Lumio)',
                value: '22 %',
                pct: 0.32,
              },
              { id: 'client-studio', label: 'Mac Studio', value: '9 %', pct: 0.13 },
              {
                id: 'outside',
                label: 'Outside Fusebox',
                note: 'claude.ai, the app',
                value: '6 %',
                pct: 0.09,
              },
            ],
          },
          {
            kind: 'list',
            id: 'whombat',
            place: 'main',
            title: 'Whombat uses it for',
            link: { kind: 'tab', label: 'Settings', tab: 'settings' },
            items: [
              {
                id: 'claude',
                title: 'Claude Code',
                detail: '31 agent turns in 7 days',
                right: 'On',
                tone: 'ok',
              },
              { id: 'codex', title: 'Codex', detail: '0 agent turns in 7 days', right: 'Off', tone: 'info' },
              { id: 'key', title: 'Its own key', detail: 'whombat-lumio-3fa2c1', right: 'used 2 min ago' },
            ],
          },
        ],
      },
    ],
  };
}

export const FIRST_PAGES: FixtureServicePage[] = [
  {
    thing: UNIFI,
    catalogId: 'unifi_network',
    name: 'UniFi',
    fields: { url: 'https://10.100.0.100:11443' },
    make: (ctx) => ({
      page: () => unifiPage(ctx),
      row: () => ({
        line: '45 devices',
        facts: [
          { label: 'Internet', value: '84 / 12', unit: 'Mb/s' },
          { label: 'Access points', value: '40 of 41', note: 'online' },
          { label: 'Clients', value: '174' },
        ],
        reason: 'AP Paardenstal is offline',
      }),
      checks: UNIFI_CHECKS,
    }),
  },
  {
    thing: HETZNER,
    catalogId: 'hetzner',
    name: 'Hetzner',
    make: (ctx) => ({
      page: () => hetznerPage(ctx),
      row: () => ({ line: '3 servers', facts: [{ label: 'Servers', value: '3 of 3', note: 'running' }] }),
      checks: HETZNER_CHECKS,
    }),
  },
  {
    thing: FUSEBOX,
    catalogId: 'fusebox',
    name: 'Fusebox',
    fields: { url: FUSEBOX_URL },
    make: (ctx) => ({
      page: () => fuseboxPage(ctx),
      row: () => ({
        line: '4 subscriptions',
        facts: [
          { label: 'Claude week', value: '68 %' },
          { label: 'ChatGPT week', value: '22 %' },
          { label: 'Subscriptions', value: '4 of 4', note: 'working' },
        ],
      }),
      checks: FUSEBOX_CHECKS,
    }),
  },
];
