/**
 * Fixture pages of the servers group: Proxmox VE and Unraid, their Summary in slots as the server builds it
 * (`apps/server/src/things/kinds/servers/`), rows already packed into three columns. Proxmox VE reaches pve-02, which
 * Whombat watches: its page is that server from what Whombat knows of it. Unraid's server isn't watched: its page is
 * what Unraid's own API says. Each entry shows in the web's and the phone's fixture mode at `/things/<thing>`; its shape
 * is in `types.ts`.
 */
import type {
  ThingGalleryItem,
  ThingLine,
  ThingPage,
  ThingPageBar,
  ThingPageItem,
  ThingPagePanel,
} from '@whombat/core/domain';
import { thingHref } from '@whombat/core/domain';
import type { FixtureServiceCtx, FixtureServicePage } from './types.js';

const H = 3_600_000;
const DAY = 24 * H;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const strong = (lead: string, bold: string, rest = ''): ThingLine => [
  ...(lead ? [{ text: lead }] : []),
  { text: bold, strong: true },
  ...(rest ? [{ text: rest }] : []),
];

/** A line of counts, as `countLine` makes it. */
function count(
  p: Omit<ThingPageItem, 'right' | 'figure'> & {
    value: string;
    note?: string;
    noteTone?: 'ok' | 'warn' | 'bad';
  },
): ThingPageItem {
  const { value, note, noteTone, ...rest } = p;
  return {
    ...rest,
    right: value,
    figure: { value, ...(note ? { note } : {}), ...(noteTone ? { tone: noteTone } : {}) },
  };
}

/** The head of a page, and its Summary tab. */
function kit(ctx: FixtureServiceCtx) {
  const head = (p: {
    thing: `connection:${string}`;
    catalogId: string;
    name: string;
    badge: string;
    facts: ThingLine[];
    address: string;
    open: { label: string; url: string };
  }): Omit<ThingPage, 'tabs'> => ({
    id: p.thing,
    kind: 'connection',
    connectionId: p.thing.slice('connection:'.length) as ThingPage['connectionId'],
    catalogId: p.catalogId,
    name: p.name,
    icon: p.catalogId,
    status: 'ok',
    badge: p.badge,
    facts: p.facts,
    address: p.address,
    open: p.open,
    runsOn: null,
    settings: true,
    actions: [],
    readAt: ctx.ago(20_000),
  });
  const summary = (panels: ThingPagePanel[]) => [{ key: 'overview', label: 'Summary', panels }];
  /** The last 7 days, today last. */
  const week = () => {
    const at = Array.from({ length: 7 }, (_, i) => new Date(ctx.now() - (6 - i) * DAY));
    return {
      timestamps: at.map((d) => d.toISOString()),
      labels: at.map((d, i) => (i === 6 ? 'Today' : (WEEKDAYS[d.getDay()] ?? ''))),
    };
  };
  return { head, summary, week };
}

/** A guest's Live row, as `guestRow` makes it. */
function guest(
  id: string,
  name: string,
  sub: string,
  p: { cpu?: number; up?: string; off?: boolean; unhealthy?: boolean; href?: string },
): ThingGalleryItem {
  return {
    id: `guest-${id}`,
    title: name,
    sub,
    ...(p.unhealthy ? { badge: { text: 'Unhealthy', tone: 'warn' as const } } : {}),
    ...(p.cpu !== undefined ? { progress: p.cpu / 100, note: `${p.cpu} % processor` } : {}),
    ...(p.up ? { noteEnd: `up ${p.up}` } : {}),
    ...(p.off ? { note: 'Off', muted: true } : {}),
    ...(p.href ? { href: p.href } : {}),
  };
}

/* Proxmox VE, on a server Whombat watches ---------------------------------------------------------------------------- */

const PVE = 'https://10.100.0.12:8006';
const PVE_02 = thingHref('server', 'pve-02');
const onPve = (id: string) => `${PVE_02}?guest=${encodeURIComponent(id)}`;

const proxmox: FixtureServicePage = {
  thing: 'connection:con_proxmox',
  catalogId: 'proxmox',
  name: 'Proxmox VE',
  fields: { url: PVE, tokenId: 'root@pam!whombat' },
  make(ctx) {
    const { head, summary } = kit(ctx);
    const panels: ThingPagePanel[] = [
      {
        kind: 'gallery',
        id: 'guests',
        place: 'chart',
        span: 2,
        look: 'rows',
        shape: 'square',
        title: 'Guests now',
        meta: '9 of 11 running',
        total: 11,
        items: [
          guest('pve:121', 'immich', 'Container · 5.8 of 8.0 GB', {
            cpu: 38,
            up: '3 weeks',
            href: onPve('pve:121'),
          }),
          guest('pve:110', 'homeassistant', 'VM · 3.1 of 4.0 GB', {
            cpu: 12,
            up: '3 weeks',
            href: onPve('pve:110'),
          }),
          guest('pve:105', 'web', 'VM · 1.4 of 2.0 GB', { cpu: 7, up: '6 days', href: onPve('pve:105') }),
          guest('pve:120', 'paperless', 'Container · 0.9 of 2.0 GB', {
            cpu: 4,
            up: '3 weeks',
            href: onPve('pve:120'),
          }),
          guest('pve:131', 'mail', 'Container · 0.6 of 1.0 GB', {
            cpu: 2,
            up: '2 days',
            href: onPve('pve:131'),
          }),
          guest('pve:122', 'pihole', 'Container · 180 of 512 MB', {
            cpu: 1,
            up: '3 weeks',
            href: onPve('pve:122'),
          }),
        ],
        empty: 'Nothing runs on it.',
      },
      {
        kind: 'list',
        id: 'inventory',
        place: 'chart',
        span: 1,
        look: 'counts',
        title: 'On pve-02',
        items: [
          count({ id: 'vms', title: 'VMs', icon: 'device', value: '3', note: '2 running' }),
          count({ id: 'containers', title: 'Containers', icon: 'database', value: '8', note: '7 running' }),
          count({
            id: 'storage-local-zfs',
            title: 'local-zfs',
            icon: 'disk',
            value: '71 %',
            detail: '612 of 860 GB · zfs',
          }),
          count({
            id: 'storage-tank',
            title: 'tank',
            icon: 'disk',
            value: '58 %',
            detail: '2.3 of 4.0 TB · zfs',
          }),
          count({
            id: 'backups',
            title: 'Backed up',
            icon: 'backup',
            tone: 'bad',
            value: '10 of 11',
            note: '6 h ago',
            noteTone: 'bad',
            detail: '1 guest failed last time · 2 in no backup job',
          }),
        ],
      },
      {
        kind: 'bars',
        id: 'machine',
        place: 'chart',
        span: 3,
        columns: 3,
        title: 'The machine',
        meta: 'pve-02',
        link: { kind: 'href', label: 'See pve-02', href: PVE_02 },
        items: [
          { id: 'cpu', label: 'Processor', note: 'of 16 cores', value: '24 %', pct: 0.24 },
          { id: 'memory', label: 'Memory', value: '41 of 64 GB', pct: 0.64 },
          { id: 'disk', label: 'Disk', value: '2.9 of 4.9 TB', pct: 0.59 },
          { id: 'system', label: 'Proxmox VE', value: '9.0.10', pct: null },
          { id: 'up', label: 'Up', value: '3 weeks', pct: null },
        ] satisfies ThingPageBar[],
      },
    ];
    return {
      page: () => ({
        ...head({
          thing: 'connection:con_proxmox',
          catalogId: 'proxmox',
          name: 'Proxmox VE',
          badge: '9 of 11 guests running',
          facts: [strong('Part of ', 'pve-02'), strong('Proxmox VE ', '9.0.10')],
          address: '10.100.0.12:8006',
          open: { label: 'Open Proxmox', url: PVE },
        }),
        runsOn: { serverId: 'pve-02', guestId: null, name: 'pve-02', href: PVE_02, how: 'address' },
        partOf: 'server:pve-02',
        tabs: summary(panels),
      }),
      row: () => ({ line: 'Part of pve-02' }),
      checks: [
        { check: 'proxmox.node_offline', name: 'Nodes going offline', nature: 'problem', perItem: true },
        { check: 'proxmox.storage_full', name: 'Storage filling up', nature: 'problem', perItem: true },
      ],
    };
  },
};

/* Unraid, read through its own API ----------------------------------------------------------------------------------- */

const TOWER = 'http://10.100.0.40';

const unraid: FixtureServicePage = {
  thing: 'connection:con_unraid',
  catalogId: 'unraid',
  name: 'Unraid',
  fields: { url: TOWER },
  make(ctx) {
    const { head, summary, week } = kit(ctx);
    const panels: ThingPagePanel[] = [
      {
        kind: 'gallery',
        id: 'guests',
        place: 'chart',
        span: 2,
        look: 'rows',
        shape: 'square',
        title: 'Guests now',
        meta: '9 of 11 running',
        total: 12,
        items: [
          { id: 'parity', title: 'Parity check', sub: 'No errors so far', progress: 0.37, note: '37 %' },
          guest('docker:nextcloud', 'nextcloud', 'Container · Up 3 hours', { unhealthy: true }),
          guest('vm:ha', 'Home Assistant', 'VM', {}),
          guest('docker:immich', 'immich', 'Container · Up 12 days', {}),
          guest('docker:plex', 'plex', 'Container · Up 12 days', {}),
          guest('docker:sonarr', 'sonarr', 'Container · Up 12 days', {}),
        ],
        empty: 'Nothing runs on it.',
      },
      {
        kind: 'list',
        id: 'inventory',
        place: 'chart',
        span: 1,
        look: 'counts',
        title: 'In Unraid',
        items: [
          count({
            id: 'array',
            title: 'Array',
            icon: 'disk',
            value: '63 %',
            detail: '24.6 of 39.0 TB · 4 disks',
          }),
          count({
            id: 'pool-cache',
            title: 'cache',
            icon: 'disk',
            value: '40 %',
            detail: '0.4 of 1.0 TB · pool',
          }),
          count({
            id: 'disks',
            title: 'Disks',
            icon: 'disk',
            value: '6',
            note: 'All fine · warmest 41 °C',
            url: TOWER,
          }),
          count({
            id: 'containers',
            title: 'Containers',
            icon: 'database',
            value: '9',
            note: '1 unhealthy',
            noteTone: 'warn',
            url: TOWER,
          }),
          count({ id: 'vms', title: 'VMs', icon: 'device', value: '2', note: '1 running', url: TOWER }),
          count({ id: 'shares', title: 'Shares', icon: 'network', value: '6', url: TOWER }),
        ],
      },
      {
        kind: 'chart',
        id: 'week',
        place: 'chart',
        span: 2,
        title: 'Space used',
        meta: 'The array',
        style: 'bars',
        ...week(),
        series: [
          {
            key: 'values',
            label: 'Added',
            values: [12.4, 0, 3.1, 48.2, 5.5, 9, 2.2],
            color: 'violet',
            unit: 'GB',
          },
        ],
        figure: { value: '+80 GB', rest: 'this week' },
        axis: { min: 0 },
      },
      {
        kind: 'bars',
        id: 'machine',
        place: 'chart',
        span: 1,
        title: 'The machine',
        meta: 'Tower',
        items: [
          { id: 'cpu', label: 'Processor', value: '13 %', pct: 0.13 },
          { id: 'memory', label: 'Memory', value: '12 of 32 GB', pct: 0.38 },
          { id: 'unraid-version', label: 'Unraid', value: '7.2.2', pct: null },
          { id: 'up', label: 'Up', value: '12 days', pct: null },
        ],
      },
    ];
    return {
      page: () => ({
        ...head({
          thing: 'connection:con_unraid',
          catalogId: 'unraid',
          name: 'Unraid',
          badge: 'Array started',
          facts: [strong('Unraid ', '7.2.2'), strong('', 'Tower')],
          address: '10.100.0.40',
          open: { label: 'Open Unraid', url: TOWER },
        }),
        verdict: 'Unraid is fine: the array is started and 9 of 11 containers and VMs run.',
        tabs: summary(panels),
      }),
      row: () => ({ line: 'Array started', facts: [{ label: 'Array', value: '63 %' }] }),
      checks: [
        { check: 'unraid.array_stopped', name: 'The array stopping', nature: 'problem', perItem: false },
        {
          check: 'unraid.disk',
          name: 'Disks disabled, missing or with errors',
          nature: 'problem',
          perItem: true,
        },
        {
          check: 'unraid.parity_errors',
          name: 'Parity checks that find errors',
          nature: 'problem',
          perItem: false,
        },
        { check: 'unraid.array_full', name: 'The array filling up', nature: 'problem', perItem: false },
      ],
    };
  },
};

export const SERVER_PAGES: FixtureServicePage[] = [proxmox, unraid];
