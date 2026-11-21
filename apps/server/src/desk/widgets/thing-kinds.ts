/**
 * What each kind of connection says about its widgets (desk-display-server.md “Every connection's widgets”): its best
 * panels first, better names where a panel's title says little on a screen, a big line where a list needs one, the
 * panels its page leaves out while they have nothing to show, and what a locked screen leaves out (DK-138). A kind
 * without an entry gets the generic mapping (`thing-views.ts`), which every panel of every page already has.
 *
 * Private, per kind: what plays and who watches (Plex), requests, who asked and who reported what (Seerr), cameras,
 * the alarm and who came in (Protect, Access, and every camera anywhere), the house's locks, doors and alarms and who is
 * home (Home Assistant's controls, by what they are), the devices on the network by name (Pi-hole, AdGuard, WireGuard
 * peers), photos and documents (Immich, Paperless), the person's tasks, reviews and coding work (Todoist, GitLab,
 * Forgejo, T3 Code's threads and questions) and money (Mollie, Moneybird, the CRMs, Hetzner's cost, Fusebox). Where a
 * widget fit for a passer-by carries one name, the name leaves the words instead (who asked on Plex's Recently added, a
 * Tailscale owner's address). The rest — queues, storage, figures, coming episodes — is fine for anyone passing by.
 */
import type { ThingControl, ThingGalleryItem, ThingPage, ThingPageCell, ThingPagePanel } from '@whombat/core';
import {
  actionsBuilds,
  actionsRepos,
  adsKeptOut,
  gitReviews,
  ownHead,
  pbsBackedUp,
  synologyBackedUp,
  t3CodingAgents,
  t3Waiting,
  t3Working,
  todayVsLastWeek,
  tonightOnTv,
  truenasBackedUp,
  weatherFigures,
} from './screen-panels';
import { type KindHints, type PanelHint, wholePanel } from './thing-views';

type Cells = Readonly<Record<string, ThingPageCell>>;

/** A device that runs but has a newer version waiting: amber, “Update” (ESPHome, UniFi). */
const updateTile =
  (column: string, note: string) =>
  (cells: Cells): { value: string } | null =>
    cells.state?.dot === 'ok' && cells[column]?.note === note ? { value: 'Update' } : null;

/** A container that runs but fails its health check says so; one that stopped with an error says it stopped. */
function containerTile(cells: Cells): { value: string } | null {
  if (cells.health?.tone === 'bad') return { value: 'Unhealthy' };
  if (cells.state?.dot === 'bad' && cells.state.text.startsWith('Stopped')) return { value: 'Stopped' };
  return null;
}

const count = (p: ThingPagePanel | null) =>
  !p
    ? 0
    : p.kind === 'gallery'
      ? (p.total ?? p.items.length)
      : p.kind === 'list' || p.kind === 'bars'
        ? p.items.length
        : p.kind === 'table'
          ? p.rows.length
          : 0;

/** A year, an episode or a season leads a Plex line; what follows is who watches where. */
const LEADS = /^(\d{4}|S\d+E\d+|Season \d+.*|Specials)$/;

/** Plex's Now playing: what it is (“Season 2 · Episode 5”) and who watches where (“Anna · Living room TV”) apart. */
function plexPoster(item: ThingGalleryItem) {
  if (item.person)
    return {
      detail: item.sub ?? '',
      who: [item.person.name, item.person.note].filter(Boolean).join(' · '),
    };
  const parts = (item.sub ?? '').split(' · ');
  const lead = parts[0] && LEADS.test(parts[0]) ? parts[0] : null;
  const who = (lead ? parts.slice(1) : parts).join(' · ');
  return { ...(lead ? { detail: lead } : { detail: '' }), ...(who ? { who } : {}) };
}

/** Plex's Now playing: how long is left, or that it's paused (“Direct play” and “Converting” say little on a wall). */
function plexPlaying(item: ThingGalleryItem) {
  if (item.paused || item.noteEnd)
    return { ...plexPoster(item), time: item.paused ? 'Paused' : (item.noteEnd ?? '') };
  const left = (item.note ?? '').split(' · ').filter((x) => x !== 'Direct play' && x !== 'Converting');
  return { ...plexPoster(item), time: item.badge?.text === 'Paused' ? 'Paused' : left.join(' · ') };
}

/** A poster without who asked for it (“2024 · Asked by Anna” → “2024”): a name a locked screen leaves out. */
function noAsker(item: ThingGalleryItem) {
  return {
    detail: (item.sub ?? '')
      .split(' · ')
      .filter((x) => !x.startsWith('Asked by '))
      .join(' · '),
  };
}

const QUALITY =
  /^(\d{3,4}p|web(-?dl|rip)?|bluray|blu-ray|brrip|bdrip|hdtv|dvdrip|remux|uhd|hdr\d*|x26[45]|h\.?26[45]|hevc|avc|aac\d*|ddp?\d*|atmos|proper|repack|internal|multi|complete)$/i;

/**
 * A release's file name as people say it: “Show.Name.S02E05.1080p.WEB.h264-GRP” → “Show Name · S2 E5”,
 * “Dune.Part.Two.2024.2160p.UHD” → “Dune Part Two · 2024”; a name with spaces in it is already words.
 */
export function releaseTitle(text: string): string {
  if (/\s/.test(text.trim()) || !/[._]/.test(text)) return text;
  const parts = text
    .replace(/\.(nzb|mkv|mp4|avi)$/i, '')
    .split(/[._]+/)
    .filter(Boolean);
  const words = (xs: string[]) => xs.join(' ').replace(/-[A-Za-z0-9]+$/, '');
  // The first word is the name's, whatever it looks like (“2001.A.Space.Odyssey.1968”).
  const at = (test: (x: string) => boolean) => parts.findIndex((x, i) => i > 0 && test(x));
  const ep = at((x) => /^S\d{1,2}E\d{1,3}/i.test(x));
  if (ep > 0) {
    const [, season, episode] = /^S(\d+)E(\d+)/i.exec(parts[ep] as string) ?? [];
    return `${words(parts.slice(0, ep))} · S${Number(season)} E${Number(episode)}`;
  }
  const pack = at((x) => /^S\d{1,2}$/i.test(x));
  if (pack > 0) return `${words(parts.slice(0, pack))} · Season ${Number((parts[pack] as string).slice(1))}`;
  const year = at((x) => /^(19|20)\d{2}$/.test(x));
  if (year > 0) return `${words(parts.slice(0, year))} · ${parts[year]}`;
  const tag = at((x) => QUALITY.test(x.replace(/-[A-Za-z0-9]+$/, '')));
  return tag > 0 ? words(parts.slice(0, tag)) : text;
}

/** Seerr's requests: “Film · 2026” and who asked apart (a waiting request names them, one on its way says it). */
function seerrPoster(item: ThingGalleryItem) {
  if (item.person) return { detail: item.sub ?? '', who: item.person.name };
  const parts = (item.sub ?? '').split(' · ');
  const asked = parts.find((x) => x.startsWith('Asked by '));
  if (!asked) return {};
  return { detail: parts.filter((x) => x !== asked).join(' · '), who: asked.slice('Asked by '.length) };
}

/** Sonarr's and Radarr's Coming up: what it is and its title under the poster, when it airs as its time. */
function arrPoster(item: ThingGalleryItem) {
  const sub = item.sub ?? '';
  const cut = sub.lastIndexOf(' · ');
  if (cut < 0) return {};
  return {
    detail: [sub.slice(0, cut), item.note].filter(Boolean).join(' · '),
    time: sub.slice(cut + 3),
  };
}

/** A list's own line under its title as the big line (Home Assistant's “2 home · 3 lights on”). */
const metaHead = (_page: ThingPage, p: ThingPagePanel | null) =>
  p?.kind === 'list' && p.meta ? p.meta : null;

/**
 * A queue's big line (SABnzbd's, Sonarr's, Radarr's): “3 left · about 20 min”, “Paused · 3 left”, from Downloading now's
 * rows and the line over them.
 */
function queueHead(_page: ThingPage, p: ThingPagePanel | null): string | null {
  const n = count(p);
  if (!n) return null;
  const meta = (p && 'meta' in p ? p.meta : null) ?? '';
  if (/^Paused\b/.test(meta)) return `Paused · ${n} left`;
  const time = /(?:^| · )about (.+?)(?: · |$)/.exec(meta)?.[1];
  return time ? `${n} left · about ${time}` : `${n} left`;
}

/** Sonarr's and Radarr's Downloading now: rows with their bars and time left, as SABnzbd's. */
const ARR_QUEUE = {
  panel: 'queue',
  name: 'Download queue',
  line: 'What’s downloading and how long it takes',
  head: queueHead,
  view: 'list',
} as const satisfies PanelHint;

/** Their Missing, which the page leaves out while nothing is missing. */
const ARR_MISSING = {
  panel: 'missing',
  always: 'list',
  empty: 'Nothing missing.',
} as const satisfies PanelHint;

const media = {
  plex: {
    panels: [
      {
        panel: 'playing',
        name: 'Now playing',
        line: 'Who’s watching what',
        always: 'posters',
        empty: 'Nobody’s watching.',
        head: (_page, p) => (count(p) ? `${count(p)} watching` : null),
        poster: plexPlaying,
        private: true,
      },
      { panel: 'recent', line: 'New films and episodes, as posters', poster: noAsker },
      { panel: 'libraries', name: 'Library', line: 'How much is in each library' },
    ],
    // Its Now playing's count: the page in slots has no row of figures (Watching now on an older Whombat).
    figure: 'playing',
  },
  jellyfin: {
    panels: [
      {
        panel: 'playing',
        name: 'Now playing',
        line: 'Who’s watching what',
        always: 'posters',
        empty: 'Nobody’s watching.',
        head: (_page, p) => (count(p) ? `${count(p)} watching` : null),
        poster: plexPlaying,
        private: true,
      },
      { panel: 'recent', line: 'New films and episodes, as posters', poster: noAsker },
      { panel: 'libraries', name: 'Library', line: 'How much is in each library' },
    ],
    figure: 'playing',
  },
  overseerr: {
    panels: [
      {
        panel: 'pending',
        name: 'Requests',
        line: 'New requests waiting for a yes',
        empty: 'Nothing waits for you.',
        head: (_page, p) => (count(p) ? `${count(p)} new` : null),
        poster: seerrPoster,
        private: true,
      },
      {
        panel: 'progress',
        name: 'On its way',
        line: 'What’s being fetched, and for whom',
        always: 'posters',
        empty: 'Nothing on its way.',
        head: (_page, p) => (count(p) ? `${count(p)} on its way` : null),
        poster: seerrPoster,
        private: true,
      },
      { panel: 'available', poster: noAsker },
      {
        panel: 'failed',
        name: 'Failed requests',
        line: 'Requests that couldn’t be sent on',
        always: 'posters',
        empty: 'Nothing failed.',
        poster: noAsker,
      },
      // Who reported what, in their own words.
      { panel: 'issues', private: true },
    ],
  },
  sabnzbd: {
    panels: [
      {
        panel: 'queue',
        name: 'Download queue',
        line: 'What’s downloading and how long it takes',
        head: queueHead,
        // Its live rows have no pictures: a list of names, each with its bar and time left.
        view: 'list',
        title: releaseTitle,
      },
      { panel: 'done', title: releaseTitle },
      {
        panel: 'failed',
        name: 'Failed downloads',
        line: 'Downloads that didn’t finish',
        always: 'list',
        empty: 'Nothing failed.',
        title: releaseTitle,
      },
    ],
    // Downloading now's count: the page in slots has no row of figures.
    figure: 'queue',
  },
  nzbhydra: {
    panels: [
      {
        panel: 'indexers',
        line: 'Which indexers work, and how much of each one’s limit is used',
        // Its live rows have no pictures: a list of indexers, each with its bar.
        view: 'list',
      },
      { panel: 'grabs', title: releaseTitle, columns: { detail: ['indexer', 'app'], time: 'at' } },
    ],
    // Today's grabs lead: what NZBHydra2 found for Sonarr and Radarr.
    figure: 'f-grabs',
  },
  sonarr: {
    panels: [
      {
        panel: 'tonight',
        name: 'Tonight on TV',
        line: 'Today’s episodes, and whether they’re in',
        from: tonightOnTv,
        head: ownHead,
      },
      {
        panel: 'upcoming',
        name: 'Coming episodes',
        line: 'The next episodes of your shows',
        // The page leaves Coming up out while nothing comes.
        always: 'posters',
        empty: 'No episodes in the next 7 days.',
        poster: arrPoster,
      },
      ARR_QUEUE,
      ARR_MISSING,
    ],
    // Downloading now's count: the page in slots has no row of figures.
    figure: 'queue',
  },
  radarr: {
    panels: [
      {
        panel: 'upcoming',
        name: 'Coming films',
        line: 'Films out in the next month',
        always: 'posters',
        empty: 'No releases in the next 30 days.',
        poster: arrPoster,
      },
      ARR_QUEUE,
      ARR_MISSING,
    ],
    figure: 'queue',
  },
} satisfies Record<string, KindHints>;

/** Home Assistant's entities that say who is home or where (people, their phones, zones counting them). */
const HA_WHO = new Set(['person', 'device_tracker', 'zone']);
/** A binary sensor's words for presence, occupancy, motion and a lock (`ha-controls.ts`; smoke's “Clear” too). */
const HA_WATCH_WORDS = new Set(['Home', 'Away', 'Detected', 'Clear', 'Locked', 'Unlocked']);
/** Entities whose readings say who is home, whether the house is locked or watched. */
const HA_PRIVATE_ENTITY = /^(person|device_tracker|zone|lock|alarm_control_panel|camera|binary_sensor)\./;

/** A Home Assistant control a locked screen leaves out: someone's whereabouts, a presence, motion or lock sensor. */
function haGuards(c: ThingControl): boolean {
  const domain = c.id.split('.')[0] ?? '';
  return HA_WHO.has(domain) || (domain === 'binary_sensor' && HA_WATCH_WORDS.has(c.state ?? ''));
}

/** A widget of Home that reads one of those entities (`entity_id` anywhere in the tool's arguments). */
function haPrivateSource(args: unknown): boolean {
  if (typeof args === 'string') return HA_PRIVATE_ENTITY.test(args.trim());
  if (Array.isArray(args)) return args.some(haPrivateSource);
  return !!args && typeof args === 'object' && Object.values(args).some(haPrivateSource);
}

const house = {
  homeassistant: {
    panels: [
      {
        panel: 'home-now',
        name: 'Home now',
        line: 'Who’s home, the lights, doors and windows, locks and the alarm',
        head: metaHead,
        private: true,
      },
      { panel: 'controls', name: 'Favourites', line: 'Lights and switches, on or off' },
      {
        panel: 'weather',
        name: 'Weather',
        line: 'Now, today and the next two days',
        from: weatherFigures,
      },
      { panel: 'rooms', line: 'Temperature and humidity in each room', head: metaHead },
      { panel: 'energy', line: 'Used today, from the sun and back to the grid' },
      // Someone's whereabouts and the cameras' pictures stay off a locked screen.
      { panel: 'people', name: 'Who’s home', line: 'Who is home, and who is out', private: true },
      {
        panel: 'cameras',
        name: 'Cameras',
        line: 'Every camera’s latest picture',
        mosaic: true,
        private: true,
      },
      // The page's Weather list is the Weather widget above.
      { panel: 'forecast', skip: true },
    ],
    guards: haGuards,
    privateSource: haPrivateSource,
  },
  unifi_protect: {
    panels: [
      {
        panel: 'cameras',
        name: 'All cameras',
        line: 'Every camera’s latest picture, side by side',
        mosaic: true,
        // An offline camera says so once, under its name.
        poster: (i) => (i.muted ? { time: '' } : {}),
        private: true,
      },
      { panel: 'detections', private: true },
    ],
    // Whether the alarm is on.
    privateFigures: ['alarm'],
  },
  unifi_access: {
    panels: [
      { panel: 'doors', private: true },
      { panel: 'today', name: 'Who came in', private: true },
    ],
    // How many doors are unlocked now, how often they opened, and how many people may come in (In Access's lines).
    privateFigures: ['f-doors', 'f-openings-today', 'f-people'],
  },
  unifi_network: {
    panels: [
      { panel: 'internet', line: 'Speed now and over the day' },
      { panel: 'devices', columns: { detail: ['state', 'model'] } },
      {
        panel: 'all-devices',
        name: 'All network devices',
        line: 'Every access point, switch and gateway, online or not',
        from: wholePanel('devices'),
        view: 'board',
        board: { value: 'state', tile: updateTile('firmware', 'update'), worstFirst: true },
      },
    ],
    // The Internet line of The network now: the page in slots has no row of figures.
    figure: 'internet',
  },
  esphome: {
    panels: [
      {
        panel: 'all-devices',
        name: 'All devices',
        line: 'Every device: online, offline or due an update',
        from: wholePanel('devices'),
        view: 'board',
        board: { value: 'state', tile: updateTile('version', 'older'), worstFirst: true },
      },
    ],
  },
  pihole: {
    panels: [
      {
        panel: 'kept-out',
        name: 'Ads kept out today',
        line: 'How many ads and trackers were blocked today',
        from: adsKeptOut,
      },
      { panel: 'queries', line: 'Lookups and how many were kept out, every two hours' },
      { panel: 'top-blocked' },
      // Device names say who is on the network (“annas-iphone”).
      { panel: 'top-clients', private: true },
    ],
    figure: 'blocked',
  },
  adguard: {
    panels: [
      {
        panel: 'kept-out',
        name: 'Ads kept out today',
        line: 'How many ads and trackers were blocked today',
        from: adsKeptOut,
      },
      { panel: 'queries', line: 'Lookups and how many were kept out, every two hours' },
      { panel: 'top-blocked' },
      { panel: 'top-clients', private: true },
    ],
    figure: 'blocked',
  },
} satisfies Record<string, KindHints>;

const infra = {
  portainer: {
    panels: [
      {
        panel: 'all-containers',
        name: 'All containers',
        line: 'Every container, green when it runs',
        from: wholePanel('containers'),
        view: 'board',
        board: { value: 'state', tone: ['state', 'health'], tile: containerTile, worstFirst: true },
      },
    ],
  },
  // The owners' e-mail addresses stay off the rows; a device's name, system and when it was seen are enough.
  tailscale: {
    panels: [
      // Online now has no pictures: a screen lists the devices (their owners stay off it).
      { panel: 'online', view: 'list' },
      { panel: 'devices', columns: { meta: 'seen', detail: ['os', 'key'] } },
      // Who's on it names people.
      { panel: 'people', private: true },
    ],
  },
  hetzner: {
    // Servers now are rows without pictures: a screen lists them with their bars.
    panels: [{ panel: 'servers', view: 'list' }],
    // What the servers cost a month, a line of In this project.
    privateFigures: ['f-cost-a-month'],
  },
  fusebox: {
    panels: [
      // The pools' rows (Claude · week, ChatGPT · week) with their bars; no subscription's name.
      { panel: 'limits', view: 'list' },
      { panel: 'subscriptions', private: true },
      // Who used it most and every client: people's machines by name.
      { panel: 'people', private: true },
      { panel: 'clients', private: true },
      { panel: 'who-claude', private: true },
      { panel: 'who-codex', private: true },
      // Each subscription's line is named after it.
      { panel: 'claude-week', private: true },
      { panel: 'codex-week', private: true },
    ],
    // Each limit is a figure of its own (Claude · week 62 %), as before the page was in slots.
    rowFigures: ['limits'],
    privateFigures: ['f-worth-this-month'],
  },
  // Peers are people's phones and laptops (“Anna’s phone”, 3 min ago); the internet's delay leads the figures.
  opnsense: { panels: [{ panel: 'wireguard', private: true }], figure: 'internet' },
} satisfies Record<string, KindHints>;

/** Storage and backups change slowly: their widgets are read every 5 minutes; a photo every half hour. */
const STORAGE_REFRESH_S = 300;
const PHOTOS_REFRESH_S = 1800;

const storage = {
  proxmox_backup: {
    panels: [
      {
        panel: 'backed-up',
        name: 'All backed up',
        line: 'One calm line, and only what’s late or failed',
        from: pbsBackedUp,
        head: ownHead,
      },
      {
        panel: 'guests',
        name: 'Backups',
        line: 'Each guest’s last backup',
        columns: { meta: 'last', detail: ['verified', 'size'] },
      },
      { panel: 'datastores', line: 'How full each datastore is, and when it will be full' },
      { panel: 'jobs', line: 'Verify, cleanup, prune and sync, and how they last ran' },
      {
        panel: 'failed',
        name: 'Failed in 7 days',
        line: 'Backups and jobs that failed this week',
        always: 'list',
        empty: 'Nothing failed in 7 days.',
      },
    ],
    refreshS: STORAGE_REFRESH_S,
  },
  synology: {
    panels: [
      { panel: 'storage', line: 'How full each volume is, and the disks' },
      {
        panel: 'backed-up',
        name: 'All backed up',
        line: 'One calm line, and only the backups late or failed',
        from: synologyBackedUp,
        head: ownHead,
      },
      // Hyper Backup's tasks have no pictures: a list, each with its last run.
      { panel: 'backups', line: 'Each Hyper Backup task and how it last ran', view: 'list' },
      { panel: 'disks' },
    ],
    refreshS: STORAGE_REFRESH_S,
  },
  qnap: {
    panels: [{ panel: 'volumes', line: 'How full each volume is, and the disks' }, { panel: 'disks' }],
    refreshS: STORAGE_REFRESH_S,
  },
  truenas: {
    panels: [
      { panel: 'pools', line: 'How full each pool is, and its last check' },
      {
        panel: 'backed-up',
        name: 'All backed up',
        line: 'One calm line, and only the tasks that failed',
        from: truenasBackedUp,
        head: ownHead,
      },
      // The apps have no pictures: a list, crashed first, and what runs now on top.
      { panel: 'apps', line: 'Its apps, and what runs now', view: 'list' },
      {
        panel: 'tasks',
        name: 'Tasks',
        line: 'Backups, snapshots and copies, and how they last ran',
        always: 'list',
        empty: 'No backup or snapshot tasks yet.',
      },
    ],
    refreshS: STORAGE_REFRESH_S,
  },
  nextcloud: {
    panels: [
      {
        panel: 'apps',
        name: 'Apps with updates',
        line: 'Nextcloud apps with a newer version',
        always: 'list',
        empty: 'Every app is up to date.',
      },
      // Names who uses how much.
      { panel: 'people', private: true },
    ],
    refreshS: STORAGE_REFRESH_S,
  },
  immich: {
    panels: [
      {
        panel: 'memories',
        name: 'On this day',
        line: 'Photos from this day in earlier years',
        private: true,
        refreshS: PHOTOS_REFRESH_S,
      },
      {
        panel: 'memories-photo',
        name: 'A photo from this day',
        line: 'One big photo at a time from this day in earlier years',
        from: wholePanel('memories'),
        view: 'photo',
        private: true,
        refreshS: PHOTOS_REFRESH_S,
      },
      {
        panel: 'favourites-photo',
        name: 'Favourite photos',
        line: 'Your favourites in Immich, one big photo at a time',
        from: wholePanel('favourites'),
        view: 'photo',
        private: true,
        refreshS: PHOTOS_REFRESH_S,
      },
      { panel: 'recent', private: true, refreshS: PHOTOS_REFRESH_S },
      { panel: 'favourites', private: true, refreshS: PHOTOS_REFRESH_S },
    ],
    refreshS: STORAGE_REFRESH_S,
  },
  paperless: {
    panels: [
      { panel: 'inbox', private: true },
      // File names say what the documents are; Worth a look names them too.
      {
        panel: 'failed',
        name: 'Failed imports',
        line: 'Files Paperless-ngx couldn’t take in',
        always: 'list',
        empty: 'No failed imports.',
        private: true,
      },
      { panel: 'notices', private: true },
      // Document titles and who sends them.
      { panel: 'filed', private: true },
      { panel: 'people', private: true },
    ],
    refreshS: STORAGE_REFRESH_S,
  },
} satisfies Record<string, KindHints>;

/** The person's tasks and the business's money and customers: private everywhere on a locked screen. */
/** GitHub Actions' last results: “All 3 pass”, “1 of 3 failing”, “Passing”. */
function actionsLatestHead(_page: ThingPage, p: ThingPagePanel | null): string | null {
  if (p?.kind !== 'table' || !p.rows.length) return null;
  const all = p.rows.length;
  const failing = p.rows.filter((r) => r.cells.result?.dot === 'bad').length;
  if (failing) return all === 1 ? 'Failing' : `${failing} of ${all} failing`;
  return all === 1 ? 'Passing' : `All ${all} pass`;
}

/** GitLab's and Forgejo's: Waiting for you, and its reviews alone as the widget a screen had before. */
const forgeHints: KindHints = {
  panels: [
    {
      panel: 'waiting',
      line: 'Failing default branches, then what waits for your review',
      always: 'list',
      empty: 'Nothing waits for you.',
      head: metaHead,
      private: true,
    },
    {
      panel: 'reviews',
      name: 'Waiting for your review',
      line: 'Merge and pull requests waiting for your review',
      from: gitReviews,
      head: ownHead,
      private: true,
    },
    { panel: 'runners', line: 'The runners: online, busy or offline' },
  ],
};

const business = {
  todoist: { private: true },
  mollie: {
    private: true,
    panels: [
      {
        panel: 'today-vs-week',
        name: 'Today vs last week',
        line: 'What came in today, against the same day last week',
        from: todayVsLastWeek,
      },
    ],
  },
  moneybird: { private: true },
  hubspot: { private: true },
  pipedrive: { private: true },
  // What waits for the person's review is their work queue.
  gitlab: forgeHints,
  forgejo: forgeHints,
  // Workflows, branches and runners are fine for a passer-by; commit titles stay on the page.
  github_actions: {
    panels: [
      {
        panel: 'builds',
        name: 'Builds',
        line: 'What runs now, and whether the default branch passes',
        from: actionsBuilds,
        head: ownHead,
        columns: { meta: 'state', detail: ['where'] },
      },
      {
        panel: 'running',
        name: 'Running now',
        line: 'Each run with its runner, its step and the time it has left',
        always: 'list',
        empty: 'Nothing is running.',
        head: (_page, p) => (count(p) && p && 'meta' in p ? (p.meta ?? null) : null),
        // Its live rows have no pictures: a list of runs, each with its bar and time left.
        view: 'list',
      },
      {
        panel: 'repositories',
        name: 'Every repository',
        line: 'Whether each repository’s default branch passes',
        from: actionsRepos,
        view: 'board',
        board: { worstFirst: true },
      },
      {
        panel: 'latest',
        line: 'Each workflow’s last result on the default branch',
        head: actionsLatestHead,
        columns: { meta: 'result', detail: ['when', 'took'] },
      },
      { panel: 'runners', line: 'The self-hosted runners: idle, busy or offline', head: metaHead },
      {
        panel: 'recent',
        line: 'The latest runs on every branch',
        columns: { meta: 'result', detail: ['event'], time: 'when' },
      },
    ],
    // Runs today says what it counts when it's drawn big; a bare “1 running” wouldn't.
    figure: 'f-runs-today',
  },
  // Thread titles, questions, what a permission request is about and scheduled work are the person's work, as commit
  // titles are; project names, AI programs and counts are fine for a passer-by.
  t3code: {
    panels: [
      {
        panel: 'agents',
        name: 'Coding agents',
        line: 'What waits for you, what works and what finished today, per project',
        from: t3CodingAgents,
        head: ownHead,
      },
      {
        panel: 'now',
        line: 'What waits for you, then each thread at work with how long it has worked',
        always: 'list',
        empty: 'Nothing is working.',
        head: ownHead,
        // Its live rows have no pictures: a list of threads.
        view: 'list',
        private: true,
      },
      {
        panel: 'working',
        name: 'Working now',
        line: 'Each thread at work with its AI program and how long it has worked',
        from: t3Working,
        head: (_page, p) => (count(p) && p && 'meta' in p ? (p.meta ?? null) : null),
        private: true,
      },
      {
        panel: 'waiting',
        name: 'Waiting for you',
        line: 'Threads with a question or a permission request for you',
        from: t3Waiting,
        head: (_page, p) => (count(p) && p && 'meta' in p ? (p.meta ?? null) : null),
        private: true,
      },
      { panel: 'programs', line: 'Each AI program: ready, or what stops it', head: metaHead },
      { panel: 'projects', line: 'Each project with its open threads', head: metaHead },
      {
        panel: 'recent',
        line: 'The latest threads and how each stands',
        columns: { meta: 'state', time: 'when' },
        private: true,
      },
      { panel: 'tasks', line: 'The scheduled tasks and how each last went', private: true },
      { panel: 'notices', private: true },
    ],
    // Finished today says what it counts when it's drawn big.
    figure: 'f-finished-today',
  },
} satisfies Record<string, KindHints>;

export const KIND_HINTS: Readonly<Record<string, KindHints>> = {
  ...media,
  ...house,
  ...infra,
  ...storage,
  ...business,
};

export function kindHints(catalogId: string | undefined): KindHints {
  return (catalogId && Object.hasOwn(KIND_HINTS, catalogId) ? KIND_HINTS[catalogId] : undefined) ?? {};
}
