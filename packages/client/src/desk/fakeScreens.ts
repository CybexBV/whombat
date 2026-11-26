/**
 * The screens of a fake box (3.6; Whombat desk-display.md DK-126…DK-149): the mockups' world as Settings → Screens and
 * the editor see it — the box's own screen with *Overview*, *Media* and *House*, an office monitor and a kitchen tablet
 * elsewhere — with *Add a widget*'s groups and every widget's view as the runtime resolves them. For the web's fixture
 * mode, the managed fake world, the phone's demo world and tests. Pure data and small functions; `fake.ts` keeps the
 * state.
 */

import {
  SERVER_SHOW_VIEWS,
  SERVER_SHOW_WORDS,
  SERVER_SHOWS,
  type ServerShow,
  serverShow,
} from '@whombat/screen';
import { FIXTURE_NEWS, FIXTURE_WEATHER } from '@whombat/screen/fixtures';
import {
  DESK_SCREEN_WORDS,
  type DeskCatalog,
  type DeskCatalogGroup,
  type DeskCatalogItem,
  type DeskLayout,
  type DeskPage,
  type DeskPopups,
  type DeskScreenKind,
  type DeskScreenSize,
  type DeskWidget,
  type DeskWidgetSpec,
  type DeskWidgetView,
  fillDeskWords,
} from './contract';
import { FAKE_ACCOUNT_GROUPS, fakeAccountView } from './fakeAccounts';
import type { FakeDeskWorld } from './fakeWorld';

/** A screen as the fake keeps it. */
export interface FakeScreen {
  id: string;
  kind: DeskScreenKind;
  name: string;
  popups: DeskPopups;
  size: DeskScreenSize | null;
  layout: DeskLayout;
  online: boolean;
  lastSeenAt: string | null;
  device?: string;
  /** A device's endpoint (the fake's own id), so `screen.*` knows which screen asks. */
  endpoint?: string;
  /** When the doorbell rings; `big` unless chosen. */
  doorbell?: 'big' | 'off';
}

type Place = [
  type: DeskWidget['type'],
  x: number,
  y: number,
  w: number,
  h: number,
  ref?: string,
  panel?: string,
];

/** A page from its widgets' places; a widget's id is its page's and its place's, unique on the screen. */
function page(id: string, name: string, shape: string, places: readonly Place[]): DeskPage {
  const widgets = places.map(([type, x, y, w, h, ref, panel], i): DeskWidget => {
    return {
      id: `w_${id.slice(2)}${i}`,
      type,
      ...(ref ? { ref } : {}),
      opts: panel ? { panel } : {},
      x,
      y,
      w,
      h,
    };
  });
  return { id, name, layouts: { [shape]: widgets }, last: shape };
}

const PLEX = 'connection:con_plex';
const SAB = 'connection:con_sab';
const SEERR = 'connection:con_seerr';
const SONARR = 'connection:con_sonarr';
const HA = 'connection:con_ha';
/** The fake world's doorbell: Home Assistant's front door camera, as a ring takes over a screen with it. */
export const FAKE_DOORBELL_WIDGET = {
  id: 'w_spotlight',
  type: 'panel' as const,
  ref: HA,
  opts: { panel: 'front-door' },
};
const UNIFI = 'connection:con_unifi';
const PIHOLE = 'connection:con_pihole';
const SYNOLOGY = 'connection:con_synology';
const PBS = 'connection:con_pbs';
const CALENDAR = 'connection:con_calendar';
const IMMICH = 'connection:con_immich';
const PORTAINER = 'connection:con_portainer';
const LIVING = 'widget:wdg_living';

/** The box's own screen: the mockups' three pages on the Z13's 8 × 5. */
export function fakeBoxLayout(): DeskLayout {
  return {
    pages: [
      page('p_first', 'Overview', '8x5', [
        ['clock', 0, 0, 3, 2],
        ['status', 3, 0, 3, 2],
        ['widget', 6, 0, 2, 2, LIVING],
        ['now', 0, 2, 4, 2],
        ['server', 4, 2, 2, 2, 'server:pve-01'],
        ['panel', 6, 2, 2, 2, UNIFI, 'internet'],
        ['strip', 0, 4, 8, 1],
      ]),
      page('p_media', 'Media', '8x5', [
        ['panel', 0, 0, 4, 3, PLEX, 'now-playing'],
        ['panel', 4, 0, 4, 2, SAB, 'queue'],
        ['panel', 4, 2, 2, 2, SEERR, 'requests'],
        ['panel', 6, 2, 2, 2, SONARR, 'upcoming'],
        ['panel', 0, 3, 4, 2, PLEX, 'recent'],
        ['panel', 4, 4, 4, 1, PLEX, 'library'],
      ]),
      page('p_house', 'House', '8x5', [
        ['panel', 0, 0, 4, 3, HA, 'front-door'],
        ['panel', 4, 0, 2, 3, HA, 'lights'],
        ['widget', 6, 0, 2, 1, LIVING],
        ['panel', 6, 1, 2, 1, HA, 'outside'],
        ['panel', 6, 2, 2, 1, PIHOLE, 'blocked'],
        ['panel', 0, 3, 4, 2, CALENDAR, 'today'],
        ['coming', 4, 3, 2, 2],
        ['panel', 6, 3, 2, 1, PBS, 'backups'],
        ['panel', 6, 4, 2, 1, SYNOLOGY, 'storage'],
      ]),
    ],
    turn: 'touch',
    size: 'normal',
  };
}

/** The office monitor (a computer by a 24″ 1080p monitor): 12 × 7, two pages turning every 30 seconds. */
export function fakeOfficeLayout(): DeskLayout {
  return {
    pages: [
      page('p_office', 'Overview', '12x7', [
        ['clock', 0, 0, 3, 2],
        ['status', 3, 0, 3, 2],
        ['widget', 6, 0, 2, 2, LIVING],
        ['panel', 8, 0, 4, 2, UNIFI, 'internet'],
        ['now', 0, 2, 6, 2],
        ['panel', 6, 2, 3, 3, PLEX, 'now-playing'],
        ['panel', 9, 2, 3, 3, SAB, 'queue'],
        ['server', 0, 4, 3, 2, 'server:pve-01'],
        ['panel', 3, 4, 3, 2, SYNOLOGY, 'storage'],
        ['panel', 6, 5, 3, 1, SEERR, 'requests'],
        ['panel', 9, 5, 3, 1, PBS, 'backups'],
        ['strip', 0, 6, 12, 1],
      ]),
      page('p_omedia', 'Media', '12x7', [
        ['panel', 0, 0, 6, 4, PLEX, 'now-playing'],
        ['panel', 6, 0, 6, 3, PLEX, 'recent'],
        ['panel', 6, 3, 6, 2, SAB, 'queue'],
        ['panel', 0, 4, 3, 3, SONARR, 'upcoming'],
        ['panel', 3, 4, 3, 3, SEERR, 'requests'],
      ]),
    ],
    turn: '30s',
    size: 'normal',
  };
}

/** The kitchen tablet (an iPad, portrait): 5 × 7, the house first. */
export function fakeKitchenLayout(): DeskLayout {
  return {
    pages: [
      page('p_kitchen', 'Kitchen', '5x7', [
        ['clock', 0, 0, 5, 1],
        ['panel', 0, 1, 3, 2, HA, 'front-door'],
        ['widget', 3, 1, 2, 1, LIVING],
        ['panel', 3, 2, 2, 1, HA, 'lights'],
        ['panel', 0, 3, 5, 2, CALENDAR, 'today'],
        ['panel', 0, 5, 3, 2, PLEX, 'now-playing'],
        ['panel', 3, 5, 2, 2, SONARR, 'upcoming'],
      ]),
      page('p_kmedia', 'Media', '5x7', [
        ['panel', 0, 0, 5, 3, PLEX, 'recent'],
        ['panel', 0, 3, 5, 2, SAB, 'queue'],
        ['panel', 0, 5, 5, 2, SEERR, 'requests'],
      ]),
    ],
    turn: 'touch',
    size: 'normal',
  };
}

/** The screens a fake 3.6 box starts with, `now` the clock's. */
export function fakeScreensSeed(now: number): FakeScreen[] {
  const seen = new Date(now - 20_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return [
    {
      id: 'box',
      kind: 'box',
      name: DESK_SCREEN_WORDS.box,
      popups: 'all',
      size: { width: 1280, height: 800 },
      layout: fakeBoxLayout(),
      online: true,
      lastSeenAt: seen,
    },
    {
      id: 'scr_office01',
      kind: 'device',
      name: 'Office monitor',
      popups: 'problems',
      size: { width: 1920, height: 1080 },
      layout: fakeOfficeLayout(),
      online: true,
      lastSeenAt: seen,
      device: 'Mac mini · Safari',
      endpoint: 'end_office',
    },
    {
      id: 'scr_kitchen1',
      kind: 'device',
      name: 'Kitchen tablet',
      popups: 'none',
      size: { width: 820, height: 1180 },
      layout: fakeKitchenLayout(),
      online: true,
      lastSeenAt: seen,
      device: 'iPad · Safari',
      endpoint: 'end_kitchen',
    },
  ];
}

/* Add a widget ---------------------------------------------------------------------------------------------------- */

type PanelDef = { id: string; name: string; line: string; view: NonNullable<DeskCatalogItem['view']> };
type ThingDef = {
  ref: string;
  label: string;
  mark?: string;
  panels: PanelDef[];
  partial?: boolean;
};

/** The fake's connections with their pages' panels, designed pages first (as the runtime orders them). */
const THINGS: readonly ThingDef[] = [
  {
    ref: PLEX,
    label: 'Plex',
    mark: 'plex',
    panels: [
      {
        id: 'now-playing',
        name: 'Now playing',
        line: 'Who’s watching what, and how far along',
        view: 'posters',
      },
      { id: 'recent', name: 'Recently added', line: 'The newest films and episodes', view: 'posters' },
      { id: 'library', name: 'Library', line: 'Films, shows and episodes', view: 'figures' },
    ],
  },
  {
    ref: SAB,
    label: 'SABnzbd',
    mark: 'sabnzbd',
    panels: [
      { id: 'queue', name: 'Download queue', line: 'What’s downloading and the time left', view: 'list' },
    ],
  },
  {
    ref: SEERR,
    label: 'Seerr',
    mark: 'overseerr',
    panels: [{ id: 'requests', name: 'Requests', line: 'New requests waiting for a yes', view: 'list' }],
  },
  {
    ref: SONARR,
    label: 'Sonarr',
    mark: 'sonarr',
    panels: [{ id: 'upcoming', name: 'Coming up', line: 'Episodes airing this week', view: 'list' }],
  },
  {
    ref: HA,
    label: 'Home Assistant',
    mark: 'homeassistant',
    panels: [
      { id: 'living-room', name: 'Living room', line: 'Temperature over the day', view: 'chart' },
      { id: 'outside', name: 'Outside', line: 'Temperature and humidity', view: 'figures' },
      { id: 'lights', name: 'Lights', line: 'Which lights are on', view: 'list' },
      { id: 'front-door', name: 'Front door', line: 'The camera’s latest picture', view: 'camera' },
    ],
  },
  {
    ref: UNIFI,
    label: 'UniFi',
    mark: 'unifi_network',
    panels: [
      { id: 'internet', name: 'Internet', line: 'Speed now and over the day', view: 'chart' },
      {
        id: 'all-devices',
        name: 'All network devices',
        line: 'Every access point, switch and gateway, online or not',
        view: 'board',
      },
    ],
  },
  {
    ref: PORTAINER,
    label: 'Portainer',
    mark: 'portainer',
    panels: [
      {
        id: 'all-containers',
        name: 'All containers',
        line: 'Every container, green when it runs',
        view: 'board',
      },
    ],
  },
  {
    ref: IMMICH,
    label: 'Immich',
    mark: 'immich',
    panels: [
      {
        id: 'memories-photo',
        name: 'A photo from this day',
        line: 'One big photo at a time from this day in earlier years',
        view: 'photo',
      },
      {
        id: 'favourites-photo',
        name: 'Favourite photos',
        line: 'Your favourites in Immich, one big photo at a time',
        view: 'photo',
      },
    ],
  },
  {
    ref: PIHOLE,
    label: 'Pi-hole',
    mark: 'pihole',
    panels: [{ id: 'blocked', name: 'Blocked today', line: 'Ads and trackers stopped', view: 'figures' }],
  },
  {
    ref: SYNOLOGY,
    label: 'Synology',
    mark: 'synology',
    panels: [{ id: 'storage', name: 'Storage', line: 'How full each volume is', view: 'list' }],
  },
  {
    ref: PBS,
    label: 'Proxmox Backup Server',
    mark: 'proxmox_backup',
    panels: [{ id: 'backups', name: 'Backups', line: 'Last night’s backups', view: 'list' }],
  },
  {
    ref: CALENDAR,
    label: 'Family calendar',
    panels: [{ id: 'today', name: 'Today', line: 'Today’s appointments', view: 'list' }],
    // Its page wasn't read in time: a widget's *What it shows* asks for the rest.
    partial: true,
  },
];

const own = (assistant: string) => (s: string) => fillDeskWords(s, { assistant });

/** A thing's group: its figures and its panels; a partial one lists its figures until asked alone. */
function thingGroup(t: ThingDef, whole: boolean): DeskCatalogGroup {
  const figures: DeskCatalogItem = {
    type: 'figures',
    ref: t.ref,
    opts: {},
    name: DESK_SCREEN_WORDS.figures.name,
    line: DESK_SCREEN_WORDS.figures.line,
    ...(t.mark ? { mark: t.mark } : {}),
    view: 'figures',
  };
  const panels = t.partial && !whole ? [] : t.panels;
  return {
    key: t.ref,
    label: t.label,
    ...(t.mark ? { mark: t.mark } : {}),
    thing: t.ref,
    items: [
      figures,
      ...panels.map(
        (p): DeskCatalogItem => ({
          type: 'panel',
          ref: t.ref,
          opts: { panel: p.id },
          name: p.name,
          line: p.line,
          ...(t.mark ? { mark: t.mark } : {}),
          view: p.view,
        }),
      ),
    ],
    ...(t.partial && !whole ? { partial: true } : {}),
  };
}

type FakeServer = FakeDeskWorld['servers'][number];

/** A server's part as the runtime draws it (`server-parts.ts`), from the fake's figures. */
function fakeServerPart(
  id: string,
  s: FakeServer,
  show: Exclude<ServerShow, 'overview'>,
  down: boolean,
): DeskWidgetView {
  const base = {
    id,
    title: SERVER_SHOW_WORDS[show].name,
    name: s.name,
    ...(s.mark ? { mark: s.mark } : {}),
    tone: down ? ('bad' as const) : s.state,
  };
  if (s.state === 'off') return { kind: 'text', ...base, tone: 'off', body: 'It’s switched off.' };
  const line = (s.spark ?? []).map((v) => Math.max(0, Math.min(100, Math.round(v))));
  const shifted = (by: number) => line.map((v) => Math.max(0, Math.min(100, v + by)));
  switch (show) {
    case 'cpu':
      return {
        kind: 'chart',
        ...base,
        figure: { value: `${s.cpu ?? 0} %`, rest: 'of 16 cores · load 1.2' },
        series: [{ points: line, tone: 'ok' }],
        unit: '%',
        stats: ['Last 24 hours · Avg 14 % · Peak 63 % Sun 03:10'],
      };
    case 'memory':
      return {
        kind: 'chart',
        ...base,
        figure: { value: `${s.memory ?? 0} %`, rest: '26.2 GB of 64 GB' },
        series: [{ points: shifted(30), tone: 'ok' }],
        unit: '%',
        stats: ['Last 24 hours · Avg 43 %'],
      };
    case 'network':
      return {
        kind: 'chart',
        ...base,
        figure: { value: '↓ 12.4 MB/s', rest: '↑ 1.2 MB/s' },
        series: [
          { label: 'In', points: shifted(40) },
          { label: 'Out', points: line },
        ],
        unit: 'Mb/s',
        stats: ['Last 24 hours'],
      };
    case 'storage':
      return {
        kind: 'list',
        ...base,
        head: '1.3 of 3.6 TB used',
        progress: s.disk ?? 0,
        rows: [
          { title: 'vmdata', detail: 'zfs · 3.2 of 3.8 TB', meta: '83 %', progress: 83 },
          { title: 'backups', detail: 'backup server · 1.4 of 2 TB', meta: '70 %', progress: 70 },
          { title: 'local', detail: 'folder · 44 of 100 GB', meta: '44 %', progress: 44 },
          { title: 'local-zfs', detail: 'zfs · 79 of 980 GB', meta: '8 %', progress: 8 },
        ],
      };
    case 'guests':
      return {
        kind: 'list',
        ...base,
        head: '9 running · 1 off',
        rows: [
          { title: 'plex', detail: 'Container', state: 'on', meta: '23 %', tone: 'ok' },
          { title: 'homeassistant', detail: 'VM', state: 'on', meta: '6 %', tone: 'ok' },
          { title: 'k3s-node-1', detail: 'VM', state: 'on', meta: '4 %', tone: 'ok' },
          { title: 'pihole', detail: 'Container', state: 'on', meta: '1 %', tone: 'ok' },
          { title: 'win-build', detail: 'VM', state: 'off', meta: 'off' },
        ],
        count: 10,
      };
    case 'temp':
      return {
        kind: 'figures',
        ...base,
        items: [
          { value: '54', unit: '°C', label: 'CPU package' },
          { value: '41', unit: '°C', label: 'NVMe' },
          { value: '38', unit: '°C', label: 'Board' },
        ],
        progress: 64,
        line: 'CPU package · hot from 85 °C',
      };
    case 'alerts':
      return down
        ? {
            kind: 'list',
            ...base,
            rows: [{ title: 'Not answering since 14:02', tone: 'bad', time: '14:02' }],
          }
        : { kind: 'list', ...base, rows: [], empty: 'Nothing’s wrong with it right now.' };
  }
}

/**
 * `desk.widgets`: Whombat's own, each server, the things, the person's accounts, the assistant's Home widgets; with
 * `thing`, that one.
 */
export function fakeCatalog(world: FakeDeskWorld, thing?: string): DeskCatalog {
  if (thing) {
    const t = THINGS.find((x) => x.ref === thing);
    const account = FAKE_ACCOUNT_GROUPS.find((g) => g.key === thing);
    return { groups: t ? [thingGroup(t, true)] : account ? [account] : [] };
  }
  const fill = own(world.assistant);
  const w = DESK_SCREEN_WORDS;
  return {
    groups: [
      {
        key: 'own',
        label: fill(w.groups.own),
        items: (
          ['clock', 'status', 'now', 'strip', 'work', 'coming', 'done', 'weather', 'news'] as const
        ).map((type) => ({
          type,
          opts: {},
          name: fill(w.own[type].name),
          line: fill(w.own[type].line),
          // The weather draws its own view and the news a list, as the runtime says.
          ...(type === 'weather'
            ? { view: 'weather' as const }
            : type === 'news'
              ? { view: 'list' as const }
              : {}),
        })),
      },
      // A group per server, with its overview and its parts (DK-153, DK-154).
      ...world.servers.map((s) => ({
        key: `server:${s.id}`,
        label: s.name,
        ...(s.mark ? { mark: s.mark } : {}),
        items: SERVER_SHOWS.filter((show) => show !== 'guests' || s.mark === 'proxmox').map((show) => ({
          type: 'server' as const,
          ref: `server:${s.id}`,
          opts: show === 'overview' ? {} : ({ show } as Record<string, string>),
          name: SERVER_SHOW_WORDS[show].name,
          line: show === 'overview' ? s.line : SERVER_SHOW_WORDS[show].line,
          ...(s.mark ? { mark: s.mark } : {}),
          view: SERVER_SHOW_VIEWS[show],
          ...(show === 'alerts' ? { private: true } : {}),
        })),
      })),
      ...THINGS.map((t) => thingGroup(t, false)),
      ...FAKE_ACCOUNT_GROUPS,
      {
        key: 'widgets',
        label: fill(w.groups.widgets),
        items: world.widgets.map((x) => ({
          type: 'widget' as const,
          ref: x.key,
          opts: {},
          name: x.name,
          line: x.value ?? '',
          ...(x.mark ? { mark: x.mark } : {}),
          view: 'figures' as const,
        })),
      },
    ],
  };
}

/* The views ------------------------------------------------------------------------------------------------------- */

const wave = (n: number, base: number, amp: number, seed: number) =>
  Array.from(
    { length: n },
    (_, i) => Math.round((base + amp * Math.sin((i + seed) / 4) + ((i * (seed + 3)) % 4) - 2) * 10) / 10,
  );

const thingOf = (ref: string | undefined) => THINGS.find((t) => t.ref === ref);

/** What a panel shows in the fake (the mockups' words). */
function panelView(id: string, t: ThingDef, panel: string): DeskWidgetView | null {
  const base = { id, name: t.label, ...(t.mark ? { mark: t.mark } : {}) };
  switch (`${t.ref}#${panel}`) {
    case `${PLEX}#now-playing`:
      return {
        ...base,
        kind: 'posters',
        title: 'Now playing',
        head: '2 watching',
        shape: 'poster',
        items: [
          {
            title: 'Dune: Part Two',
            detail: 'Film · 2024',
            who: 'John · Living room TV',
            progress: 64,
            time: '1:42 of 2:46',
          },
          {
            title: 'The Bear',
            detail: 'S3 · E4 “Violet”',
            who: 'Sanne · iPad',
            progress: 22,
            time: '0:07 of 0:31',
          },
        ],
      };
    case `${PLEX}#recent`:
      return {
        ...base,
        kind: 'posters',
        title: 'Recently added',
        shape: 'poster',
        items: ['Civil War', 'Shōgun', 'Inside Out 2', 'Furiosa', 'Fallout', 'Slow Horses'].map((title) => ({
          title,
        })),
      };
    case `${PLEX}#library`:
      return {
        ...base,
        kind: 'figures',
        title: 'Library',
        items: [
          { value: '812', label: 'Films' },
          { value: '146', label: 'Shows' },
          { value: '9,204', label: 'Episodes' },
        ],
      };
    case `${SAB}#queue`:
      return {
        ...base,
        kind: 'list',
        title: 'Downloads',
        head: '3 left · about 20 min',
        progress: 62,
        rows: [
          { title: 'Shōgun S01', detail: '4.2 GB', progress: 71 },
          { title: 'Civil War', detail: '12.8 GB', progress: 38 },
          { title: 'The Bear S03E05', detail: '1.1 GB', progress: 0 },
        ],
      };
    case `${SEERR}#requests`:
      return {
        ...base,
        kind: 'list',
        title: 'Requests',
        head: '2 new',
        rows: [
          { title: 'Inside Out 2', detail: 'Sanne · film', time: '12:10' },
          { title: 'Slow Horses S4', detail: 'Tom · show', time: '09:44' },
        ],
      };
    case `${SONARR}#upcoming`:
      return {
        ...base,
        kind: 'list',
        title: 'Coming up',
        rows: [
          { time: '21:00', title: 'The Bear', detail: 'S3 E5 · tonight' },
          { time: 'Thu', title: 'Shōgun', detail: 'S1 E9' },
          { time: 'Fri', title: 'Slow Horses', detail: 'S4 E3' },
          { time: 'Sun', title: 'Fallout', detail: 'S2 E1' },
        ],
      };
    case `${HA}#living-room`:
      return {
        ...base,
        kind: 'chart',
        title: 'Living room',
        figure: { value: '21.4 °C', rest: '48 %' },
        series: [{ points: wave(48, 21, 1.2, 2) }],
        unit: '°C',
        stats: ['Today 19.8 – 22.1 °C'],
      };
    case `${HA}#outside`:
      return {
        ...base,
        kind: 'figures',
        title: 'Outside',
        items: [
          { value: '11.8', unit: '°C', label: 'Temperature' },
          { value: '81', unit: '%', label: 'Humidity' },
        ],
      };
    case `${HA}#lights`:
      return {
        ...base,
        kind: 'list',
        title: 'Lights',
        head: '2 on',
        rows: [
          { title: 'Living room', state: 'on' },
          { title: 'Kitchen', state: 'on' },
          { title: 'Hallway', state: 'off' },
          { title: 'Garden', state: 'off' },
        ],
      };
    case `${HA}#front-door`:
      return { ...base, kind: 'camera', title: 'Front door', event: 'Someone at the door · 14:21' };
    case `${UNIFI}#internet`:
      return {
        ...base,
        kind: 'chart',
        title: 'Internet',
        tone: 'ok',
        figure: { value: '942 ↓ 48 ↑', rest: 'Mbps · 174 devices' },
        series: [{ points: wave(48, 420, 260, 5) }],
        unit: 'Mbps',
      };
    case `${UNIFI}#all-devices`:
      return {
        ...base,
        kind: 'board',
        title: 'All network devices',
        head: '1 offline',
        items: [
          { label: 'Garden AP', tone: 'bad', value: 'Offline' },
          { label: 'Kitchen AP', tone: 'warn', value: 'Update' },
          ...['Gateway', 'Office switch', 'Living room AP', 'Attic AP', 'Garage switch'].map((label) => ({
            label,
            tone: 'ok' as const,
          })),
        ],
      };
    case `${PORTAINER}#all-containers`:
      return {
        ...base,
        kind: 'board',
        title: 'All containers',
        head: '24 containers',
        items: [
          { label: 'grafana', tone: 'bad', value: 'Unhealthy' },
          { label: 'immich-ml', tone: 'warn', value: 'Restarting' },
          { label: 'backup-box', tone: 'off', value: 'Stopped' },
          ...[
            'plex',
            'sonarr',
            'radarr',
            'sabnzbd',
            'seerr',
            'homeassistant',
            'mosquitto',
            'zigbee2mqtt',
            'esphome',
            'pihole',
            'unifi',
            'nextcloud-app',
            'nextcloud-db',
            'immich-server',
            'immich-db',
            'paperless',
            'portainer',
            'traefik',
            'uptime-kuma',
            'vaultwarden',
            'prometheus',
          ].map((label) => ({ label, tone: 'ok' as const })),
        ],
      };
    case `${IMMICH}#memories-photo`:
    case `${IMMICH}#favourites-photo`: {
      const day = panel === 'memories-photo';
      const photo = (n: number, caption: string, time?: string) => ({
        image: {
          thing: IMMICH,
          ref: `ZmFrZS1waG90by0${n}.c2lnbmF0dXJl`,
          shape: 'square' as const,
          alt: caption,
        },
        caption,
        ...(time ? { time } : {}),
      });
      return {
        ...base,
        kind: 'photo',
        title: day ? 'A photo from this day' : 'Favourite photos',
        items: day
          ? [photo(1, '3 years ago · Texel', '2023'), photo(2, '6 years ago', '2020')]
          : [photo(3, 'Texel', 'June 2019'), photo(4, 'December 2024'), photo(5, 'Utrecht', 'May 2022')],
      };
    }
    case `${PIHOLE}#blocked`:
      return {
        ...base,
        kind: 'figures',
        title: 'Blocked today',
        items: [{ value: '18 %', label: '4,210 of 23,400 asked' }],
      };
    case `${SYNOLOGY}#storage`:
      return {
        ...base,
        kind: 'list',
        title: 'Storage',
        rows: [
          { title: 'Volume 1', detail: '7.1 of 8 TB', progress: 88, tone: 'warn' },
          { title: 'Volume 2', detail: '1.2 of 4 TB', progress: 30 },
        ],
      };
    case `${PBS}#backups`:
      return {
        ...base,
        kind: 'list',
        title: 'Backups',
        head: 'All 14 fine last night',
        rows: [{ title: 'pve-01', detail: '9 guests', time: '03:10' }],
      };
    case `${CALENDAR}#today`:
      return {
        ...base,
        kind: 'list',
        title: 'Today',
        rows: [
          { time: '15:30', title: 'Dentist', detail: 'Sanne' },
          { time: '18:00', title: 'Football training', detail: 'Tom' },
          { time: '19:30', title: 'Dinner at Marco’s', detail: 'everyone' },
          { time: 'Wed', title: 'Bins out', detail: 'tomorrow morning' },
        ],
      };
    default:
      return null;
  }
}

/**
 * Each widget's view as the fake runtime resolves it (DK-142): Whombat's own *work*, *Coming up* and *Done today*
 * (the clock, *How things are*, *What’s going on* and *Servers* read the calm glance), a server, a thing's figures or
 * panel, a Home widget; something gone is a `text` view with a `problem`.
 */
export function fakeViews(
  world: FakeDeskWorld,
  specs: readonly DeskWidgetSpec[],
  scenario: 'now' | 'wrong' | 'busy' = 'now',
): DeskWidgetView[] {
  const out: DeskWidgetView[] = [];
  const gone = (id: string, title: string, text: string): DeskWidgetView => ({
    id,
    kind: 'text',
    title,
    body: text,
    problem: { text },
    tone: 'bad',
  });
  for (const w of specs) {
    if ((w.type === 'figures' || w.type === 'panel') && w.ref?.startsWith('account:')) {
      out.push(fakeAccountView(w) ?? gone(w.id, 'Account', 'This account isn’t connected any more.'));
      continue;
    }
    switch (w.type) {
      case 'work':
        out.push({
          id: w.id,
          kind: 'list',
          title: `${world.assistant}’s work`,
          ...(scenario === 'busy'
            ? {
                head: 'Updating the servers',
                progress: 50,
                rows: [
                  { title: 'pve-01', detail: 'Done', state: 'on' as const },
                  { title: 'pve-02', detail: 'Done', state: 'on' as const },
                  { title: 'nas', detail: 'Now', progress: 40 },
                  { title: 'blackbox', detail: 'Next' },
                ],
              }
            : { rows: [], empty: `${world.assistant} isn’t working on anything now.` }),
        });
        break;
      case 'coming':
        out.push({
          id: w.id,
          kind: 'list',
          title: 'Coming up',
          rows: [
            { time: '18:00', title: 'Check the backups' },
            { time: '03:00', title: 'Back up pve-01' },
            { time: 'Thu', title: 'Update the servers' },
          ],
        });
        break;
      case 'done':
        out.push({
          id: w.id,
          kind: 'list',
          title: `${world.assistant} did ${world.doneCount} things today`,
          count: world.doneCount,
          rows: [
            { time: '13:05', title: 'Updated the-falcon and restarted it', state: 'on' },
            { time: '12:41', title: 'Renewed the certificate on pve-01', state: 'on' },
            { time: '11:20', title: 'Answered Bakkerij de Vries', state: 'on' },
          ],
        });
        break;
      case 'weather':
        // MET Norway's forecast for Amsterdam (Whombat weather-news.md); not read while things are wrong.
        out.push(
          scenario === 'wrong'
            ? {
                ...FIXTURE_WEATHER,
                id: w.id,
                now: undefined,
                today: undefined,
                hours: [],
                days: [],
                tone: 'bad',
                problem: { text: 'Can’t read the weather just now' },
              }
            : { ...FIXTURE_WEATHER, id: w.id },
        );
        break;
      case 'news':
        // Headlines from the sites turned on in Settings → This Whombat.
        out.push({ ...FIXTURE_NEWS, id: w.id });
        break;
      case 'server': {
        const id = w.ref?.slice('server:'.length) ?? '';
        const s = world.servers.find((x) => x.id === id);
        if (!s) {
          out.push(gone(w.id, id || 'Server', 'This server isn’t in Whombat any more.'));
          break;
        }
        const down = scenario === 'wrong' && s.id === world.servers[0]?.id;
        const show = serverShow(w.opts);
        if (show !== 'overview') {
          out.push(fakeServerPart(w.id, s, show, down));
          break;
        }
        out.push({
          id: w.id,
          kind: 'server',
          title: s.name,
          ...(s.mark ? { mark: s.mark } : {}),
          line: s.line,
          server: s.id,
          state: down ? 'bad' : s.state,
          ...(down ? { say: 'Not answering', tone: 'bad' as const } : {}),
          ...(s.state === 'off' || down
            ? {}
            : {
                cpu: s.cpu ?? 0,
                memory: s.memory ?? 0,
                disk: s.disk ?? 0,
                spark: (s.spark ?? []).map((v) => Math.max(0, Math.min(100, Math.round(v)))),
                range: (w.opts.range as '1h' | '24h' | '7d' | undefined) ?? '24h',
                stats: ['Avg 14 % · Peak 63 % Sun 03:10'],
                uptime: 'Up 23 days',
              }),
        });
        break;
      }
      case 'widget': {
        const x = world.widgets.find((y) => y.key === w.ref);
        if (!x) {
          out.push(gone(w.id, 'Widget', 'This widget isn’t on Home any more.'));
          break;
        }
        out.push({
          id: w.id,
          kind: 'figures',
          title: x.name,
          ...(x.mark ? { mark: x.mark } : {}),
          items: [
            { value: '21.4', unit: '°C', label: x.name },
            { value: '48', unit: '%', label: 'Humidity' },
          ],
          line: 'Today 19.8 – 22.1 °C',
          spark: wave(30, 21, 1, 3),
        });
        break;
      }
      case 'figures': {
        const t = thingOf(w.ref);
        if (!t) {
          out.push(gone(w.id, 'Figures', 'This connection isn’t in Whombat any more.'));
          break;
        }
        const first = t.panels.find((p) => p.view === 'figures');
        const view = first ? panelView(w.id, t, first.id) : null;
        out.push(
          view && view.kind === 'figures'
            ? { ...view, title: t.label }
            : {
                id: w.id,
                kind: 'figures',
                title: t.label,
                ...(t.mark ? { mark: t.mark } : {}),
                items: [{ value: 'Fine', label: 'Answering' }],
              },
        );
        break;
      }
      case 'panel': {
        const t = thingOf(w.ref);
        const view = t && w.opts.panel ? panelView(w.id, t, w.opts.panel) : null;
        if (!t) out.push(gone(w.id, 'Panel', 'This connection isn’t in Whombat any more.'));
        else if (!view) out.push(gone(w.id, t.label, `${t.label}’s page doesn’t have this any more.`));
        else if (scenario === 'wrong' && t.ref === PLEX)
          out.push({
            ...view,
            tone: 'bad',
            problem: { text: 'Plex isn’t answering', detail: 'It runs on pve-01, which is down.' },
          });
        else out.push(view);
        break;
      }
      default:
        break;
    }
  }
  return out;
}
