/**
 * Service pages for fixture mode (contracts 0.121.0, CT-1011; Whombat service-dashboards.md SD-20…SD-34): Mara's Plex,
 * Seerr, SABnzbd, UniFi Protect and Pi-hole, and Home Assistant's Controls, as the server words them — pictures,
 * galleries, controls and buttons included — so the web and the phone can draw and press them without a server.
 *
 * Every group's own pages (`servicePages/<group>.ts`, the shape in `servicePages/types.ts`) join these: a group adds
 * an entry to its file and its page, row, buttons and checks answer here, replacing a built-in page with the same id.
 *
 * `createServicePages()` is transport-free: `things()` gives the sidebar's and Connections' rows, `page(thingId)` a page,
 * `homeAssistantControls()` the Controls panel to put at the top of an existing Home Assistant page's main column,
 * `action(thingId, body)` presses a button (pausing, approving and switching change what the next `page()` shows), and
 * `image(ref)` draws a picture (`pictures.ts`). `handleServicePagesRequest` in `@whombat/fixtures/fetch` answers the
 * three routes (`things.page`, `things.action`, `things.image`) over the Fetch API for the web's fixture layer.
 *
 * Every page parses with `ThingPage` (`servicePages.test.ts`). Names of people appear because Mara manages these
 * connections (SD-04); `lookOnly` shows every button as she would see it on Look only.
 *
 * Quiet notices (contracts 0.122.0, CT-1067; Whombat quiet-notices.md QN-01…QN-15): every Worth a look line says its
 * kind, check, item and Ignore words; `quiet(thingId, body)` ignores, snoozes or takes back a line (the next `page()`
 * draws it greyed at the bottom, and a page whose every problem is quiet reads fine), `watch(thingId)` and
 * `setWatch(thingId, body)` are What Whombat watches. On Look only no line offers Ignore and every change is refused.
 */
import type {
  QuietNoticeBody,
  QuietNoticeResponse,
  SetThingWatchBody,
  ThingActionBody,
  ThingActionResponse,
} from '@whombat/core/contracts';
import {
  type NoticeIgnore,
  type NoticeNature,
  type NoticeQuiet,
  type NoticeSubject,
  noticeNature,
  QUIET_SNOOZE_HOUR,
  QUIET_WORDS,
  quietWordsOf,
  type ThingControl,
  type ThingGalleryItem,
  type ThingImage,
  type ThingLine,
  type ThingPage,
  type ThingPageButton,
  type ThingPageNotice,
  type ThingPagePanel,
  type ThingSummary,
  type ThingWatch,
  type ThingWatchCheck,
  type ThingWatchException,
  thingHref,
} from '@whombat/core/domain';
import { type FixturePicture, fixtureImage, fixturePicture } from './pictures.js';
import { mara } from './principals.js';
import { type FixtureService, type FixtureServicePage, GROUP_SERVICE_PAGES } from './servicePages/index.js';

export type { FixtureService, FixtureServiceCtx, FixtureServicePage } from './servicePages/index.js';
export { GROUP_SERVICE_PAGES } from './servicePages/index.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The pages' things, by service. */
export const SERVICE_THINGS = {
  plex: 'connection:con_plex',
  seerr: 'connection:con_seerr',
  sabnzbd: 'connection:con_sabnzbd',
  protect: 'connection:con_protect',
  pihole: 'connection:con_pihole',
} as const;

/**
 * Every thing these pages answer: the built-in ones and every group's (`servicePages/<group>.ts`). The web's and the
 * phone's fixture worlds route a thing to `createServicePages` when it is in here.
 */
export const SERVICE_PAGE_THINGS: readonly string[] = [
  ...new Set<string>([...Object.values(SERVICE_THINGS), ...GROUP_SERVICE_PAGES.map((g) => g.thing)]),
];

/**
 * A world's rows with the service pages' after them; a service row with the id of one of the world's own replaces it
 * (a group's UniFi page over the world's UniFi).
 */
export function withServiceThings<T extends { id: string }>(base: readonly T[], more: readonly T[]): T[] {
  const ids = new Set(more.map((t) => t.id));
  return [...base.filter((t) => !ids.has(t.id)), ...more];
}

/** Home Assistant's thing when none is given: the web's one-Whombat world's (the phone's is `connection:con_ha`). */
export const SERVICE_PAGES_HOME_ASSISTANT = 'connection:con_home-assistant';

export interface ServicePagesOptions {
  /** Now, in milliseconds (default `Date.now`): every time on the pages is relative to it. */
  now?: () => number;
  /** Home Assistant's thingId in the world that uses these (its Controls and its buttons). */
  homeAssistant?: string;
  /** Every button drawn as on Look only (disabled with its reason) and refused when pressed. */
  lookOnly?: boolean;
  /** The groups' pages (default: every group's, `GROUP_SERVICE_PAGES`); tests give their own. */
  pages?: readonly FixtureServicePage[];
}

/** An answer to a pressed button: the endpoint's (202) or an error body as the server sends it. */
export type ServiceActionAnswer =
  | { status: 202; body: ThingActionResponse }
  | { status: 403 | 404; body: { error: { code: 'forbidden' | 'not_found'; message: string } } };

/** A refusal of `things.quiet` or `things.setWatch` as the server sends it (0.122). */
export type ServiceQuietRefusal = {
  status: 403 | 404;
  body: { error: { code: 'not_allowed' | 'not_found'; message: string } };
};
/** An answer to `things.quiet` (0.122, CT-1067). */
export type ServiceQuietAnswer = { status: 200; body: QuietNoticeResponse } | ServiceQuietRefusal;
/** An answer to `things.setWatch` (0.122, CT-1067). */
export type ServiceWatchAnswer = { status: 200; body: ThingWatch } | ServiceQuietRefusal;

export interface ServicePages {
  /** The things' rows for the sidebar, Home and Connections (Home Assistant's is the world's own). */
  things(): ThingSummary[];
  /** A page as the server would answer it now, or null for a thing that isn't one of these. */
  page(thingId: string): ThingPage | null;
  /** Home Assistant's Controls panel (SD-30), for the top of its page's main column. */
  homeAssistantControls(): Extract<ThingPagePanel, { kind: 'controls' }>;
  /** Presses a button of one of these pages (Home Assistant's Controls too); null for another thing. */
  action(thingId: string, body: ThingActionBody): ServiceActionAnswer | null;
  /** A page's picture by its ref, or null (fixture mode answers 404). */
  image(ref: string): FixturePicture | null;
  /** Ignores, snoozes or takes back a Worth a look line (0.122); null for another thing. */
  quiet(thingId: string, body: QuietNoticeBody): ServiceQuietAnswer | null;
  /** What Whombat watches on one of these things (0.122); null for another thing. */
  watch(thingId: string): ThingWatch | null;
  /** Switches a check off or on for an item or the whole thing (0.122); null for another thing. */
  setWatch(thingId: string, body: SetThingWatchBody): ServiceWatchAnswer | null;
}

/**
 * A group's page as the server packs it (`packCharts`): a short row fills its width by widening its chart rather than a
 * card of bars (the People or machine card), and a card of bars that still takes more than one column lays its lines side by side.
 */
function asPacked(page: ThingPage): ThingPage {
  return {
    ...page,
    tabs: page.tabs.map((tab) => {
      const panels = tab.panels.map((p) => ({ ...p }) as ThingPagePanel);
      let row: ThingPagePanel[] = [];
      let used = 0;
      const settle = () => {
        const chart = [...row].reverse().find((p) => p.kind === 'chart');
        const last = chart ?? row[row.length - 1];
        // A row that isn't full widens its chart, else its last card, as the server does.
        if (last && used < 3) last.span = Math.min(3, (last.span ?? 1) + 3 - used) as 1 | 2 | 3;
        const wide = row.find((p) => p.kind === 'bars' && (p.span ?? 1) > 1);
        if (chart && wide) {
          chart.span = Math.min(3, (chart.span ?? 1) + (wide.span ?? 1) - 1) as 1 | 2 | 3;
          wide.span = 1;
        }
        row = [];
        used = 0;
      };
      for (const p of panels) {
        if (p.place !== 'chart') continue;
        if (used + (p.span ?? 1) > 3) settle();
        row.push(p);
        used += p.span ?? 1;
      }
      settle();
      return {
        ...tab,
        panels: panels.map((p) =>
          p.kind === 'bars' && p.place === 'chart' && (p.span ?? 1) > 1 && !p.columns && p.items.length > 1
            ? { ...p, columns: Math.min(p.span ?? 1, p.items.length) }
            : p,
        ),
      };
    }),
  };
}

const LOOK_ONLY = 'Look only: changes are off for this connection.';

export function createServicePages(options: ServicePagesOptions = {}): ServicePages {
  const now = options.now ?? (() => Date.now());
  const ha = options.homeAssistant ?? SERVICE_PAGES_HOME_ASSISTANT;
  const lookOnly = options.lookOnly ?? false;
  const ago = (ms: number) => new Date(now() - ms).toISOString();
  // Each group's page, made once for this world: its state lives with it.
  const groups = new Map<string, { entry: FixtureServicePage; made: FixtureService }>(
    (options.pages ?? GROUP_SERVICE_PAGES).map((entry) => [
      entry.thing,
      { entry, made: entry.make({ now, ago, lookOnly }) },
    ]),
  );
  const builtIn = (thing: string) => (Object.values(SERVICE_THINGS) as string[]).includes(thing);

  /* State the buttons change -------------------------------------------------------------------- */
  const state = {
    sabPaused: false,
    sabFailedRetried: false,
    sabWarnings: true,
    seerrDecided: new Set<string>(),
    seerrFailedRetried: false,
    seerrIssueResolved: false,
    plexScanning: new Set<string>(['2']),
    piholePausedUntil: null as number | null,
    protectArmed: false,
    lights: new Map<string, boolean>([
      ['light.living_room_ceiling', true],
      ['light.floor_lamp', false],
      ['light.hall', true],
    ]),
    thermostat: 21.5,
    frontDoorLocked: true,
  };
  let changes = 0;

  /** A button as the page offers it: refused on Look only. */
  const button = (b: Omit<ThingPageButton, 'allowed'> & { allowed?: boolean }): ThingPageButton => {
    if (lookOnly) return { ...b, allowed: false, reason: LOOK_ONLY };
    return { ...b, allowed: b.allowed ?? true };
  };

  /** A Worth a look line with its kind, check, item and Ignore (0.122); no Ignore on Look only (QN-10). */
  const line = (
    n: ThingPageNotice,
    nature: NoticeNature,
    check: string,
    ignore: NoticeIgnore,
    subject?: NoticeSubject,
  ): ThingPageNotice => ({
    ...n,
    nature,
    check,
    ...(subject ? { subject } : {}),
    ...(lookOnly ? {} : { ignore }),
  });
  const ignoreUntil = (words: string, lifts: NoticeIgnore['lifts'] = 'fixed'): NoticeIgnore => ({
    lifts,
    words,
  });

  const head = (
    id: string,
    catalogId: string,
    name: string,
    status: ThingPage['status'],
    badge: string,
    facts: ThingLine[],
    address: string,
    open: string,
  ): Omit<ThingPage, 'tabs'> => ({
    id,
    kind: 'connection',
    connectionId: id.slice('connection:'.length) as ThingPage['connectionId'],
    catalogId,
    name,
    icon: catalogId,
    status,
    badge,
    facts,
    address,
    open: { label: `Open ${name}`, url: open },
    runsOn: null,
    settings: true,
    actions: [],
    readAt: ago(4_000),
  });

  const summary = (tab: ThingPagePanel[]) => [{ key: 'overview', label: 'Summary', panels: tab }];

  /* Plex (SD-20) --------------------------------------------------------------------------------- */

  const RECENT: [string, string, string?][] = [
    ['Conclave', 'Film', 'Anna'],
    ['Shōgun', 'Season 1 · 10 episodes'],
    ['Anora', 'Film'],
    ['Slow Horses', 'Season 5 · 6 episodes'],
    ['Flow', 'Film', 'Sam'],
    ['The Wild Robot', 'Film'],
    ['Andor', 'Season 2 · 12 episodes'],
    ['Wicked', 'Film', 'Anna'],
    ['The Bear', 'Season 4 · 10 episodes'],
    ['Paddington in Peru', 'Film', 'John'],
    ['Severance', 'Season 2 · 10 episodes'],
    ['Dune: Part Two', 'Film'],
  ];

  /** Plays per day of the last 7 days, the oldest first (Plex's watch history). */
  const WEEK_PLAYS = [5, 9, 14, 11, 4, 6, 7];
  const DAY_WORDS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function plex(): ThingPage {
    const scanning = state.plexScanning;
    const scan = (id: string, name: string): ThingPageButton =>
      scanning.has(id)
        ? button({
            action: 'scan',
            target: id,
            label: 'Scan',
            icon: 'search',
            allowed: false,
            reason: 'Scanning now.',
          })
        : button({ action: 'scan', target: id, label: `Scan ${name}`.slice(0, 30), icon: 'search' });
    const library = (
      id: string,
      name: string,
      icon: 'film' | 'tv' | 'music' | 'video',
      count: string,
      detail: string,
      change: { note: string; tone?: 'ok' | 'warn' },
    ) => ({
      id,
      title: name,
      icon,
      detail: scanning.has(id) ? 'Scanning · 40 %' : detail,
      right: count,
      figure: { value: count, note: change.note, ...(change.tone ? { tone: change.tone } : {}) },
      actions: [scan(id, name)],
    });
    const days = WEEK_PLAYS.map((_, i) => new Date(now() - (WEEK_PLAYS.length - 1 - i) * 24 * HOUR));
    const plays = WEEK_PLAYS.reduce((a, b) => a + b, 0);
    return {
      ...head(
        SERVICE_THINGS.plex,
        'plex',
        'Plex',
        'ok',
        'Running fine',
        [[{ text: 'Plex Media Server ' }, { text: '1.42.1', strong: true }], [{ text: '3 watching now' }]],
        '10.100.0.20:32400',
        'http://10.100.0.20:32400/web',
      ),
      buttons: [button({ action: 'check_updates', label: 'Check for updates', icon: 'search' })],
      refreshS: 5,
      tabs: summary([
        {
          kind: 'notices',
          id: 'worth',
          place: 'top',
          title: 'Worth a look',
          items: [
            line(
              {
                id: 'unmatched',
                tone: 'warn',
                icon: 'media',
                title: 'Plex couldn’t match 3 home videos',
                detail: 'They show without a poster or a proper name.',
              },
              'fyi',
              'plex.unmatched',
              ignoreUntil('Until more go unmatched.', 'newer'),
              { id: 'library:4', name: 'Home videos' },
            ),
            line(
              {
                id: 'update',
                tone: 'info',
                icon: 'update',
                title: 'Plex has an update',
                detail: 'Version 1.43.2. Install it in Plex when nobody is watching.',
                link: { kind: 'url', label: 'Open Plex', url: 'http://10.100.0.20:32400/web' },
              },
              'fyi',
              'plex.updates',
              ignoreUntil('Until there’s a newer version.', 'newer'),
            ),
          ],
        },
        {
          kind: 'gallery',
          id: 'now_playing',
          place: 'chart',
          span: 2,
          look: 'rows',
          title: 'Now playing',
          meta: '3 streams · 52 Mb/s out',
          shape: 'poster',
          items: [
            {
              id: 'session-1',
              title: 'Dune: Part Two',
              sub: 'Film · 2024 · 4K HDR',
              image: fixtureImage('poster', 'dune-part-two', 'Poster of Dune: Part Two'),
              person: { name: 'Anna', note: 'Living room TV' },
              badge: { text: 'Direct play', tone: 'ok' },
              progress: 0.42,
              note: '1:10:12 of 2:46:00',
              noteEnd: '1 h 36 min left',
            },
            {
              id: 'session-2',
              title: 'Severance',
              sub: 'Season 2 · Episode 5',
              image: fixtureImage('poster', 'severance', 'Poster of Severance'),
              person: { name: 'John', note: 'iPad · away' },
              badge: { text: 'Converting 1080p → 720p', tone: 'warn' },
              progress: 0.69,
              note: '38:12 of 55:00',
              noteEnd: '17 min left',
            },
            {
              id: 'session-3',
              title: 'The Bear',
              sub: 'Season 4 · Episode 2',
              image: fixtureImage('poster', 'the-bear', 'Poster of The Bear'),
              person: { name: 'Sam', note: 'Pixel phone' },
              badge: { text: 'Paused', tone: 'warn' },
              progress: 0.38,
              paused: true,
              note: '12:40 of 33:00',
              noteEnd: 'Paused 4 min',
            },
          ],
          empty: 'Nobody is watching right now.',
        },
        {
          kind: 'list',
          id: 'libraries',
          place: 'chart',
          span: 1,
          look: 'counts',
          title: 'Libraries',
          meta: '4 libraries',
          buttons: scanning.size
            ? []
            : [button({ action: 'scan', target: 'all', label: 'Scan all', icon: 'search' })],
          items: [
            library('1', 'Movies', 'film', '1,284', 'Scanned today 03:10', {
              note: '+9 this week',
              tone: 'ok',
            }),
            library('2', 'TV Shows', 'tv', '96', '4,210 episodes · scanned today', {
              note: '+38 episodes',
              tone: 'ok',
            }),
            library('3', 'Music', 'music', '312', 'Scanned yesterday', { note: 'No change' }),
            library('4', 'Home videos', 'video', '58', '3 not matched', {
              note: '+14 this week',
              tone: 'ok',
            }),
          ],
        },
        {
          kind: 'gallery',
          id: 'recently_added',
          place: 'chart',
          span: 3,
          look: 'shelf',
          title: 'Recently added',
          meta: '31 this week',
          shape: 'poster',
          link: { kind: 'url', label: 'See all in Plex', url: 'http://10.100.0.20:32400/web' },
          items: RECENT.map(
            ([title, sub, asked], i): ThingGalleryItem => ({
              id: `recent-${i + 1}`,
              title,
              sub,
              image: fixtureImage('poster', title, `Poster of ${title}`),
              ...(asked ? { person: { name: asked, note: `${asked} asked` } } : {}),
              at: ago((i + 1) * 7 * HOUR),
              url: `http://10.100.0.20:32400/web/index.html#!/details?key=${i + 101}`,
            }),
          ),
        },
        {
          kind: 'chart',
          id: 'week',
          place: 'chart',
          span: 1,
          title: 'This week',
          meta: 'Plays per day',
          style: 'bars',
          timestamps: days.map((d) => d.toISOString()),
          labels: days.map((d, i) => (i === days.length - 1 ? 'Today' : (DAY_WORDS[d.getDay()] ?? ''))),
          series: [{ key: 'plays', label: 'Plays', values: WEEK_PLAYS, color: 'blue' }],
          figure: { value: String(plays), rest: 'plays this week' },
          stats: [[{ text: '+18 %', strong: true }, { text: ' on last week' }]],
        },
        {
          kind: 'bars',
          id: 'people',
          place: 'chart',
          span: 1,
          title: 'Who watches',
          meta: 'This week',
          items: [
            { id: 'anna', label: 'Anna', person: true, note: 'Living room TV', value: '21 plays', pct: 1 },
            { id: 'john', label: 'John', person: true, note: 'iPad', value: '16 plays', pct: 16 / 21 },
            { id: 'sam', label: 'Sam', person: true, note: 'Pixel phone', value: '12 plays', pct: 12 / 21 },
            { id: 'mara', label: 'Mara', person: true, note: 'Mac', value: '7 plays', pct: 7 / 21 },
          ],
        },
        {
          kind: 'bars',
          id: 'machine',
          place: 'chart',
          span: 1,
          title: 'The machine',
          meta: 'thetitan',
          link: { kind: 'href', label: 'See thetitan', href: thingHref('server', 'thetitan') },
          items: [
            { id: 'cpu', label: 'Processor', note: 'of 8 cores', value: '9 %', pct: 0.09 },
            { id: 'memory', label: 'Memory', value: '5.2 of 16 GB', pct: 0.33 },
            {
              id: 'disk',
              label: 'Disk',
              value: '7.1 of 12 TB',
              pct: 0.59,
              sub: 'Full in about 5 months',
            },
            { id: 'version', label: 'Plex', value: '1.42.1', pct: null, sub: 'Version 1.43.2 is out' },
          ],
        },
      ]),
    };
  }

  /* Seerr (SD-21), in slots (service-slots.md) --------------------------------------------------- */

  const WAITING: { id: string; title: string; sub: string; asked: string; at: number }[] = [
    { id: '412', title: 'Wicked: For Good', sub: 'Film · 2025', asked: 'Sam', at: 25 * MIN },
    { id: '411', title: 'The Last of Us', sub: 'Series · Season 2', asked: 'Anna', at: 3 * HOUR },
    { id: '409', title: 'Nosferatu', sub: 'Film · 2024', asked: 'John', at: 26 * HOUR },
  ];

  const AVAILABLE: [string, string, string][] = [
    ['The Wild Robot', 'Film · 2024', 'Anna'],
    ['Flow', 'Film · 2024', 'Sam'],
    ['Anora', 'Film · 2024', 'John'],
    ['Andor', 'Series · Season 2', 'Anna'],
    ['Paddington in Peru', 'Film · 2024', 'Sam'],
    ['Shōgun', 'Series · Season 1', 'John'],
    ['Dune: Part Two', 'Film · 2024', 'Anna'],
    ['Severance', 'Series · Season 2', 'Mara'],
    ['Wicked', 'Film · 2024', 'Anna'],
    ['Slow Horses', 'Series · Season 5', 'John'],
  ];

  /** Requests per day of the last 7 days, the oldest first. */
  const WEEK_REQUESTS = [1, 0, 2, 1, 0, 1, 1];

  /** “3 h” as the server words how long ago someone asked. */
  const agoWords = (ms: number) => (ms < HOUR ? `${Math.round(ms / MIN)} min` : `${Math.round(ms / HOUR)} h`);

  function seerr(): ThingPage {
    const waiting = WAITING.filter((w) => !state.seerrDecided.has(w.id));
    const notices: ThingPageNotice[] = [];
    if (!state.seerrFailedRetried)
      notices.push(
        line(
          {
            id: 'failed-398',
            tone: 'bad',
            icon: 'download',
            title: 'A request failed: Gladiator II',
            detail: 'Radarr couldn’t add it. Asked by Anna.',
            link: {
              kind: 'ask',
              label: 'Look into it',
              question: 'Why did the request for Gladiator II fail in Seerr?',
            },
            action: button({ action: 'retry', target: '398', label: 'Retry', icon: 'retry' }),
          },
          'problem',
          'seerr.failed',
          ignoreUntil('Until it’s sent on.'),
          { id: 'request:398', name: 'Gladiator II' },
        ),
      );
    notices.push(
      line(
        {
          id: 'seerr-update',
          tone: 'info',
          icon: 'update',
          title: 'Seerr has an update',
          detail: 'Version 3.4.1',
          link: { kind: 'url', label: 'Release notes', url: 'https://docs.seerr.dev/' },
        },
        'fyi',
        'seerr.updates',
        ignoreUntil('Until there’s a newer version.', 'newer'),
      ),
    );
    const count = (
      id: string,
      title: string,
      icon: 'media' | 'download' | 'film' | 'info' | 'warn' | 'log',
      value: string,
      note?: string,
      more: { detail?: string; tone?: 'warn' } = {},
    ) => ({
      id,
      title,
      icon,
      ...more,
      right: value,
      figure: {
        value,
        ...(note ? { note } : {}),
        ...(note?.startsWith('+') ? { tone: 'ok' as const } : {}),
      },
    });
    const days = WEEK_REQUESTS.map((_, i) => new Date(now() - (WEEK_REQUESTS.length - 1 - i) * 24 * HOUR));
    const requests = WEEK_REQUESTS.reduce((a, b) => a + b, 0);
    return {
      ...head(
        SERVICE_THINGS.seerr,
        'overseerr',
        'Seerr',
        state.seerrFailedRetried ? 'ok' : 'warn',
        state.seerrFailedRetried ? 'Running fine' : '1 request failed',
        [
          [{ text: 'Seerr ' }, { text: '3.3.0', strong: true }],
          [{ text: '128', strong: true }, { text: ' requests' }],
        ],
        '10.100.0.20:5055',
        'http://10.100.0.20:5055',
      ),
      tabs: summary([
        { kind: 'notices', id: 'worth', place: 'top', title: 'Worth a look', items: notices },
        {
          kind: 'gallery',
          id: 'pending',
          place: 'chart',
          span: 2,
          look: 'rows',
          title: 'Waiting for you',
          ...(waiting.length
            ? { meta: `${waiting.length} ${waiting.length === 1 ? 'request' : 'requests'} · oldest 26 h` }
            : {}),
          shape: 'poster',
          items: waiting.map(
            (w): ThingGalleryItem => ({
              id: w.id,
              title: w.title,
              sub: w.sub,
              image: fixtureImage('poster', w.title, `Poster of ${w.title}`),
              person: { name: w.asked, note: `asked ${agoWords(w.at)} ago` },
              at: ago(w.at),
              actions: [
                button({ action: 'approve', target: w.id, label: 'Approve', icon: 'check', tone: 'primary' }),
                button({
                  action: 'decline',
                  target: w.id,
                  label: 'Decline',
                  icon: 'close',
                  confirm: {
                    title: `Decline “${w.title}”?`,
                    body: `${w.asked} is told it was declined and can ask again.`,
                    button: 'Decline',
                  },
                }),
              ],
            }),
          ),
          empty: 'Nothing waits for you.',
        },
        {
          kind: 'list',
          id: 'requests',
          place: 'chart',
          span: 1,
          look: 'counts',
          title: 'Requests',
          meta: '128 in all',
          items: [
            count('all', 'All requests', 'media', '128', '+6 this week', {
              ...(waiting.length ? { detail: `${waiting.length} waiting for you` } : {}),
            }),
            count('progress', 'On its way', 'download', '2', '+1 this week', { detail: '1 downloading' }),
            count('available', 'Available', 'film', '112', '+5 this week'),
            count('declined', 'Declined', 'info', '4', 'Nothing new'),
            ...(state.seerrFailedRetried
              ? []
              : [
                  count('failed', 'Failed', 'warn', '1', undefined, {
                    detail: 'Couldn’t be sent on',
                    tone: 'warn',
                  }),
                ]),
            count(
              'issues',
              'Open issues',
              'log',
              state.seerrIssueResolved ? '0' : '1',
              state.seerrIssueResolved ? 'Nothing new' : '+1 this week',
            ),
          ],
        },
        {
          kind: 'gallery',
          id: 'available',
          place: 'chart',
          span: 3,
          look: 'shelf',
          title: 'Just available',
          meta: '5 this week',
          shape: 'poster',
          items: AVAILABLE.map(
            ([title, sub, asked], i): ThingGalleryItem => ({
              id: `avail-${i + 1}`,
              title,
              sub,
              image: fixtureImage('poster', title, `Poster of ${title}`),
              person: { name: asked, note: `${asked} asked` },
              at: ago((i + 1) * 20 * HOUR),
            }),
          ),
          empty: 'Nothing became available lately.',
        },
        {
          kind: 'chart',
          id: 'week',
          place: 'chart',
          span: 1,
          title: 'This week',
          meta: 'Requests per day',
          style: 'bars',
          timestamps: days.map((d) => d.toISOString()),
          labels: days.map((d, i) => (i === days.length - 1 ? 'Today' : (DAY_WORDS[d.getDay()] ?? ''))),
          series: [{ key: 'values', label: 'Requests', values: WEEK_REQUESTS, color: 'violet' }],
          figure: { value: String(requests), rest: 'requests this week' },
          stats: [[{ text: '+20 %', strong: true }, { text: ' on last week' }]],
          axis: { min: 0 },
        },
        {
          kind: 'bars',
          id: 'people',
          place: 'chart',
          span: 1,
          title: 'Who asks',
          meta: 'Last 30 days',
          items: [
            {
              id: 'person-0',
              label: 'Anna',
              person: true,
              note: '6 films · 3 series',
              value: '9 requests',
              pct: 1,
            },
            {
              id: 'person-1',
              label: 'Sam',
              person: true,
              note: '4 films · 1 series',
              value: '5 requests',
              pct: 5 / 9,
            },
            {
              id: 'person-2',
              label: 'John',
              person: true,
              note: '2 films · 1 series',
              value: '3 requests',
              pct: 3 / 9,
            },
            { id: 'person-3', label: 'Mara', person: true, note: '1 series', value: '1 request', pct: 1 / 9 },
          ],
        },
        {
          kind: 'bars',
          id: 'machine',
          place: 'chart',
          span: 1,
          title: 'The machine',
          meta: 'thetitan',
          link: { kind: 'href', label: 'See thetitan', href: thingHref('server', 'thetitan') },
          items: [
            { id: 'cpu', label: 'Processor', note: 'of 8 cores', value: '4 %', pct: 0.04 },
            { id: 'memory', label: 'Memory', value: '5.2 of 16 GB', pct: 0.33 },
            { id: 'disk', label: 'Disk', value: '7.1 of 12 TB', pct: 0.59, sub: 'Full in about 5 months' },
            { id: 'seerr-version', label: 'Seerr', value: '3.3.0', pct: null, sub: 'An update is waiting' },
          ],
        },
        {
          kind: 'gallery',
          id: 'progress',
          place: 'main',
          look: 'rows',
          title: 'On its way',
          meta: '2 requests',
          link: { kind: 'href', label: 'Open SABnzbd', href: thingHref('connection', 'con_sabnzbd') },
          shape: 'poster',
          items: [
            {
              id: '405',
              title: 'Conclave',
              sub: 'Film · 2024',
              image: fixtureImage('poster', 'conclave', 'Poster of Conclave'),
              person: { name: 'Anna', note: 'asked 2 days ago' },
              progress: 0.63,
              note: 'Downloading 63 %',
              noteEnd: '12 min left',
              href: thingHref('connection', 'con_sabnzbd'),
            },
            {
              id: '403',
              title: 'Slow Horses',
              sub: 'Series · Season 5',
              image: fixtureImage('poster', 'slow-horses', 'Poster of Slow Horses'),
              person: { name: 'John', note: 'asked 5 days ago' },
              note: 'Not downloading yet',
            },
          ],
        },
        ...(state.seerrIssueResolved
          ? []
          : [
              {
                kind: 'list' as const,
                id: 'issues',
                place: 'main' as const,
                title: 'Issues',
                meta: '1 open',
                items: [
                  {
                    id: 'issue-17',
                    title: 'Subtitles · The Bear · S3E2',
                    detail: 'Anna: Subtitles out of sync',
                    at: ago(2 * 24 * HOUR),
                    tone: 'info' as const,
                    image: fixtureImage('poster', 'the-bear', 'Poster of The Bear'),
                    url: 'http://10.100.0.20:5055/issues/17',
                    actions: [
                      button({
                        action: 'resolve_issue',
                        target: '17',
                        label: 'Mark resolved',
                        icon: 'check',
                      }),
                    ],
                  },
                ],
                empty: 'No open issues.',
              },
            ]),
      ]),
    };
  }

  /* SABnzbd (SD-22), in slots (service-slots.md) ------------------------------------------------ */

  /** Downloaded per day of the last 7 days in GB, the oldest first (SABnzbd's server_stats). */
  const WEEK_GB = [38.2, 12.4, 0, 55.1, 41, 22.7, 42.6];

  function sabnzbd(): ThingPage {
    const paused = state.sabPaused;
    const queue: [string, string, string, number, string, string][] = [
      ['Conclave.2024.2160p.WEB-DL', 'movies', '11.5 GB of 18.2 GB', 0.63, '18.2 GB', '4 min left'],
      ['Slow.Horses.S05E02.1080p', 'tv', '0.7 GB of 3.1 GB', 0.21, '3.1 GB', '6 min left'],
      ['Flow.2024.1080p.BluRay', 'movies', '0 %', 0, '9.4 GB', '9 min left'],
      ['Andor.S02E10.2160p', 'tv', '0 %', 0, '7.8 GB', 'Waiting'],
    ];
    const hours = Array.from({ length: 24 }, (_, i) => Math.floor((now() - (23 - i) * HOUR) / HOUR) * HOUR);
    const speeds = hours.map((_, i) =>
      i > 19 ? (paused && i === 23 ? 0 : 38 + ((i * 7) % 9)) : i % 5 === 0 ? 22 : 0,
    );
    const notices: ThingPageNotice[] = [];
    if (!state.sabFailedRetried)
      notices.push(
        line(
          {
            id: 'failed',
            tone: 'warn',
            icon: 'download',
            title: '1 download failed',
            detail: 'Wicked.2024 · missing articles',
            link: {
              kind: 'ask',
              label: 'Look into it',
              question: 'Why did Wicked fail to download in SABnzbd?',
            },
          },
          'problem',
          'sab.failed',
          ignoreUntil('Until another one fails.', 'newer'),
        ),
      );
    if (state.sabWarnings)
      notices.push(
        line(
          {
            id: 'warnings',
            tone: 'warn',
            icon: 'warn',
            title: 'SABnzbd has 2 warnings',
            detail: 'news.example.net timed out twice',
            action: button({ action: 'clear_warnings', label: 'Clear', icon: 'clean' }),
          },
          'fyi',
          'sab.warnings',
          ignoreUntil('Until a new warning comes.', 'newer'),
        ),
      );
    if (paused)
      notices.push(
        line(
          {
            id: 'paused',
            tone: 'info',
            icon: 'clock',
            title: 'Downloads paused',
            detail: 'Until you resume them.',
          },
          'you',
          'sab.paused',
          ignoreUntil('Until it’s resumed.'),
        ),
      );
    const days = WEEK_GB.map((_, i) => new Date(now() - (WEEK_GB.length - 1 - i) * 24 * HOUR));
    return {
      ...head(
        SERVICE_THINGS.sabnzbd,
        'sabnzbd',
        'SABnzbd',
        state.sabFailedRetried ? 'ok' : 'warn',
        state.sabFailedRetried ? (paused ? 'Paused' : 'Downloading') : '1 download failed',
        [
          [{ text: 'SABnzbd ' }, { text: '4.5.3', strong: true }],
          [{ text: '212 GB', strong: true }, { text: ' this week' }],
        ],
        '10.100.0.20:8080',
        'http://10.100.0.20:8080',
      ),
      refreshS: 5,
      tabs: summary([
        ...(notices.length
          ? [
              {
                kind: 'notices' as const,
                id: 'worth',
                place: 'top' as const,
                title: 'Worth a look',
                items: notices,
              },
            ]
          : []),
        {
          kind: 'gallery',
          id: 'queue',
          place: 'chart',
          span: 2,
          look: 'rows',
          title: 'Downloading now',
          meta: paused ? 'Paused · 18.4 GB left' : '42 MB/s · 4 downloads · 18.4 GB left · about 9 min',
          shape: 'square',
          buttons: paused
            ? [button({ action: 'resume', label: 'Resume', icon: 'play', tone: 'primary' })]
            : [
                button({ action: 'pause', label: 'Pause', icon: 'pause' }),
                button({ action: 'pause', value: 30, label: 'Pause 30 min', icon: 'pause' }),
                button({ action: 'speed', value: 50, label: 'Half speed', icon: 'speed' }),
              ],
          items: queue.map(
            ([name, category, got, done, size, left], i): ThingGalleryItem => ({
              id: `SABnzbd_nzo_${i + 1}`,
              title: name,
              sub: `${category} · ${size}`,
              progress: done,
              note: got,
              ...(paused ? { paused: true, noteEnd: 'Paused' } : { noteEnd: left }),
            }),
          ),
          empty: 'Nothing to download.',
        },
        {
          kind: 'list',
          id: 'downloaded',
          place: 'chart',
          span: 1,
          look: 'counts',
          title: 'Downloaded',
          meta: '812 GB this month',
          items: [
            {
              id: 'server-news-example-net',
              title: 'news.example.net',
              icon: 'network',
              ...(state.sabWarnings
                ? { detail: 'Not working now', tone: 'warn' as const }
                : { detail: 'Found 99 % this week' }),
              right: '8.4 TB',
              figure: { value: '8.4 TB', note: '+208 GB this week', tone: 'ok' },
            },
            {
              id: 'server-backup-example-org',
              title: 'backup.example.org',
              icon: 'network',
              detail: 'Found 96 % this week',
              right: '1.1 TB',
              figure: { value: '1.1 TB', note: '+4.2 GB this week', tone: 'ok' },
            },
          ],
        },
        {
          kind: 'chart',
          id: 'week',
          place: 'chart',
          span: 1,
          title: 'This week',
          meta: 'Downloaded per day',
          style: 'bars',
          timestamps: days.map((d) => d.toISOString()),
          labels: days.map((d, i) => (i === days.length - 1 ? 'Today' : (DAY_WORDS[d.getDay()] ?? ''))),
          series: [{ key: 'values', label: 'Downloaded', values: WEEK_GB, color: 'green', unit: 'GB' }],
          figure: { value: '212 GB', rest: 'this week' },
          stats: [[{ text: '+18 %', strong: true }, { text: ' on last week' }]],
          axis: { min: 0 },
        },
        {
          kind: 'bars',
          id: 'machine',
          place: 'chart',
          span: 1,
          title: 'The machine',
          meta: 'thetitan',
          link: { kind: 'href', label: 'See thetitan', href: thingHref('server', 'thetitan') },
          items: [
            { id: 'cpu', label: 'Processor', note: 'of 8 cores', value: '12 %', pct: 0.12 },
            { id: 'memory', label: 'Memory', value: '5.2 of 16 GB', pct: 0.33 },
            { id: 'disk', label: 'Disk', value: '7.1 of 12 TB', pct: 0.59, sub: 'Full in about 5 months' },
            { id: 'sab-version', label: 'SABnzbd', value: '4.5.3', pct: null },
            {
              id: 'download-disk',
              label: 'Download disk',
              value: '2.4 of 3.6 TB',
              pct: 0.67,
              sub: '1.2 TB free',
            },
          ],
        },
        ...(state.sabFailedRetried
          ? []
          : [
              {
                kind: 'table' as const,
                id: 'failed',
                place: 'main' as const,
                title: 'Failed',
                meta: '1 download',
                buttons: [
                  button({
                    action: 'retry_all',
                    label: 'Retry all',
                    icon: 'retry',
                    confirm: {
                      title: 'Retry every failed download?',
                      body: 'SABnzbd tries each of them again.',
                      button: 'Retry all',
                    },
                  }),
                ],
                columns: [
                  { key: 'name', label: 'Download' },
                  { key: 'why', label: 'Why' },
                  { key: 'when', label: 'When' },
                  { key: 'retry', label: '' },
                ],
                rows: [
                  {
                    id: 'SABnzbd_nzo_failed_1',
                    cells: {
                      name: { text: 'Wicked.2024.1080p.WEB-DL', note: 'movies' },
                      why: { text: 'Missing articles', tone: 'bad' as const },
                      when: { text: 'Today 11:42' },
                      retry: {
                        text: 'Retry',
                        action: button({
                          action: 'retry',
                          target: 'SABnzbd_nzo_failed_1',
                          label: 'Retry',
                          icon: 'retry',
                        }),
                      },
                    },
                  },
                ],
              },
            ]),
        {
          kind: 'list',
          id: 'done',
          place: 'main',
          title: 'Done today',
          meta: '2 downloads',
          items: [
            {
              id: 'done-1',
              title: 'The.Wild.Robot.2024.1080p',
              detail: 'movies',
              at: ago(2 * HOUR),
              right: '6.2 GB',
              tone: 'ok',
              icon: 'download',
            },
            {
              id: 'done-2',
              title: 'Shogun.S01E04.1080p',
              detail: 'tv',
              at: ago(5 * HOUR),
              right: '2.4 GB',
              tone: 'ok',
              icon: 'download',
            },
          ],
        },
        {
          kind: 'chart',
          id: 'speed',
          place: 'main',
          title: 'Speed',
          timestamps: hours.map((t) => new Date(t).toISOString()),
          series: [
            { key: 'speed', label: 'Speed', unit: 'MB/s', values: speeds, color: 'green', fill: true },
          ],
          figure: { value: paused ? 'Paused' : '42 MB/s', rest: 'now' },
          axis: { min: 0, unit: 'MB/s' },
        },
      ]),
    };
  }

  /* Home Assistant's Controls (SD-30) ------------------------------------------------------------ */

  function controls(): Extract<ThingPagePanel, { kind: 'controls' }> {
    const light = (entity: string, label: string, brightness?: string): ThingControl => {
      const on = state.lights.get(entity) ?? false;
      return {
        id: entity,
        label,
        icon: 'light',
        on,
        state: on ? (brightness ? `On · ${brightness}` : 'On') : 'Off',
        toggle: button({ action: 'toggle', target: entity, value: !on, label: on ? 'Turn off' : 'Turn on' }),
      };
    };
    const locked = state.frontDoorLocked;
    return {
      kind: 'controls',
      id: 'controls',
      place: 'main',
      title: 'Controls',
      meta: 'Your favourites',
      groups: [
        {
          id: 'living_room',
          title: 'Living room',
          items: [
            light('light.living_room_ceiling', 'Ceiling light', '80 %'),
            light('light.floor_lamp', 'Floor lamp'),
            {
              id: 'scene.movie_night',
              label: 'Movie night',
              icon: 'scene',
              buttons: [
                button({ action: 'scene', target: 'scene.movie_night', label: 'Activate', icon: 'play' }),
              ],
            },
            {
              id: 'climate.living_room',
              label: 'Thermostat',
              icon: 'thermostat',
              state: '20.8 °C now · heating',
              on: true,
              stepper: {
                value: state.thermostat,
                min: 7,
                max: 30,
                step: 0.5,
                unit: '°C',
                button: button({
                  action: 'set_temperature',
                  target: 'climate.living_room',
                  label: 'Set temperature',
                }),
              },
            },
          ],
        },
        {
          id: 'hall',
          title: 'Hall and garden',
          items: [
            light('light.hall', 'Hall light'),
            {
              id: 'lock.front_door',
              label: 'Front door',
              icon: 'lock',
              state: locked ? 'Locked' : 'Unlocked',
              tone: locked ? 'ok' : 'warn',
              buttons: [
                locked
                  ? button({
                      action: 'unlock',
                      target: 'lock.front_door',
                      label: 'Unlock',
                      icon: 'unlock',
                      tone: 'danger',
                      confirm: {
                        title: 'Unlock the front door?',
                        body: 'Anyone at the door can come in.',
                        button: 'Unlock',
                      },
                    })
                  : button({
                      action: 'lock',
                      target: 'lock.front_door',
                      label: 'Lock',
                      icon: 'lock',
                      confirm: {
                        title: 'Lock the front door?',
                        body: 'Check nobody is in the doorway.',
                        button: 'Lock',
                      },
                    }),
              ],
            },
            {
              id: 'alarm_control_panel.house',
              label: 'Alarm',
              icon: 'alarm',
              state: 'Disarmed',
              buttons: [
                button({
                  action: 'alarm_arm_home',
                  target: 'alarm_control_panel.house',
                  label: 'Arm home',
                  icon: 'shield',
                  allowed: false,
                  reason: 'This alarm needs its code: arm it in Home Assistant.',
                }),
                button({
                  action: 'alarm_arm_away',
                  target: 'alarm_control_panel.house',
                  label: 'Arm away',
                  icon: 'shield',
                  allowed: false,
                  reason: 'This alarm needs its code: arm it in Home Assistant.',
                }),
              ],
            },
            {
              id: 'camera.garden',
              label: 'Garden',
              icon: 'camera',
              state: 'Person 2 min ago',
              image: fixtureImage('wide', 'ha-garden', 'Snapshot of the garden camera'),
            },
            { id: 'sensor.outside_temperature', label: 'Outside', icon: 'sensor', state: '12.4 °C' },
          ],
        },
      ],
    };
  }

  function homeAssistant(): ThingPage {
    return {
      ...head(
        ha,
        'homeassistant',
        'Home Assistant',
        'ok',
        'Running fine',
        [[{ text: 'Home Assistant ' }, { text: '2026.10.2', strong: true }, { text: ' · Container' }]],
        '10.100.0.5:8123',
        'http://10.100.0.5:8123',
      ),
      actions: [
        {
          id: 'restart',
          label: 'Restart',
          icon: 'restart',
          confirm: {
            title: 'Restart Home Assistant?',
            body: 'It’s back in about a minute.',
            button: 'Restart',
          },
          allowed: !lookOnly,
          ...(lookOnly ? { reason: LOOK_ONLY } : {}),
        },
      ],
      refreshS: 10,
      tabs: summary([
        {
          kind: 'notices',
          id: 'worth',
          place: 'top',
          title: 'Worth a look',
          // One line per integration (QN-03).
          items: [
            ['shelly_living', 'Shelly Living room'],
            ['shelly_garage', 'Shelly Garage'],
          ].map(([id, name]) =>
            line(
              {
                id: `integration-${id}`,
                tone: 'warn',
                icon: 'plug',
                title: `${name} isn’t loading`,
                detail: 'Since Thu 07:12',
                link: {
                  kind: 'ask',
                  label: 'Look into it',
                  question: `Why isn’t ${name} loading in Home Assistant?`,
                },
              },
              'problem',
              'homeassistant.integrations',
              ignoreUntil('Until it loads.'),
              { id: `entry:${id}`, name: name as string },
            ),
          ),
        },
        // In slots (Whombat service-slots.md): the Controls live, what it has, the cameras, the week, who's home.
        ...homeAssistantSlotPanels({
          now: now(),
          controls: controls(),
          machine: { name: 'pve-02 · CT 131', href: thingHref('server', 'pve-02') },
        }),
        {
          kind: 'list',
          id: 'not-loading',
          place: 'main',
          title: 'Integrations not loading',
          meta: '2 of 102',
          items: [
            {
              id: 'shelly_living',
              title: 'Shelly · Living room',
              detail: 'Retrying · cannot reach 10.100.0.87',
              tone: 'warn',
              icon: 'plug',
            },
            {
              id: 'shelly_garage',
              title: 'Shelly · Garage',
              detail: 'Retrying · cannot reach 10.100.0.91',
              tone: 'warn',
              icon: 'plug',
            },
          ],
        },
      ]),
    };
  }

  /* UniFi Protect (SD-32) ------------------------------------------------------------------------ */

  const CAMERAS: [string, string, string?][] = [
    ['front-door', 'Front door', 'Person 2 min ago'],
    ['driveway', 'Driveway', 'Vehicle 14 min ago'],
    ['garden', 'Garden', 'Animal 1 h ago'],
    ['back-door', 'Back door'],
    ['garage', 'Garage'],
    ['side-path', 'Side path', 'Person 3 h ago'],
    ['shed', 'Shed'],
    ['doorbell', 'Doorbell', 'Ring 25 min ago'],
  ];

  function protect(): ThingPage {
    const armed = state.protectArmed;
    return {
      ...head(
        SERVICE_THINGS.protect,
        'unifi_protect',
        'UniFi Protect',
        'warn',
        'Camera offline: Garage',
        [[{ text: 'UniFi Protect ' }, { text: '6.1.79', strong: true }]],
        '10.100.0.1',
        'https://10.100.0.1/protect/dashboard',
      ),
      buttons: [
        armed
          ? button({
              action: 'disarm',
              label: 'Disarm',
              icon: 'shield',
              confirm: {
                title: 'Disarm the alarm?',
                body: 'Protect stops alerting on detections.',
                button: 'Disarm',
              },
            })
          : button({
              action: 'arm',
              label: 'Arm',
              icon: 'shield',
              confirm: {
                title: 'Arm the alarm?',
                body: 'Protect alerts on every detection until you disarm it.',
                button: 'Arm',
              },
            }),
      ],
      refreshS: 10,
      tabs: summary([
        {
          kind: 'kpis',
          id: 'figures',
          place: 'top',
          items: [
            { key: 'cameras', label: 'Cameras', value: '7', rest: 'of 8', sub: 'online', tone: 'warn' },
            { key: 'alarm', label: 'Alarm', value: armed ? 'Armed' : 'Disarmed' },
            { key: 'detections', label: 'Detections today', value: '46' },
            { key: 'version', label: 'Protect', value: '6.1.79' },
          ],
        },
        {
          kind: 'gallery',
          id: 'cameras',
          place: 'main',
          title: 'Cameras',
          meta: '7 of 8 online',
          shape: 'wide',
          items: CAMERAS.map(([id, name, last]): ThingGalleryItem => {
            const offline = id === 'garage';
            return {
              id,
              title: name,
              ...(offline ? { sub: 'Offline since 14:02' } : last ? { sub: last } : {}),
              image: fixtureImage('wide', offline ? `${id}-offline` : `protect-${id}`, `Snapshot of ${name}`),
              ...(offline ? { muted: true, badge: { text: 'Offline', tone: 'bad' as const } } : {}),
              url: `https://10.100.0.1/protect/dashboard/all/sidepanel/device/${id}`,
            };
          }),
        },
        {
          kind: 'list',
          id: 'detections',
          place: 'side',
          title: 'Recent detections',
          meta: 'The last 24 hours',
          items: [
            { id: 'evt-1', title: 'Person', detail: 'Front door', at: ago(2 * MIN), icon: 'camera' },
            { id: 'evt-2', title: 'Vehicle', detail: 'Driveway', at: ago(14 * MIN), icon: 'camera' },
            { id: 'evt-3', title: 'Doorbell', detail: 'Doorbell', at: ago(25 * MIN), icon: 'door' },
            { id: 'evt-4', title: 'Animal', detail: 'Garden', at: ago(HOUR), icon: 'camera' },
          ],
        },
        {
          kind: 'notices',
          id: 'worth',
          place: 'side',
          title: 'Worth a look',
          items: [
            line(
              {
                id: 'garage-offline',
                tone: 'warn',
                icon: 'camera',
                title: 'Camera offline: Garage',
                detail: 'Since 14:02',
                link: {
                  kind: 'ask',
                  label: 'Look into it',
                  question: 'Why is the Garage camera offline in UniFi Protect?',
                },
              },
              'problem',
              'protect.camera_offline',
              ignoreUntil('Until it’s back online.'),
              { id: 'camera:garage', name: 'Garage' },
            ),
          ],
        },
      ]),
    };
  }

  /* Pi-hole (SD-34) ------------------------------------------------------------------------------ */

  function pihole(): ThingPage {
    const until = state.piholePausedUntil;
    const paused = until !== null && until > now();
    // Twelve bars of two hours, each from an even hour, the last the one going on (as the server's).
    const hours = Array.from(
      { length: 12 },
      (_, i) => Math.floor((now() - (11 - i) * 2 * HOUR) / (2 * HOUR)) * 2 * HOUR,
    );
    const queries = hours.map((t) => {
      const h = new Date(t).getUTCHours();
      return (
        2 * (900 + Math.round(1400 * Math.max(0, Math.sin(((h - 5) / 24) * Math.PI * 2))) + ((h * 37) % 120))
      );
    });
    const blocked = queries.map((q, i) => (paused && i === 11 ? 0 : Math.round(q * 0.18)));
    const untilWords = until ? new Date(until).toISOString().slice(11, 16) : '';
    const total = queries.reduce((a, b) => a + b, 0);
    const kept = blocked.reduce((a, b) => a + b, 0);
    const n = (v: number) => v.toLocaleString('en-GB');
    const pauses = paused
      ? [button({ action: 'resume', label: 'Resume', icon: 'play', tone: 'primary' })]
      : [
          button({ action: 'pause', value: 300, label: 'Pause 5 min', icon: 'pause' }),
          button({
            action: 'pause',
            value: 1800,
            label: 'Pause 30 min',
            icon: 'pause',
            confirm: {
              title: 'Pause blocking for 30 minutes?',
              body: 'Ads and trackers get through on every device until then.',
              button: 'Pause',
            },
          }),
        ];
    return {
      ...head(
        SERVICE_THINGS.pihole,
        'pihole',
        'Pi-hole',
        'ok',
        paused ? 'Paused' : 'Blocking ads',
        [[{ text: 'Pi-hole ' }, { text: 'v6.1', strong: true }]],
        '10.100.0.53',
        'http://10.100.0.53/admin',
      ),
      // In slots (Whombat service-slots.md): Pause and Resume are in Blocking now, Update lists on its line.
      buttons: [],
      tabs: [
        ...summary([
          {
            kind: 'notices',
            id: 'worth',
            place: 'top',
            title: 'Worth a look',
            // A pause pressed here ends by itself: a heads-up (QN-04).
            items: paused
              ? [
                  line(
                    {
                      id: 'off',
                      tone: 'warn',
                      icon: 'shield',
                      title: `Blocking is off until ${untilWords}`,
                      action: button({ action: 'resume', label: 'Resume', icon: 'play' }),
                    },
                    'fyi',
                    'pihole.blocking_off',
                    ignoreUntil('Until blocking is back on.'),
                  ),
                ]
              : [
                  line(
                    {
                      id: 'update',
                      tone: 'info',
                      icon: 'update',
                      title: 'Pi-hole has an update',
                      detail: 'Version 6.2.',
                    },
                    'fyi',
                    'pihole.updates',
                    ignoreUntil('Until there’s a newer version.', 'newer'),
                  ),
                ],
          },
          {
            kind: 'list',
            id: 'blocking-now',
            place: 'chart',
            span: 2,
            title: 'Blocking now',
            items: [
              {
                id: 'blocking',
                title: 'Blocking',
                icon: 'shield',
                detail: paused
                  ? 'Ads and trackers get through on every device that uses Pi-hole.'
                  : 'Ads and trackers are kept out on every device that uses Pi-hole.',
                right: paused ? `Off until ${untilWords}` : 'On',
                tone: paused ? 'warn' : 'ok',
                actions: pauses,
              },
              {
                id: 'blocked',
                title: 'Blocked',
                icon: 'shield',
                detail: `${n(kept)} of ${n(total)} lookups · last 24 hours`,
                right: '18.2 %',
                figure: {
                  value: '18.2 %',
                  ...(paused ? { note: `Blocking is off until ${untilWords}`, tone: 'warn' as const } : {}),
                },
              },
            ],
          },
          {
            kind: 'list',
            id: 'inventory',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'Lists and devices',
            items: [
              {
                id: 'lists',
                title: 'Block lists',
                icon: 'shield',
                detail: '182,862 domains · updated 2 days ago',
                right: '3',
                figure: { value: '3', note: '+1 this week', tone: 'ok' },
                actions: [button({ action: 'update_lists', label: 'Update lists', icon: 'retry' })],
              },
              {
                id: 'clients',
                title: 'Devices',
                icon: 'device',
                right: '34',
                figure: { value: '34', note: 'active · 41 seen' },
              },
            ],
          },
          {
            kind: 'chart',
            id: 'queries',
            place: 'chart',
            span: 1,
            title: 'Last 24 hours',
            meta: 'Lookups per 2 hours',
            style: 'bars',
            timestamps: hours.map((t) => new Date(t).toISOString()),
            labels: hours.map((t, i) =>
              i === hours.length - 1 ? 'Now' : new Date(t).toISOString().slice(11, 13),
            ),
            series: [
              {
                key: 'allowed',
                label: 'Answered',
                values: queries.map((q, i) => q - (blocked[i] ?? 0)),
                color: 'blue',
              },
              { key: 'blocked', label: 'Blocked', values: blocked, color: 'orange' },
            ],
            figure: { value: n(total), rest: 'lookups' },
            stats: [[{ text: '18.2 %', strong: true }, { text: ' kept out' }]],
            axis: { min: 0 },
          },
          {
            kind: 'bars',
            id: 'top-clients',
            place: 'chart',
            span: 1,
            title: 'Busiest devices',
            meta: 'last 24 hours',
            items: [
              {
                id: 'person-0',
                label: 'Living room TV',
                person: true,
                note: '10.100.0.40',
                value: '6,312',
                pct: 1,
              },
              {
                id: 'person-1',
                label: 'Mara’s phone',
                person: true,
                note: '10.100.0.61',
                value: '4,870',
                pct: 4870 / 6312,
              },
              {
                id: 'person-2',
                label: 'Office laptop',
                person: true,
                note: '10.100.0.72',
                value: '3,940',
                pct: 3940 / 6312,
              },
            ],
          },
          {
            kind: 'bars',
            id: 'machine',
            place: 'chart',
            span: 1,
            title: 'The machine',
            meta: 'pve-02 · CT 122',
            link: { kind: 'href', label: 'See pve-02', href: thingHref('server', 'pve-02') },
            items: [
              { id: 'cpu', label: 'Processor', note: 'of 2 cores', value: '1 %', pct: 0.01 },
              { id: 'memory', label: 'Memory', value: '0.2 of 0.5 GB', pct: 0.4 },
              { id: 'disk', label: 'Disk', value: '1.9 of 8 GB', pct: 0.24 },
              { id: 'dns-version', label: 'Pi-hole', value: 'v6.1', pct: null, sub: 'Version v6.2 is out' },
            ],
          },
          {
            kind: 'bars',
            id: 'top-blocked',
            place: 'main',
            title: 'Most blocked',
            meta: 'last 24 hours',
            items: [
              ['doubleclick.net', 1204],
              ['app-measurement.com', 988],
              ['telemetry.example-tv.com', 760],
              ['ads.example.net', 512],
            ].map(([domain, count], i) => ({
              id: `d${i}`,
              label: domain as string,
              mono: true,
              value: n(count as number),
              pct: (count as number) / 1204,
            })),
          },
        ]),
        {
          key: 'lists',
          label: 'Block lists',
          count: 3,
          panels: [
            {
              kind: 'table',
              id: 'lists',
              title: 'Block lists',
              meta: '3 of 3 on',
              columns: [
                { key: 'name', label: 'List' },
                { key: 'rules', label: 'Domains', numeric: true },
                { key: 'updated', label: 'Updated' },
              ],
              rows: [
                ['StevenBlack/hosts', '128,640', '2 d ago'],
                ['OISD small', '54,210', '2 d ago'],
                ['Own list', '12', '5 d ago'],
              ].map(([name, rules, updated], i) => ({
                id: `list-${i + 1}`,
                cells: {
                  name: { text: name as string, dot: 'ok' as const },
                  rules: { text: rules as string, mono: true },
                  updated: { text: updated as string },
                },
              })),
            },
          ],
        },
      ],
    };
  }

  /* The things' rows ----------------------------------------------------------------------------- */

  function things(): ThingSummary[] {
    const row = (
      id: string,
      catalogId: string,
      name: string,
      status: ThingSummary['status'],
      line: string,
      facts: ThingSummary['facts'],
      reason?: string,
    ): ThingSummary => ({
      id,
      kind: 'connection',
      catalogId,
      name,
      icon: catalogId,
      status,
      line,
      ...(reason && status !== 'ok' ? { reason } : {}),
      facts,
      href: thingHref('connection', id.slice('connection:'.length)),
    });
    const sabOk = state.sabFailedRetried;
    const piholeOff = state.piholePausedUntil !== null && state.piholePausedUntil > now();
    const builtIns = [
      row(SERVICE_THINGS.plex, 'plex', 'Plex', 'ok', '3 watching now', [
        { label: 'Movies', value: '1,284' },
        { label: 'Shows', value: '96' },
        { label: 'Watching now', value: '2' },
      ]),
      row(
        SERVICE_THINGS.seerr,
        'overseerr',
        'Seerr',
        state.seerrFailedRetried ? 'ok' : 'warn',
        'Requests',
        [
          {
            label: 'Waiting for you',
            value: String(WAITING.filter((w) => !state.seerrDecided.has(w.id)).length),
          },
          { label: 'In progress', value: '2' },
        ],
        '1 request failed',
      ),
      row(
        SERVICE_THINGS.sabnzbd,
        'sabnzbd',
        'SABnzbd',
        sabOk ? 'ok' : 'warn',
        state.sabPaused ? 'Paused' : 'Downloading at 42 MB/s',
        [
          { label: 'Speed', value: state.sabPaused ? 'Paused' : '42 MB/s' },
          { label: 'Left', value: '18.4 GB' },
          { label: 'Disk free', value: '1.2 TB' },
        ],
        '1 download failed',
      ),
      row(
        SERVICE_THINGS.protect,
        'unifi_protect',
        'UniFi Protect',
        'warn',
        '8 cameras',
        [
          { label: 'Cameras', value: '7 of 8' },
          { label: 'Detections today', value: '46' },
        ],
        'Camera offline: Garage',
      ),
      row(
        SERVICE_THINGS.pihole,
        'pihole',
        'Pi-hole',
        'ok',
        piholeOff ? 'Blocking paused' : 'Blocking 18.2 %',
        [
          { label: 'Blocked', value: piholeOff ? 'Off' : '18.2 %' },
          { label: 'Queries today', value: '48,210' },
        ],
      ),
    ];
    const own = [...groups.values()].map(({ entry, made }) => {
      const p = made.page();
      const r = made.row?.() ?? {};
      const summary = row(
        entry.thing,
        entry.catalogId,
        entry.name,
        p.status,
        r.line ?? p.badge,
        r.facts ?? [],
        r.reason ?? p.badge,
      );
      // A Custom connection's own logo shows wherever its row does (connection-looks.md).
      return p.logo ? { ...summary, logo: p.logo } : summary;
    });
    return withServiceThings(builtIns, own).map(settleRow);
  }

  /* Buttons ------------------------------------------------------------------------------------- */

  const ok = (message: string, recorded: boolean): ServiceActionAnswer => {
    changes += 1;
    return {
      status: 202,
      body: {
        message,
        refresh: true,
        ...(recorded ? { changeId: `chg_fx_service_${changes}` as ThingActionResponse['changeId'] } : {}),
      },
    };
  };
  const nothing = (): ServiceActionAnswer => ({
    status: 404,
    body: { error: { code: 'not_found', message: 'There’s nothing to do by that name here.' } },
  });

  function action(thing: string, body: ThingActionBody): ServiceActionAnswer | null {
    const group = groups.get(thing);
    const known = thing === ha || builtIn(thing) || !!group;
    if (!known) return null;
    if (lookOnly) return { status: 403, body: { error: { code: 'forbidden', message: LOOK_ONLY } } };
    if (group) {
      const answer = group.made.action?.(body);
      if (answer) return ok(answer.message, answer.recorded ?? false);
      // A group's page over a built-in one keeps the built-in's buttons it doesn't answer itself.
      if (!builtIn(thing)) return nothing();
    }
    const { action: a, target, value } = body;
    switch (thing) {
      case SERVICE_THINGS.plex:
        if (a === 'check_updates') return ok('Plex is looking for updates.', false);
        if (a === 'scan' && target && ['1', '2', '3', '4'].includes(target)) {
          if (state.plexScanning.has(target)) return nothing();
          state.plexScanning.add(target);
          return ok('Scanning the library.', false);
        }
        return nothing();
      case SERVICE_THINGS.seerr: {
        const w = WAITING.find((x) => x.id === target && !state.seerrDecided.has(x.id));
        if ((a === 'approve' || a === 'decline') && w) {
          state.seerrDecided.add(w.id);
          return ok(a === 'approve' ? `Approved ${w.title}` : `Declined ${w.title}`, true);
        }
        if (a === 'retry' && target === '398' && !state.seerrFailedRetried) {
          state.seerrFailedRetried = true;
          return ok('Asked for Gladiator II again.', true);
        }
        if (a === 'resolve_issue' && target === '17' && !state.seerrIssueResolved) {
          state.seerrIssueResolved = true;
          return ok('Marked the issue resolved.', true);
        }
        return nothing();
      }
      case SERVICE_THINGS.sabnzbd:
        if (a === 'pause' && !state.sabPaused) {
          state.sabPaused = true;
          return ok(
            typeof value === 'number' ? `Paused downloads for ${value} minutes.` : 'Paused downloads.',
            false,
          );
        }
        if (a === 'resume' && state.sabPaused) {
          state.sabPaused = false;
          return ok('Downloading again.', false);
        }
        if (a === 'speed' && typeof value === 'number') return ok(`Speed limited to ${value} %.`, false);
        if (
          (a === 'retry_all' || (a === 'retry' && target === 'SABnzbd_nzo_failed_1')) &&
          !state.sabFailedRetried
        ) {
          state.sabFailedRetried = true;
          return ok('Trying Wicked again.', true);
        }
        if (a === 'clear_warnings' && state.sabWarnings) {
          state.sabWarnings = false;
          return ok('Cleared SABnzbd’s warnings.', false);
        }
        return nothing();
      case SERVICE_THINGS.protect:
        if (a === 'arm' && !state.protectArmed) {
          state.protectArmed = true;
          return ok('Armed the alarm.', true);
        }
        if (a === 'disarm' && state.protectArmed) {
          state.protectArmed = false;
          return ok('Disarmed the alarm.', true);
        }
        return nothing();
      case SERVICE_THINGS.pihole:
        if (a === 'pause' && typeof value === 'number' && (value === 300 || value === 1800)) {
          state.piholePausedUntil = now() + value * 1000;
          return ok(`Blocking paused for ${value / 60} minutes.`, false);
        }
        if (a === 'resume' && state.piholePausedUntil !== null) {
          state.piholePausedUntil = null;
          return ok('Blocking again.', false);
        }
        if (a === 'update_lists') return ok('Updating the block lists.', false);
        return nothing();
      default:
        // Home Assistant's Controls.
        if (a === 'toggle' && target && state.lights.has(target) && typeof value === 'boolean') {
          state.lights.set(target, value);
          return ok(value ? 'Turned it on.' : 'Turned it off.', false);
        }
        if (a === 'scene' && target === 'scene.movie_night') return ok('Movie night is on.', false);
        if (a === 'set_temperature' && target === 'climate.living_room' && typeof value === 'number') {
          if (value < 7 || value > 30 || (value * 2) % 1 !== 0) return nothing();
          state.thermostat = value;
          return ok(`Set the thermostat to ${value} °C.`, false);
        }
        if (a === 'unlock' && target === 'lock.front_door' && state.frontDoorLocked) {
          state.frontDoorLocked = false;
          return ok('Unlocked Front door', true);
        }
        if (a === 'lock' && target === 'lock.front_door' && !state.frontDoorLocked) {
          state.frontDoorLocked = true;
          return ok('Locked Front door', true);
        }
        return nothing();
    }
  }

  /* Quiet notices (0.122, CT-1067) ---------------------------------------------------------------- */

  /** Every check of each thing, in plain words: What Whombat watches lists them all (QN-15). */
  const CHECKS: Record<string, Omit<ThingWatchCheck, 'on' | 'off' | 'exceptions'>[]> = {
    [SERVICE_THINGS.plex]: [
      { check: 'plex.remote', name: 'Remote access', nature: 'problem', perItem: false },
      { check: 'plex.converting', name: 'Many streams converting', nature: 'fyi', perItem: false },
      { check: 'plex.unmatched', name: 'Unmatched items', nature: 'fyi', perItem: true },
      { check: 'plex.updates', name: 'Plex updates', nature: 'fyi', perItem: false },
    ],
    [SERVICE_THINGS.seerr]: [
      { check: 'seerr.failed', name: 'Failed requests', nature: 'problem', perItem: true },
      { check: 'seerr.issues', name: 'Issues left open', nature: 'you', perItem: true },
      { check: 'seerr.updates', name: 'Seerr updates', nature: 'fyi', perItem: false },
    ],
    [SERVICE_THINGS.sabnzbd]: [
      { check: 'sab.disk', name: 'Download disk space', nature: 'problem', perItem: false },
      { check: 'sab.failed', name: 'Failed downloads', nature: 'problem', perItem: false },
      { check: 'sab.paused', name: 'Downloads paused for long', nature: 'you', perItem: false },
      { check: 'sab.warnings', name: 'SABnzbd’s other warnings', nature: 'fyi', perItem: false },
    ],
    [SERVICE_THINGS.protect]: [
      { check: 'protect.breach', name: 'The alarm going off', nature: 'you', perItem: false },
      { check: 'protect.camera_offline', name: 'Cameras going offline', nature: 'problem', perItem: true },
    ],
    [SERVICE_THINGS.pihole]: [
      { check: 'pihole.blocking_off', name: 'Blocking switched off', nature: 'you', perItem: false },
      { check: 'pihole.updates', name: 'New versions', nature: 'fyi', perItem: false },
    ],
    [ha]: [
      {
        check: 'homeassistant.integrations',
        name: 'Integrations not loading',
        nature: 'problem',
        perItem: true,
      },
      { check: 'homeassistant.updates', name: 'Updates', nature: 'fyi', perItem: false },
    ],
  };
  const GENERIC: Omit<ThingWatchCheck, 'on' | 'off' | 'exceptions'>[] = [
    { check: 'conn.answers', name: 'Not answering', nature: 'problem', perItem: false },
    { check: 'conn.signin', name: 'Needing to sign in again', nature: 'you', perItem: false },
  ];
  const checksOf = (thing: string) => [
    ...GENERIC,
    ...(groups.get(thing)?.made.checks ?? CHECKS[thing] ?? []),
  ];

  /** Quiet lines and switched-off checks, by `thing|check|subject` (`''` the whole thing). */
  const quiets = new Map<string, { quiet: NoticeQuiet; subject?: NoticeSubject }>();
  const offs = new Map<string, { subject?: NoticeSubject; at: string }>();
  const keyOf = (thing: string, check: string, subject?: string) => `${thing}|${check}|${subject ?? ''}`;
  const by = { id: mara.id, name: 'Mara' };

  /** 09:00 tomorrow in UTC: fixture mode has no time zone of its own. */
  const tomorrowNine = () => {
    const d = new Date(now());
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(QUIET_SNOOZE_HOUR, 0, 0, 0);
    return d.toISOString();
  };

  /**
   * A page as quiet makes it (QN-13, QN-14): lines not watched leave, quiet ones go greyed to the bottom with `quiet`, a
   * snooze past its time or an ignore whose line went lifts, and a page whose problems are all quiet or heads-ups reads
   * fine.
   */
  function settle(thing: string, page: ThingPage): ThingPage {
    const seen = new Set<string>();
    const tabs = page.tabs.map((t) => ({
      ...t,
      panels: t.panels.map((p): ThingPagePanel => {
        if (p.kind !== 'notices') return p;
        const active: ThingPageNotice[] = [];
        const quiet: ThingPageNotice[] = [];
        for (const n of p.items) {
          if (!n.check) {
            active.push(n);
            continue;
          }
          if (offs.has(keyOf(thing, n.check)) || offs.has(keyOf(thing, n.check, n.subject?.id))) continue;
          const key = keyOf(thing, n.check, n.subject?.id);
          seen.add(key);
          const q = quiets.get(key);
          if (q?.quiet.until && Date.parse(q.quiet.until) <= now()) quiets.delete(key);
          const still = quiets.get(key);
          if (still) quiet.push({ ...n, quiet: still.quiet });
          else active.push(n);
        }
        return { ...p, items: [...active, ...quiet] };
      }),
    }));
    for (const key of [...quiets.keys()])
      if (key.startsWith(`${thing}|`) && !seen.has(key)) quiets.delete(key);
    const lines = tabs.flatMap((t) => t.panels.flatMap((p) => (p.kind === 'notices' ? p.items : [])));
    const asking = lines.some((n) => !n.quiet && n.tone !== 'info' && noticeNature(n) !== 'fyi');
    const fine = !asking && (page.status === 'warn' || page.status === 'bad');
    return { ...page, tabs, ...(fine ? { status: 'ok', badge: 'Running fine' } : {}) };
  }

  function rawPage(thing: string): ThingPage | null {
    const group = groups.get(thing);
    if (group) return asPacked(group.made.page());
    switch (thing) {
      case SERVICE_THINGS.plex:
        return plex();
      case SERVICE_THINGS.seerr:
        return seerr();
      case SERVICE_THINGS.sabnzbd:
        return sabnzbd();
      case SERVICE_THINGS.protect:
        return protect();
      case SERVICE_THINGS.pihole:
        return pihole();
      default:
        return thing === ha ? homeAssistant() : null;
    }
  }

  function page(thing: string): ThingPage | null {
    const raw = rawPage(thing);
    return raw ? settle(thing, raw) : null;
  }

  /** A sidebar row follows its page (QN-22): fine once every problem on it is quiet. */
  function settleRow(row: ThingSummary): ThingSummary {
    if (row.status !== 'warn' && row.status !== 'bad') return row;
    if (page(row.id)?.status !== 'ok') return row;
    const { reason: _reason, ...rest } = row;
    return { ...rest, status: 'ok' };
  }

  const refuse = (code: 'not_allowed' | 'not_found', message: string): ServiceQuietRefusal => ({
    status: code === 'not_allowed' ? 403 : 404,
    body: { error: { code, message } },
  });
  const known = (thing: string) => thing === ha || builtIn(thing) || groups.has(thing);

  function quiet(thing: string, body: QuietNoticeBody): ServiceQuietAnswer | null {
    if (!known(thing)) return null;
    if (lookOnly) return refuse('not_allowed', LOOK_ONLY);
    const { notice, how } = body;
    const key = keyOf(thing, notice.check, notice.subject);
    if (how === 'undo') {
      if (!quiets.delete(key)) return refuse('not_found', 'There’s nothing to take back.');
      return { status: 200, body: { notice, quiet: null } };
    }
    const n = page(thing)
      ?.tabs.flatMap((t) => t.panels.flatMap((p) => (p.kind === 'notices' ? p.items : [])))
      .find((x) => x.check === notice.check && x.subject?.id === notice.subject);
    if (!n?.ignore) return refuse('not_found', 'That isn’t on this page any more.');
    const at = new Date(now()).toISOString();
    const q: NoticeQuiet =
      how === 'ignore'
        ? { state: 'ignored', words: quietWordsOf(n.ignore.words), by, at }
        : {
            state: 'snoozed',
            words: body.until ? `until ${body.until.slice(11, 16)}` : 'until tomorrow 09:00',
            until: body.until ?? tomorrowNine(),
            by,
            at,
          };
    quiets.set(key, { quiet: q, ...(n.subject ? { subject: n.subject } : {}) });
    return { status: 200, body: { notice, quiet: q } };
  }

  function watch(thing: string): ThingWatch | null {
    if (!known(thing)) return null;
    const checks = checksOf(thing).map((c): ThingWatchCheck => {
      const whole = offs.get(keyOf(thing, c.check));
      const exceptions: ThingWatchException[] = [];
      for (const [key, o] of offs)
        if (o.subject && key === keyOf(thing, c.check, o.subject.id))
          exceptions.push({ subject: o.subject, state: 'stopped', words: QUIET_WORDS.always, by, at: o.at });
      for (const [key, q] of quiets)
        if (key.startsWith(`${thing}|${c.check}|`))
          exceptions.push({
            ...(q.subject ? { subject: q.subject } : {}),
            state: q.quiet.state,
            words: q.quiet.words,
            ...(q.quiet.until ? { until: q.quiet.until } : {}),
            by,
            at: q.quiet.at,
          });
      return { ...c, on: !whole, ...(whole ? { off: { by, at: whole.at } } : {}), exceptions };
    });
    return { checks, mayChange: !lookOnly };
  }

  function setWatch(thing: string, body: SetThingWatchBody): ServiceWatchAnswer | null {
    if (!known(thing)) return null;
    if (lookOnly) return refuse('not_allowed', LOOK_ONLY);
    if (!checksOf(thing).some((c) => c.check === body.check))
      return refuse('not_found', 'Whombat doesn’t watch that here.');
    const key = keyOf(thing, body.check, body.subject?.id);
    if (body.watched) offs.delete(key);
    else
      offs.set(key, {
        ...(body.subject ? { subject: body.subject } : {}),
        at: new Date(now()).toISOString(),
      });
    return { status: 200, body: watch(thing) as ThingWatch };
  }

  return {
    things,
    page,
    homeAssistantControls: controls,
    action,
    image: (ref) => fixturePicture(ref),
    quiet,
    watch,
    setWatch,
  };
}

type ControlsPanel = Extract<ThingPagePanel, { kind: 'controls' }>;

const HA_URL = 'http://10.100.0.5:8123';
const HA_RUNS = [168, 174, 181, 160, 192, 205, 186];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Home Assistant's Summary in slots as the server builds it (Whombat service-slots.md, “Home Assistant and Pi-hole”):
 * its Controls live beside what it has, the cameras across, then the week's automation runs and who is home beside the
 * machine's card. The fixture worlds' own Home Assistant pages put their panels (what doesn't load, the backups) after
 * these. Without `controls` Live is left out; without `machine` the card.
 */
export function homeAssistantSlotPanels(opts: {
  now: number;
  controls?: ControlsPanel | null;
  machine?: { name: string; href: string } | null;
}): ThingPagePanel[] {
  const ago = (ms: number) => new Date(opts.now - ms);
  const clock = (d: Date) => d.toISOString().slice(11, 16);
  const days = HA_RUNS.map((_, i) => ago((HA_RUNS.length - 1 - i) * 24 * HOUR));
  const runs = HA_RUNS.reduce((a, b) => a + b, 0);
  const out: ThingPagePanel[] = [];
  if (opts.controls) {
    const { kind: _kind, place: _place, ...own } = opts.controls;
    out.push({ ...own, kind: 'controls', place: 'chart', span: 2 });
  }
  const count = (
    id: string,
    title: string,
    icon: 'door' | 'device' | 'clock' | 'plug',
    value: string,
    note: string,
    path: string,
    tone?: 'ok' | 'warn',
  ) => ({
    id,
    title,
    icon,
    right: value,
    figure: { value, note, ...(tone ? { tone } : {}) },
    url: `${HA_URL}${path}`,
  });
  out.push(
    {
      kind: 'list',
      id: 'inventory',
      place: 'chart',
      span: 1,
      look: 'counts',
      title: 'In Home Assistant',
      items: [
        count('areas', 'Areas', 'door', '9', 'Nothing new', '/config/areas/dashboard'),
        count('devices', 'Devices', 'device', '148', '+3 this week', '/config/devices/dashboard', 'ok'),
        count(
          'automations',
          'Automations',
          'clock',
          '42',
          'Ran 186 times today',
          '/config/automation/dashboard',
        ),
        count(
          'integrations',
          'Integrations',
          'plug',
          '102',
          '2 not loading',
          '/config/integrations/dashboard',
          'warn',
        ),
      ],
    },
    {
      kind: 'gallery',
      id: 'cameras',
      place: 'chart',
      span: 3,
      look: 'shelf',
      title: 'Cameras',
      meta: '4 cameras',
      shape: 'wide',
      items: (
        [
          ['camera.front_door', 'Front door', 'ha-front-door'],
          ['camera.driveway', 'Driveway', 'ha-driveway'],
          ['camera.garden', 'Garden', 'ha-garden', 'Recording'],
          ['camera.back_door', 'Back door', 'ha-back-door'],
        ] as const
      ).map(
        ([id, title, slug, sub]): ThingGalleryItem => ({
          id,
          title,
          image: fixtureImage('wide', slug, `Snapshot of ${title}`),
          ...(sub ? { sub } : {}),
        }),
      ),
    },
    {
      kind: 'chart',
      id: 'automations-week',
      place: 'chart',
      span: 1,
      title: 'This week',
      meta: 'Automations run per day',
      style: 'bars',
      timestamps: days.map((d) => d.toISOString()),
      labels: days.map((d, i) => (i === days.length - 1 ? 'Today' : (WEEKDAYS[d.getUTCDay()] ?? 'Day'))),
      series: [{ key: 'values', label: 'Runs', values: HA_RUNS, color: 'blue' }],
      figure: { value: runs.toLocaleString('en-GB'), rest: 'automation runs' },
      axis: { min: 0 },
    },
    {
      kind: 'bars',
      id: 'people',
      place: 'chart',
      span: 1,
      title: 'Who’s home',
      meta: '2 of 4 home',
      items: [
        {
          id: 'person-0',
          label: 'Mara',
          person: true,
          note: `since ${clock(ago(2 * HOUR))}`,
          value: 'Home',
          pct: null,
        },
        {
          id: 'person-1',
          label: 'Jules',
          person: true,
          note: `since ${clock(ago(5 * HOUR))}`,
          value: 'Home',
          pct: null,
        },
        {
          id: 'person-2',
          label: 'Sam',
          person: true,
          note: `since ${clock(ago(9 * HOUR))}`,
          value: 'Work',
          pct: null,
        },
        { id: 'person-3', label: 'Noor', person: true, note: 'since Mon', value: 'Away', pct: null },
      ],
    },
  );
  if (opts.machine)
    out.push({
      kind: 'bars',
      id: 'machine',
      place: 'chart',
      span: 1,
      title: 'The machine',
      meta: opts.machine.name,
      link: { kind: 'href', label: `See ${opts.machine.name}`.slice(0, 30), href: opts.machine.href },
      items: [
        { id: 'cpu', label: 'Processor', note: 'of 4 cores', value: '2 %', pct: 0.02 },
        { id: 'memory', label: 'Memory', value: '3.0 of 8 GB', pct: 0.38 },
        {
          id: 'disk',
          label: 'Disk',
          value: '30 of 40 GB',
          pct: 0.76,
          tone: 'warn',
          sub: 'Full in about 2 months',
          subTone: 'warn',
        },
        { id: 'ha-version', label: 'Home Assistant', value: '2026.10.2', pct: null, sub: 'Container' },
        {
          id: 'ha-database',
          label: 'Database',
          note: 'MariaDB 10.11',
          value: '6.0 GB',
          pct: null,
          sub: 'Grows 110 MB a day',
        },
      ],
    });
  return out;
}

/** Every picture the pages name (tests draw each one). */
export function servicePageImages(page: ThingPage): ThingImage[] {
  const out: ThingImage[] = [];
  for (const tab of page.tabs)
    for (const p of tab.panels) {
      if (p.kind === 'gallery') for (const i of p.items) if (i.image) out.push(i.image);
      if (p.kind === 'list') for (const i of p.items) if (i.image) out.push(i.image);
      if (p.kind === 'controls')
        for (const g of p.groups) for (const c of g.items) if (c.image) out.push(c.image);
    }
  return out;
}
