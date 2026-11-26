/**
 * The mockups' world as data (`desk-widgets/src/kit.js`): the box's three pages (Overview, Media, House), the office
 * monitor and the kitchen tablet, a view of every kind, the calm glance when all is fine and when pve-02 is down, and
 * what needs the person (the outage and a question). For tests, the web app's fixture mode and the console's shots.
 * Pictures are drawn here (SVG data URLs) so nothing is fetched.
 */
import type {
  DeskAttention,
  DeskGrid,
  DeskImage,
  DeskLayout,
  DeskListView,
  DeskPage,
  DeskWeatherView,
  DeskWidget,
  DeskWidgetView,
  ScreenCalm,
} from './types';

/** 14:34 on Tuesday 27 October 2026 in Amsterdam, as the mockups. */
export const FIXTURE_NOW = Date.parse('2026-10-27T13:34:20Z');
export const FIXTURE_TIME_ZONE = 'Europe/Amsterdam';
export const FIXTURE_NAME = 'Home';
export const FIXTURE_ASSISTANT = 'Dusty';
/** The screens' sizes in logical pixels: the Z13, a 24″ 1080p monitor, a portrait iPad. */
export const FIXTURE_SIZES = {
  box: { width: 1280, height: 800 },
  monitor: { width: 1920, height: 1080 },
  tablet: { width: 820, height: 1180 },
} as const;

/* Pictures ------------------------------------------------------------------------------------------------------- */

const POSTERS: Record<string, [string, string]> = {
  dune: ['#d08a3a', '#3a2212'],
  bear: ['#3b7d9c', '#10222c'],
  civilwar: ['#8c3b2f', '#1d1311'],
  shogun: ['#a8322d', '#2b0f0d'],
  insideout: ['#5f8fd6', '#2b2a6b'],
  furiosa: ['#d9822b', '#4a1f0e'],
  fallout: ['#c7a23a', '#2c2410'],
  slowhorses: ['#5b6b52', '#1a1f17'],
};

const img = (thing: string, key: string, shape: DeskImage['shape'], alt?: string): DeskImage => ({
  thing,
  ref: `${key}.fixture-signature`,
  shape,
  ...(alt ? { alt } : {}),
});

const PLEX = 'connection:con_plex';
const SEERR = 'connection:con_seerr';
const HA = 'device:dev_homeassistant';

const poster = (key: string) => {
  const [a, b] = POSTERS[key] ?? ['#555', '#222'];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><defs><linearGradient id="g" x1="0" y1="0" x2=".5" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="200" height="300" fill="url(#g)"/></svg>`;
};

const DOOR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a4554"/><stop offset="1" stop-color="#1e252e"/></linearGradient><radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#f6d58a" stop-opacity=".55"/><stop offset="1" stop-color="#f6d58a" stop-opacity="0"/></radialGradient></defs><rect width="400" height="300" fill="url(#sky)"/><rect x="0" y="0" width="400" height="215" fill="#4b4640"/><g opacity=".22">${Array.from({ length: 12 }, (_, i) => `<line x1="0" x2="400" y1="${i * 18 + 6}" y2="${i * 18 + 6}" stroke="#2b2724" stroke-width="2"/>`).join('')}</g><rect x="150" y="62" width="100" height="153" rx="3" fill="#2b211b"/><rect x="158" y="70" width="84" height="145" fill="#4a3426"/><rect x="170" y="84" width="60" height="44" fill="#5c4130"/><rect x="170" y="140" width="60" height="62" fill="#5c4130"/><circle cx="232" cy="150" r="4" fill="#c9a86a"/><circle cx="285" cy="80" r="40" fill="url(#glow)"/><rect x="280" y="72" width="10" height="16" rx="2" fill="#f6d58a"/><polygon points="120,215 280,215 360,300 40,300" fill="#3c3d3f"/><rect x="0" y="213" width="400" height="5" fill="#2e2f31"/><ellipse cx="72" cy="222" rx="44" ry="26" fill="#2f4a33"/><ellipse cx="335" cy="226" rx="48" ry="24" fill="#2c4430"/><rect x="0" y="0" width="400" height="300" fill="#000" opacity=".08"/></svg>`;

/** Photos for the photo view: a sky, a sun, hills or a sea, in each one's colours. */
const SCENES: Record<string, { sky: [string, string]; sun: string; land: [string, string]; sea?: string }> = {
  texel: { sky: ['#f2c78b', '#7fa8c9'], sun: '#fff1c9', land: ['#d9c39a', '#b89f74'], sea: '#4f7f9c' },
  forest: { sky: ['#a9c7d8', '#e6dcc4'], sun: '#fff8e2', land: ['#3f6b45', '#22402a'] },
  harbour: { sky: ['#e9876b', '#3c3a5e'], sun: '#ffd28a', land: ['#2c2b3a', '#1b1a26'], sea: '#3a4a6e' },
  snow: { sky: ['#c9d8e8', '#f1f4f7'], sun: '#ffffff', land: ['#e8edf2', '#aebccb'] },
  tulips: { sky: ['#9cc3e4', '#dbe9f2'], sun: '#fffbe8', land: ['#c8473f', '#5d8a3c'] },
};
const scene = (key: string) => {
  const c = SCENES[key] ?? SCENES.texel;
  if (!c) return '';
  const sea = c.sea
    ? `<rect y="190" width="400" height="110" fill="${c.sea}"/><rect y="250" width="400" height="50" fill="url(#land)"/>`
    : `<path d="M0 200 Q90 150 180 190 T400 170 V300 H0Z" fill="url(#land)"/><path d="M0 240 Q120 205 240 235 T400 225 V300 H0Z" fill="${c.land[1]}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.sky[1]}"/><stop offset="1" stop-color="${c.sky[0]}"/></linearGradient><linearGradient id="land" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.land[0]}"/><stop offset="1" stop-color="${c.land[1]}"/></linearGradient></defs><rect width="400" height="300" fill="url(#sky)"/><circle cx="290" cy="120" r="28" fill="${c.sun}"/>${sea}</svg>`;
};

/** The fixtures' pictures as the host's loader gives them: data URLs, at once. */
export function fixtureLoadImage(image: DeskImage): Promise<string> {
  const key = image.ref.slice(0, image.ref.indexOf('.'));
  const svg = key === 'frontdoor' ? DOOR : key in SCENES ? scene(key) : poster(key);
  return Promise.resolve(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

/* Lines over time ------------------------------------------------------------------------------------------------ */

/** The mockups' wandering line: `n` points between `lo` and `hi`, the same for the same seed. */
export function fixtureSeries(seed: number, n = 25, lo = 3, hi = 27, start = 10): number[] {
  let x = seed * 9301 + 49297;
  let v = start;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    x = (x * 9301 + 49297) % 233280;
    v = Math.max(lo, Math.min(hi, v + (x / 233280 - 0.5) * 8));
    out.push(Math.round(v * 10) / 10);
  }
  return out;
}
const pct = (seed: number, n = 30) => fixtureSeries(seed, n).map((v) => Math.round(v));

/* The views ------------------------------------------------------------------------------------------------------ */

const at = '2026-10-27T13:33:40Z';

export const FIXTURE_VIEWS: DeskWidgetView[] = [
  {
    kind: 'figures',
    id: 'w_climate',
    title: 'Living room',
    mark: 'homeassistant',
    items: [
      { value: '21.4', unit: '°C', label: 'Living room' },
      { value: '48', unit: '%', label: 'Humidity' },
    ],
    line: 'Today 19.8 – 22.1 °C',
    spark: fixtureSeries(11),
    at,
  },
  {
    kind: 'figures',
    id: 'w_outside',
    title: 'Outside',
    mark: 'homeassistant',
    items: [
      { value: '11.8', unit: '°C', label: 'Outside' },
      { value: '81', unit: '%', label: 'Humidity' },
    ],
    spark: fixtureSeries(13),
    at,
  },
  {
    kind: 'server',
    id: 'w_pve01',
    title: 'pve-01',
    mark: 'proxmox',
    line: 'Proxmox · 16 cores',
    state: 'ok',
    cpu: 12,
    memory: 41,
    disk: 37,
    spark: pct(1, 48),
    range: '24h',
    stats: ['Avg 14 % · Peak 63 % Sun 03:10'],
    uptime: 'Up 21 days',
    server: 'pve-01',
    at,
  },
  {
    kind: 'figures',
    id: 'w_internet',
    title: 'Internet',
    mark: 'unifi_network',
    items: [{ value: '942 ↓ 48 ↑', label: 'Mbps down and up' }],
    line: 'Mbps · 174 devices',
    spark: fixtureSeries(21, 30),
    at,
  },
  {
    kind: 'posters',
    id: 'w_playing',
    title: 'Now playing',
    name: 'Plex',
    mark: 'plex',
    head: '2 watching',
    shape: 'poster',
    items: [
      {
        title: 'Dune: Part Two',
        detail: 'Film · 2024',
        who: 'John · Living room TV',
        progress: 64,
        time: '1:42 of 2:46',
        image: img(PLEX, 'dune', 'poster', 'Dune: Part Two'),
      },
      {
        title: 'The Bear',
        detail: 'S3 · E4 “Violet”',
        who: 'Sanne · iPad',
        progress: 22,
        time: '0:07 of 0:31',
        image: img(PLEX, 'bear', 'poster', 'The Bear'),
      },
    ],
    at,
  },
  {
    kind: 'posters',
    id: 'w_recent',
    title: 'Recently added',
    name: 'Plex',
    mark: 'plex',
    head: 'this week',
    shape: 'poster',
    items: (
      [
        ['civilwar', 'Civil War'],
        ['shogun', 'Shōgun'],
        ['insideout', 'Inside Out 2'],
        ['furiosa', 'Furiosa'],
        ['fallout', 'Fallout'],
        ['slowhorses', 'Slow Horses'],
      ] as const
    ).map(([key, title]) => ({ title, image: img(PLEX, key, 'poster', title) })),
    at,
  },
  {
    kind: 'figures',
    id: 'w_library',
    title: 'Library',
    name: 'Plex',
    mark: 'plex',
    items: [
      { value: '1,284', label: 'films' },
      { value: '312', label: 'shows' },
      { value: '4.2', unit: 'TB', label: 'free' },
    ],
    at,
  },
  {
    kind: 'list',
    id: 'w_queue',
    title: 'Download queue',
    name: 'SABnzbd',
    mark: 'sabnzbd',
    head: '3 left · about 20 min',
    progress: 62,
    rows: [
      { title: 'Shōgun S01 1080p', meta: '4.2 GB', progress: 78 },
      { title: 'Civil War 2024 2160p', meta: '12.1 GB', progress: 31 },
      { title: 'The Bear S03E05', meta: '1.1 GB', detail: 'Waiting' },
      { title: 'Furiosa 2024 1080p', meta: '8.4 GB', detail: 'Waiting' },
      { title: 'Slow Horses S04E03', meta: '1.4 GB', detail: 'Waiting' },
    ],
    at,
  },
  {
    kind: 'list',
    id: 'w_requests',
    title: 'Requests',
    name: 'Seerr',
    mark: 'overseerr',
    head: '2 new',
    rows: [
      { title: 'Inside Out 2', detail: 'Sanne · 1 h ago', image: img(SEERR, 'insideout', 'poster') },
      { title: 'Fallout · Season 2', detail: 'Tom · 3 h ago', image: img(SEERR, 'fallout', 'poster') },
    ],
    at,
  },
  {
    kind: 'list',
    id: 'w_episodes',
    title: 'Coming up',
    name: 'Sonarr',
    mark: 'sonarr',
    rows: [
      { time: '21:00', title: 'The Bear', detail: 'S3 E5 · tonight' },
      { time: 'Thu', title: 'Shōgun', detail: 'S1 E9' },
      { time: 'Fri', title: 'Slow Horses', detail: 'S4 E3' },
      { time: 'Sun', title: 'Fallout', detail: 'S2 E1' },
    ],
    at,
  },
  {
    kind: 'camera',
    id: 'w_door',
    title: 'Front door',
    mark: 'homeassistant',
    image: img(HA, 'frontdoor', 'wide', 'The front door'),
    event: 'Someone at the door · 14:21',
    at,
  },
  {
    kind: 'list',
    id: 'w_lights',
    title: 'Lights',
    mark: 'homeassistant',
    head: '2 on',
    rows: [
      { title: 'Living room', state: 'on', meta: 'On · 80 %' },
      { title: 'Kitchen', state: 'on', meta: 'On' },
      { title: 'Garden', state: 'off', meta: 'Off' },
      { title: 'Hall', state: 'off', meta: 'Off' },
      { title: 'Bedroom', state: 'off', meta: 'Off' },
      { title: 'Office', state: 'off', meta: 'Off' },
    ],
    at,
  },
  {
    kind: 'figures',
    id: 'w_blocked',
    title: 'Pi-hole',
    mark: 'pihole',
    items: [{ value: '12', unit: '% blocked', label: 'blocked' }],
    line: '2,184 of 18,204 lookups today',
    spark: fixtureSeries(31),
    at,
  },
  {
    kind: 'list',
    id: 'w_today',
    title: 'Today',
    name: 'Family calendar',
    mark: 'google',
    rows: [
      { time: '15:30', title: 'Dentist', detail: 'Sanne' },
      { time: '18:00', title: 'Football training', detail: 'Tom' },
      { time: '19:30', title: 'Dinner at Marco’s', detail: 'everyone' },
      { time: 'Wed', title: 'Bins out', detail: 'tomorrow morning' },
    ],
    at,
  },
  {
    kind: 'list',
    id: 'w_coming',
    title: 'Coming up',
    rows: [
      { time: '02:00', title: 'Backups', detail: 'pve-01, pve-02 and nas' },
      { time: '08:00', title: 'Morning summary', detail: 'in your Chat' },
      { time: 'Thu', title: 'Renew the certificate', detail: 'on pve-01' },
    ],
    at,
  },
  {
    kind: 'figures',
    id: 'w_backups',
    title: 'Backups',
    mark: 'proxmox_backup',
    items: [{ value: 'All 14 done', label: 'Last night at 02:00', tone: 'ok' }],
    line: 'Last night at 02:00',
    at,
  },
  {
    kind: 'figures',
    id: 'w_storage',
    title: 'Volume 1',
    name: 'nas',
    mark: 'synology',
    tone: 'warn',
    items: [
      { value: '88', unit: '% full', label: 'full', tone: 'warn' },
      { value: '3.1', unit: 'TB', label: 'free of 26 TB' },
    ],
    progress: 88,
    line: 'At this rate it’s full in about 12 days.',
    at,
  },
  {
    kind: 'list',
    id: 'w_work',
    title: 'Dusty’s work',
    head: 'Updating the server agents',
    progress: 50,
    rows: [
      { title: 'pve-01', meta: 'updated', tone: 'ok' },
      { title: 'pve-02', meta: 'updated', tone: 'ok' },
      { title: 'the-falcon', meta: 'now' },
      { title: 'blackbox', meta: 'next' },
    ],
    at,
  },
  {
    kind: 'list',
    id: 'w_done',
    title: 'Done today',
    rows: [
      { time: '13:05', title: 'Updated the-falcon and restarted it' },
      { time: '12:41', title: 'Renewed the certificate on pve-01' },
      { time: '11:20', title: 'Answered Bakkerij de Vries' },
    ],
    count: 3,
    at,
  },
  {
    kind: 'chart',
    id: 'w_power',
    title: 'Power use',
    mark: 'homeassistant',
    figure: { value: '412 W', rest: 'now' },
    series: [{ points: fixtureSeries(41, 48, 3, 27, 12).map((v) => Math.round(v * 30)) }],
    unit: 'W',
    limit: 780,
    stats: ['Today 6.2 kWh · Peak 1.4 kW at 07:40'],
    at,
  },
  {
    kind: 'text',
    id: 'w_note',
    title: 'Note',
    name: 'Made by Dusty',
    body: 'The bins go out on Wednesday morning. Tom has football at 18:00, so dinner is at 19:30.',
    at,
  },
];

/** pve-01's other widgets (DK-153) and a server short of disk, as the runtime draws them: `f-servers`. */
export const FIXTURE_SERVER_VIEWS: DeskWidgetView[] = [
  {
    kind: 'server',
    id: 'w_nas',
    title: 'nas',
    mark: 'synology',
    line: 'Synology DS923+',
    state: 'warn',
    tone: 'warn',
    say: 'disk 91 %',
    cpu: 4,
    memory: 38,
    disk: 91,
    spark: pct(5, 48),
    range: '24h',
    uptime: 'Up 120 days',
    server: 'nas',
    at,
  },
  {
    kind: 'chart',
    id: 'w_pve01_cpu',
    title: 'Processor',
    name: 'pve-01',
    mark: 'proxmox',
    tone: 'ok',
    figure: { value: '12 %', rest: 'of 16 cores · load 1.2' },
    series: [{ points: pct(1, 48), tone: 'ok' }],
    unit: '%',
    stats: ['Last 24 hours · Avg 14 % · Peak 63 % Sun 03:10'],
    at,
  },
  {
    kind: 'chart',
    id: 'w_pve01_memory',
    title: 'Memory',
    name: 'pve-01',
    mark: 'proxmox',
    tone: 'ok',
    figure: { value: '41 %', rest: '26.2 GB of 64 GB' },
    series: [{ points: fixtureSeries(7, 48, 38, 46), tone: 'ok' }],
    unit: '%',
    stats: ['Last 24 hours · Avg 43 %'],
    at,
  },
  {
    kind: 'chart',
    id: 'w_pve01_network',
    title: 'Network',
    name: 'pve-01',
    mark: 'proxmox',
    tone: 'ok',
    figure: { value: '↓ 12.4 MB/s', rest: '↑ 1.2 MB/s' },
    series: [
      { label: 'In', points: fixtureSeries(3, 48, 40, 120) },
      { label: 'Out', points: fixtureSeries(9, 48, 4, 30) },
    ],
    unit: 'Mb/s',
    stats: ['Last 24 hours'],
    at,
  },
  {
    kind: 'list',
    id: 'w_pve01_storage',
    title: 'Storage',
    name: 'pve-01',
    mark: 'proxmox',
    tone: 'ok',
    head: '1.3 of 3.6 TB used',
    progress: 37,
    rows: [
      { title: 'vmdata', detail: 'zfs · 3.2 of 3.8 TB', meta: '83 %', progress: 83 },
      { title: 'backups', detail: 'backup server · 1.4 of 2 TB', meta: '70 %', progress: 70 },
      { title: 'local', detail: 'folder · 44 of 100 GB', meta: '44 %', progress: 44 },
      { title: 'local-zfs', detail: 'zfs · 79 of 980 GB', meta: '8 %', progress: 8 },
    ],
    at,
  },
  {
    kind: 'list',
    id: 'w_pve01_guests',
    title: 'VMs and containers',
    name: 'pve-01',
    mark: 'proxmox',
    tone: 'ok',
    head: '9 running · 1 off',
    rows: [
      { title: 'plex', detail: 'Container', state: 'on', meta: '23 %', tone: 'ok' },
      { title: 'homeassistant', detail: 'VM', state: 'on', meta: '6 %', tone: 'ok' },
      { title: 'k3s-node-1', detail: 'VM', state: 'on', meta: '4 %', tone: 'ok' },
      { title: 'pihole', detail: 'Container', state: 'on', meta: '1 %', tone: 'ok' },
      { title: 'win-build', detail: 'VM', state: 'off', meta: 'off' },
    ],
    count: 10,
    at,
  },
  {
    kind: 'figures',
    id: 'w_pve01_temp',
    title: 'Temperature',
    name: 'pve-01',
    mark: 'proxmox',
    tone: 'ok',
    items: [
      { value: '54', unit: '°C', label: 'CPU package' },
      { value: '41', unit: '°C', label: 'NVMe' },
      { value: '38', unit: '°C', label: 'Board' },
    ],
    progress: 64,
    line: 'CPU package · hot from 85 °C',
    at,
  },
  {
    kind: 'list',
    id: 'w_pve01_alerts',
    title: 'Alerts',
    name: 'pve-01',
    mark: 'proxmox',
    tone: 'ok',
    rows: [
      { title: 'Backup of win-build failed', tone: 'bad', time: '03:12' },
      { title: 'CPU package at 83 °C', tone: 'warn', time: 'Mon' },
    ],
    at,
  },
];

/* Photos and boards (DK-160, DK-162) ------------------------------------------------------------------------------ */

const IMMICH = 'connection:con_immich';
const photo = (key: string, caption?: string, time?: string) => ({
  image: img(IMMICH, key, 'wide', caption),
  ...(caption ? { caption } : {}),
  ...(time ? { time } : {}),
});

const CONTAINERS = [
  'plex',
  'sonarr',
  'radarr',
  'prowlarr',
  'sabnzbd',
  'seerr',
  'tautulli',
  'bazarr',
  'immich-server',
  'immich-ml',
  'postgres',
  'redis',
  'nginx-proxy',
  'authelia',
  'vaultwarden',
  'paperless',
  'gotenberg',
  'tika',
  'homepage',
  'uptime-kuma',
  'grafana',
  'prometheus',
  'node-exporter',
  'cadvisor',
  'loki',
  'promtail',
  'mosquitto',
  'zigbee2mqtt',
  'esphome',
  'node-red',
  'adguard',
  'unbound',
  'wireguard',
  'syncthing',
  'nextcloud',
  'mariadb',
  'collabora',
  'freshrss',
  'mealie',
  'backup-box',
];
const containerTone = (name: string, i: number) =>
  name === 'paperless' ? 'bad' : name === 'immich-ml' || name === 'tika' ? 'warn' : i >= 37 ? 'off' : 'ok';
const containerValue = (name: string, i: number) =>
  name === 'paperless'
    ? 'stopped'
    : name === 'immich-ml'
      ? 'restarting'
      : name === 'tika'
        ? '92 % mem'
        : i >= 37
          ? 'off'
          : `${((i * 7) % 23) + 1} %`;

/** A photo view and boards at every size: Immich's *On this day*, a frame, containers, devices, empty and locked. */
export const FIXTURE_PHOTO_BOARD_VIEWS: DeskWidgetView[] = [
  {
    kind: 'photo',
    id: 'w_memories',
    title: 'On this day',
    name: 'Immich',
    mark: 'immich',
    items: [
      photo('texel', '3 years ago · Texel', '27 October 2023'),
      photo('forest', '5 years ago · Veluwe', '27 October 2021'),
      photo('harbour', '8 years ago · Harlingen', '27 October 2018'),
    ],
    every: 120,
    at,
  },
  {
    kind: 'photo',
    id: 'w_frame',
    title: 'Family',
    name: 'Immich',
    mark: 'immich',
    items: [photo('tulips'), photo('snow')],
    at,
  },
  {
    kind: 'photo',
    id: 'w_memories_none',
    title: 'On this day',
    name: 'Immich',
    mark: 'immich',
    items: [],
    empty: 'No photos from this day in other years',
    at,
  },
  {
    kind: 'board',
    id: 'w_containers',
    title: 'Containers',
    name: 'pve-01',
    mark: 'docker',
    head: '37 running',
    items: CONTAINERS.map((label, i) => ({
      label,
      tone: containerTone(label, i),
      value: containerValue(label, i),
    })),
    at,
  },
  {
    kind: 'board',
    id: 'w_containers_all',
    title: 'Containers',
    name: 'pve-01',
    mark: 'docker',
    head: '49 running · 3 need a look',
    items: CONTAINERS.map((label, i) => ({ label, tone: containerTone(label, i) })),
    count: 52,
    at,
  },
  {
    kind: 'board',
    id: 'w_devices',
    title: 'Devices',
    name: 'UniFi',
    mark: 'unifi_network',
    head: '7 online',
    items: [
      { label: 'Gateway', tone: 'ok', value: '42 d' },
      { label: 'Switch upstairs', tone: 'ok', value: '42 d' },
      { label: 'Switch office', tone: 'ok', value: '12 d' },
      { label: 'AP living room', tone: 'ok', value: '18 clients' },
      { label: 'AP attic', tone: 'warn', value: 'weak uplink' },
      { label: 'AP garden', tone: 'off', value: 'offline' },
      { label: 'AP kitchen', tone: 'ok', value: '9 clients' },
      { label: 'Doorbell', tone: 'ok' },
    ],
    at,
  },
  {
    kind: 'board',
    id: 'w_repos',
    title: 'Main branches',
    name: 'GitHub',
    mark: 'github',
    items: [
      { label: 'whombat', tone: 'ok', value: 'passing' },
      { label: 'whombat-appliance', tone: 'bad', value: 'failing' },
      { label: 'whombat-api', tone: 'ok', value: 'passing' },
      { label: 'website', tone: 'ok', value: 'passing' },
    ],
    at,
  },
  {
    kind: 'board',
    id: 'w_devices_none',
    title: 'Devices',
    name: 'UniFi',
    mark: 'unifi_network',
    items: [],
    empty: 'No devices adopted yet',
    at,
  },
];

/* The weather and the news --------------------------------------------------------------------------------------- */

const HOUR = 3_600_000;
/** The hour the forecast starts at: 14:00 in Amsterdam. */
const FORECAST_FROM = Date.parse('2026-10-27T13:00:00Z');
/** An afternoon in late October: a shower at tea time, clear in the night, a grey morning. */
const HOUR_SKY: readonly string[] = [
  'partlycloudy_day',
  'partlycloudy_day',
  'lightrainshowers_day',
  'rainshowers_day',
  'cloudy',
  'partlycloudy_night',
  'fair_night',
  'clearsky_night',
  'clearsky_night',
  'clearsky_night',
  'fair_night',
  'fair_night',
  'partlycloudy_night',
  'cloudy',
  'cloudy',
  'fog',
  'fog',
  'cloudy',
  'partlycloudy_day',
  'partlycloudy_day',
  'fair_day',
  'fair_day',
  'partlycloudy_day',
  'lightrain',
];
const HOUR_TEMP = [11, 12, 11, 10, 9, 9, 8, 8, 7, 7, 6, 6, 6, 5, 5, 5, 6, 7, 8, 10, 11, 12, 12, 11];
const HOUR_RAIN: Readonly<Record<number, number>> = { 2: 0.4, 3: 1.6, 23: 0.3 };

/** The weather in Amsterdam at the fixtures' moment, from MET Norway (`weather`'s view). */
export const FIXTURE_WEATHER: DeskWeatherView = {
  kind: 'weather',
  id: 'w_weather',
  title: 'Weather',
  place: 'Amsterdam',
  unit: 'C',
  now: { temp: 11, symbol: 'partlycloudy_day', text: 'Partly cloudy', wind: '5 m/s SW', feels: 9 },
  today: { high: 12, low: 7, rainMm: 2.3, rainChance: 60 },
  hours: HOUR_SKY.map((symbol, i) => ({
    at: new Date(FORECAST_FROM + i * HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    temp: HOUR_TEMP[i] ?? 10,
    symbol,
    ...(HOUR_RAIN[i] !== undefined ? { rainMm: HOUR_RAIN[i] } : {}),
  })),
  days: [
    { date: '2026-10-27', high: 12, low: 7, symbol: 'rainshowers_day', rainMm: 2.3 },
    { date: '2026-10-28', high: 13, low: 5, symbol: 'partlycloudy_day' },
    { date: '2026-10-29', high: 11, low: 6, symbol: 'rain', rainMm: 8.4 },
    { date: '2026-10-30', high: 9, low: 4, symbol: 'heavyrainshowersandthunder_day', rainMm: 12.1 },
    { date: '2026-10-31', high: 8, low: 2, symbol: 'clearsky_day' },
    { date: '2026-11-01', high: 6, low: 0, symbol: 'lightsleetshowers_day', rainMm: 1.2 },
    { date: '2026-11-02', high: 4, low: -2, symbol: 'snow', rainMm: 3.5 },
  ],
  sun: { rise: '2026-10-27T06:26:00Z', set: '2026-10-27T16:16:00Z' },
  credit: 'Data from MET Norway',
  at,
};

/** Headlines from the two sites Mara turned on (`news`'s list). */
export const FIXTURE_NEWS: DeskListView = {
  kind: 'list',
  id: 'w_news',
  title: 'News',
  rows: [
    {
      title: 'Trains between Utrecht and Amsterdam run again after the signal fault',
      detail: 'NOS',
      time: '14:12',
    },
    { title: 'New cycle bridge over the IJ opens next spring', detail: 'AT5', time: '13:40' },
    { title: 'Storm warning for the coast on Thursday night', detail: 'NOS', time: '12:55' },
    { title: 'Museum night sells out in under an hour', detail: 'AT5', time: '11:30' },
    { title: 'Parliament agrees on the housing plan after a long night', detail: 'NOS', time: '10:02' },
    { title: 'Markets open higher as energy prices fall', detail: 'NOS', time: '09:15' },
  ],
  at,
};

/** The weather and the news at every size, with no site on, without a place, and not read. */
export const FIXTURE_WEATHER_NEWS_VIEWS: DeskWidgetView[] = [
  FIXTURE_WEATHER,
  {
    ...FIXTURE_WEATHER,
    id: 'w_weather_night',
    place: 'Tromsø',
    now: { temp: -4, symbol: 'lightsnowshowersandthunder_night', text: 'Light snow showers and thunder' },
    today: { high: -1, low: -6 },
    sun: { polar: 'night' },
  },
  {
    ...FIXTURE_WEATHER,
    id: 'w_weather_wrong',
    now: undefined,
    today: undefined,
    hours: [],
    days: [],
    tone: 'bad',
    problem: { text: 'Can’t read the weather just now' },
  },
  FIXTURE_NEWS,
  { ...FIXTURE_NEWS, id: 'w_news_none', rows: [], empty: 'Choose your news in Settings' },
];

/** The same widgets with pve-02 down: what ran on it says so (DK-135). */
export const FIXTURE_VIEWS_WRONG: DeskWidgetView[] = FIXTURE_VIEWS.map((v) => {
  if (v.id === 'w_playing' || v.id === 'w_recent' || v.id === 'w_library')
    return {
      ...v,
      tone: 'bad',
      problem: { text: 'Plex isn’t answering', detail: 'It runs on pve-02, which is down.' },
    };
  if (v.id === 'w_queue')
    return { ...v, tone: 'bad', problem: { text: 'Stopped', detail: 'It runs on pve-02, which is down.' } };
  if (v.id === 'w_requests') return { ...v, tone: 'bad', problem: { text: 'Isn’t answering' } };
  return v;
});

/* The layouts ---------------------------------------------------------------------------------------------------- */

type Spot = [
  id: string,
  type: DeskWidget['type'],
  x: number,
  y: number,
  w: number,
  h: number,
  ref?: string,
  panel?: string,
];
const place = (spots: Spot[]): DeskWidget[] =>
  spots.map(([id, type, x, y, w, h, ref, panel]) => {
    const opts: Record<string, string> = panel ? { panel } : {};
    return { id, type, x, y, w, h, ...(ref ? { ref } : {}), opts };
  });

const page = (id: string, name: string, shape: string, spots: Spot[]): DeskPage => ({
  id,
  name,
  layouts: { [shape]: place(spots) },
  last: shape,
});

const S = {
  climate: ['w_climate', 'panel', 0, 0, 2, 2, HA, 'climate'] as Spot,
  outside: ['w_outside', 'panel', 0, 0, 2, 1, HA, 'outside'] as Spot,
  pve01: ['w_pve01', 'server', 0, 0, 2, 2, 'server:pve-01'] as Spot,
  internet: ['w_internet', 'figures', 0, 0, 2, 2, 'connection:con_unifi'] as Spot,
  playing: ['w_playing', 'panel', 0, 0, 4, 3, PLEX, 'now-playing'] as Spot,
  recent: ['w_recent', 'panel', 0, 0, 4, 2, PLEX, 'recently-added'] as Spot,
  library: ['w_library', 'figures', 0, 0, 4, 1, PLEX] as Spot,
  queue: ['w_queue', 'panel', 0, 0, 4, 2, 'connection:con_sabnzbd', 'queue'] as Spot,
  requests: ['w_requests', 'panel', 0, 0, 2, 2, SEERR, 'requests'] as Spot,
  episodes: ['w_episodes', 'panel', 0, 0, 2, 2, 'connection:con_sonarr', 'calendar'] as Spot,
  door: ['w_door', 'panel', 0, 0, 4, 3, HA, 'front-door'] as Spot,
  lights: ['w_lights', 'panel', 0, 0, 2, 3, HA, 'lights'] as Spot,
  blocked: ['w_blocked', 'figures', 0, 0, 2, 1, 'connection:con_pihole'] as Spot,
  today: ['w_today', 'panel', 0, 0, 4, 2, 'connection:con_gcal', 'today'] as Spot,
  backups: ['w_backups', 'figures', 0, 0, 2, 1, 'connection:con_pbs'] as Spot,
  storage: ['w_storage', 'panel', 0, 0, 2, 1, 'device:dev_nas', 'storage'] as Spot,
};
const at_ = (s: Spot, x: number, y: number, w: number, h: number): Spot => {
  const out = [...s] as Spot;
  out[2] = x;
  out[3] = y;
  out[4] = w;
  out[5] = h;
  return out;
};

/** The box's own screen (8 × 5): Overview, Media and House, as the mockups' `f-overview`, `f-media`, `f-house`. */
export const FIXTURE_BOX_LAYOUT: DeskLayout = {
  pages: [
    page('p_overview', 'Overview', '8x5', [
      ['w_clock', 'clock', 0, 0, 3, 2],
      ['w_status', 'status', 3, 0, 3, 2],
      at_(S.climate, 6, 0, 2, 2),
      ['w_now', 'now', 0, 2, 4, 2],
      at_(S.pve01, 4, 2, 2, 2),
      at_(S.internet, 6, 2, 2, 2),
      ['w_strip', 'strip', 0, 4, 8, 1],
    ]),
    page('p_media', 'Media', '8x5', [
      at_(S.playing, 0, 0, 4, 3),
      at_(S.queue, 4, 0, 4, 2),
      at_(S.requests, 4, 2, 2, 2),
      at_(S.episodes, 6, 2, 2, 2),
      at_(S.recent, 0, 3, 4, 2),
      at_(S.library, 4, 4, 4, 1),
    ]),
    page('p_house', 'House', '8x5', [
      at_(S.door, 0, 0, 4, 3),
      at_(S.lights, 4, 0, 2, 3),
      at_(S.climate, 6, 0, 2, 1),
      at_(S.outside, 6, 1, 2, 1),
      at_(S.blocked, 6, 2, 2, 1),
      at_(S.today, 0, 3, 4, 2),
      ['w_coming', 'coming', 4, 3, 2, 2],
      at_(S.backups, 6, 3, 2, 1),
      at_(S.storage, 6, 4, 2, 1),
    ]),
  ],
  turn: 'touch',
  size: 'normal',
};

/** The office monitor (12 × 7), turning every 30 seconds (`f-monitor`). */
export const FIXTURE_MONITOR_LAYOUT: DeskLayout = {
  pages: [
    page('p_overview', 'Overview', '12x7', [
      ['w_clock', 'clock', 0, 0, 3, 2],
      ['w_status', 'status', 3, 0, 3, 2],
      at_(S.climate, 6, 0, 2, 2),
      at_(S.internet, 8, 0, 4, 2),
      ['w_now', 'now', 0, 2, 6, 2],
      at_(S.playing, 6, 2, 3, 3),
      at_(S.queue, 9, 2, 3, 3),
      at_(S.pve01, 0, 4, 3, 2),
      at_(S.storage, 3, 4, 3, 2),
      at_(S.requests, 6, 5, 3, 1),
      at_(S.backups, 9, 5, 3, 1),
      ['w_strip', 'strip', 0, 6, 12, 1],
    ]),
    page('p_media', 'Media', '12x7', [
      at_(S.playing, 0, 0, 6, 4),
      at_(S.queue, 6, 0, 6, 4),
      at_(S.recent, 0, 4, 8, 3),
      at_(S.requests, 8, 4, 4, 3),
    ]),
  ],
  turn: '30s',
  size: 'normal',
};

/** The kitchen tablet (5 × 7, portrait), pages as dots (`f-tablet`). */
export const FIXTURE_TABLET_LAYOUT: DeskLayout = {
  pages: [
    page('p_kitchen', 'Kitchen', '5x7', [
      ['w_clock', 'clock', 0, 0, 5, 1],
      at_(S.door, 0, 1, 3, 2),
      at_(S.climate, 3, 1, 2, 1),
      at_(S.lights, 3, 2, 2, 1),
      at_(S.today, 0, 3, 5, 2),
      at_(S.playing, 0, 5, 3, 2),
      at_(S.episodes, 3, 5, 2, 2),
    ]),
    page('p_media', 'Media', '5x7', [
      at_(S.playing, 0, 0, 5, 3),
      at_(S.recent, 0, 3, 5, 2),
      at_(S.queue, 0, 5, 5, 2),
    ]),
  ],
  turn: 'touch',
  size: 'normal',
};

/* The calm glance ------------------------------------------------------------------------------------------------ */

const STRIP: ScreenCalm['strip'] = [
  { id: 'pve-01', name: 'pve-01', mark: 'proxmox', state: 'ok', spark: pct(1) },
  { id: 'pve-02', name: 'pve-02', mark: 'proxmox', state: 'ok', spark: pct(2) },
  { id: 'nas', name: 'nas', mark: 'synology', state: 'ok', spark: pct(3) },
  { id: 'blackbox', name: 'blackbox', mark: 'unraid', state: 'ok', spark: pct(4) },
  { id: 'the-falcon', name: 'the-falcon', mark: 'debian', state: 'ok', spark: pct(5) },
  { id: 'pi-hole', name: 'pi-hole', mark: 'raspberrypi', state: 'ok', spark: pct(6) },
  { id: 'media', name: 'media', mark: 'ubuntu', state: 'ok', spark: pct(7) },
  { id: 'backup-box', name: 'backup-box', mark: 'debian', state: 'off', say: 'off' },
];

export const FIXTURE_CALM: ScreenCalm = {
  headline: {
    tone: 'ok',
    text: 'All fine',
    more: '8 servers and 14 services are running. Nothing needs you.',
  },
  moments: [
    {
      key: 'connection:con_plex',
      kind: 'activity',
      name: 'Plex',
      mark: 'plex',
      value: '2 watching',
      detail: 'Dune: Part Two · The Bear',
    },
    {
      key: 'connection:con_sabnzbd',
      kind: 'activity',
      name: 'Downloads',
      mark: 'sabnzbd',
      value: '3 left · 20 min',
      progress: 62,
    },
    {
      key: 'coming',
      kind: 'coming',
      name: 'Coming up',
      value: 'Backups at 02:00',
      detail: 'pve-01, pve-02 and nas',
    },
  ],
  strip: STRIP,
  moreStrip: 0,
  doneCount: 3,
};

/** pve-02 not answering, the nas filling up: worst first in the strip. */
export const FIXTURE_CALM_WRONG: ScreenCalm = {
  headline: { tone: 'bad', text: '1 thing is wrong', more: 'pve-02 isn’t answering since 14:30.' },
  moments: [
    { key: 'coming', kind: 'coming', name: 'Coming up', value: 'Backups at 02:00', detail: 'pve-01 and nas' },
    {
      key: 'device:dev_frontdoor',
      kind: 'figure',
      name: 'Front door',
      mark: 'homeassistant',
      value: 'Locked',
      detail: 'since 08:12',
    },
  ],
  strip: [
    { ...(STRIP[1] as ScreenCalm['strip'][number]), state: 'bad', say: 'not answering', spark: undefined },
    { ...(STRIP[2] as ScreenCalm['strip'][number]), state: 'warn', say: 'disk 88 %', spark: undefined },
    ...STRIP.filter((x) => x.id !== 'pve-02' && x.id !== 'nas'),
  ],
  moreStrip: 0,
  doneCount: 3,
};

/* What needs the person ------------------------------------------------------------------------------------------ */

export const FIXTURE_OUTAGE = {
  key: 'look:server:pve-02',
  kind: 'look',
  tone: 'bad',
  pops: true,
  title: 'pve-02 isn’t answering',
  detail: 'Plex, SABnzbd and Seerr run on it, so they’re down too.',
  since: '2026-10-27T13:30:00Z',
  name: 'pve-02',
  look: 'server:pve-02',
  server: 'pve-02',
} as const satisfies DeskAttention['items'][number];

export const FIXTURE_QUESTION = {
  key: 'ask:41',
  kind: 'ask',
  tone: 'bad',
  pops: true,
  title: 'Send this reply to Bakkerij de Vries?',
  detail: '“Hi Marieke, the order form works again. Your three orders from this morning came through fine.”',
  since: '2026-10-27T13:33:00Z',
  ask: 41,
} as const satisfies DeskAttention['items'][number];

/** A smaller thing: only in the pill's list, it never opens the modal. */
export const FIXTURE_DISK = {
  key: 'look:device:dev_nas',
  kind: 'look',
  tone: 'warn',
  pops: false,
  title: 'nas is 88 % full',
  detail: 'At this rate it’s full in about 12 days.',
  name: 'nas',
  look: 'device:dev_nas',
} as const satisfies DeskAttention['items'][number];

export const FIXTURE_ATTENTION_NONE: DeskAttention = { items: [], more: 0 };
export const FIXTURE_ATTENTION: DeskAttention = {
  items: [FIXTURE_OUTAGE, FIXTURE_QUESTION],
  more: 0,
  tone: 'bad',
};

/* The screens' grids --------------------------------------------------------------------------------------------- */

const views = (layout: DeskLayout, all: DeskWidgetView[]) => {
  const ids = new Set(
    layout.pages.flatMap((p) =>
      Object.values(p.layouts)
        .flat()
        .map((w) => w.id),
    ),
  );
  return all.filter((v) => ids.has(v.id));
};

/** The box's own screen, all fine. */
export const FIXTURE_BOX_GRID: DeskGrid = {
  screen: 'box',
  layout: FIXTURE_BOX_LAYOUT,
  views: views(FIXTURE_BOX_LAYOUT, FIXTURE_VIEWS),
  attention: FIXTURE_ATTENTION_NONE,
  popups: 'all',
};

/** The box's own screen with pve-02 down and a question waiting (`f-problem`, `f-ask`, `f-notnow`). */
export const FIXTURE_BOX_GRID_WRONG: DeskGrid = {
  ...FIXTURE_BOX_GRID,
  views: views(FIXTURE_BOX_LAYOUT, FIXTURE_VIEWS_WRONG),
  attention: FIXTURE_ATTENTION,
};

export const FIXTURE_MONITOR_GRID: DeskGrid = {
  screen: 'out_hdmi-a-2',
  layout: FIXTURE_MONITOR_LAYOUT,
  views: views(FIXTURE_MONITOR_LAYOUT, FIXTURE_VIEWS),
  attention: FIXTURE_ATTENTION_NONE,
  popups: 'problems',
};

export const FIXTURE_TABLET_GRID: DeskGrid = {
  screen: 'scr_kitchen-tablet',
  layout: FIXTURE_TABLET_LAYOUT,
  views: views(FIXTURE_TABLET_LAYOUT, FIXTURE_VIEWS),
  attention: FIXTURE_ATTENTION_NONE,
  popups: 'none',
};

/** Every kind and form the box's pages don't show, on one page (the shots' `f-kinds`, the web app's fixture mode). */
export const FIXTURE_KINDS_LAYOUT: DeskLayout = {
  pages: [
    page('p_kinds', 'Every kind', '8x5', [
      ['w_power', 'panel', 0, 0, 4, 2, HA, 'power'],
      ['w_note', 'widget', 4, 0, 2, 2, 'widget:wdg_note'],
      ['w_done', 'done', 6, 0, 2, 2],
      ['w_work', 'work', 0, 2, 4, 1],
      ['w_coming', 'coming', 4, 2, 2, 1],
      at_(S.blocked, 6, 2, 1, 1),
      at_(S.outside, 7, 2, 1, 1),
      at_(S.climate, 0, 3, 4, 2),
      at_(S.pve01, 4, 3, 2, 1),
      at_(S.lights, 6, 3, 2, 1),
      at_(S.queue, 4, 4, 2, 1),
      at_(S.playing, 6, 4, 2, 1),
    ]),
  ],
  turn: 'touch',
  size: 'normal',
};

export const FIXTURE_KINDS_GRID: DeskGrid = {
  screen: 'box',
  layout: FIXTURE_KINDS_LAYOUT,
  views: views(FIXTURE_KINDS_LAYOUT, FIXTURE_VIEWS),
  attention: FIXTURE_ATTENTION_NONE,
  popups: 'all',
};
