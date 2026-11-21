/**
 * Fixture pages of the arr group: Sonarr, Radarr and NZBHydra, their Summary in slots as the server builds it. Each entry shows in the
 * web's and the phone's fixture mode at `/things/<thing>` and in the sidebar; its shape and an example are in
 * `types.ts`. Add yours to the list; nothing else needs changing.
 */
import {
  type NoticeIgnore,
  type NoticeNature,
  type ThingGalleryItem,
  type ThingLine,
  type ThingPage,
  type ThingPageBar,
  type ThingPageButton,
  type ThingPageNotice,
  type ThingPagePanel,
  thingHref,
} from '@whombat/core/domain';
import { fixtureImage } from '../pictures.js';
import type { FixtureServiceCtx, FixtureServicePage } from './types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LOOK_ONLY = 'Look only: changes are off for this connection.';

const SONARR = 'connection:con_sonarr';
const RADARR = 'connection:con_radarr';
const HYDRA = 'connection:con_nzbhydra';
const JELLYFIN = 'connection:con_jellyfin';
const QBITTORRENT = 'connection:con_qbittorrent';
const SAB_HREF = thingHref('connection', 'con_sabnzbd');

/** The parts every page of this group shares: its head, its buttons on Look only, Worth a look, the week, the machine. */
function kit(ctx: FixtureServiceCtx) {
  const { now, ago, lookOnly } = ctx;
  const button = (b: Omit<ThingPageButton, 'allowed'>): ThingPageButton =>
    lookOnly ? { ...b, allowed: false, reason: LOOK_ONLY } : { ...b, allowed: true };
  const notice = (
    n: ThingPageNotice,
    nature: NoticeNature,
    check: string,
    ignore: NoticeIgnore,
  ): ThingPageNotice => ({ ...n, nature, check, ...(lookOnly ? {} : { ignore }) });
  const head = (
    id: string,
    catalogId: string,
    name: string,
    status: ThingPage['status'],
    badge: string,
    facts: ThingLine[],
    address: string,
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
    open: { label: `Open ${name}`, url: `http://${address}` },
    runsOn: null,
    settings: true,
    actions: [],
    readAt: ago(4_000),
  });
  const summary = (notices: ThingPageNotice[], panels: ThingPagePanel[]) => [
    {
      key: 'overview',
      label: 'Summary',
      panels: [
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
        ...panels,
      ],
    },
  ];
  /** A Trend of the last 7 days, today last. */
  const week = (p: {
    meta: string;
    label: string;
    values: number[];
    figure: string;
    rest: string;
    change: string;
    color: 'green' | 'blue';
  }): ThingPagePanel => {
    const days = p.values.map((_, i) => new Date(now() - (p.values.length - 1 - i) * DAY));
    return {
      kind: 'chart',
      id: 'week',
      place: 'chart',
      span: 1,
      title: 'This week',
      meta: p.meta,
      style: 'bars',
      timestamps: days.map((d) => d.toISOString()),
      labels: days.map((d, i) => (i === days.length - 1 ? 'Today' : (WEEKDAYS[d.getDay()] ?? ''))),
      series: [{ key: 'values', label: p.label, values: p.values, color: p.color }],
      figure: { value: p.figure, rest: p.rest },
      stats: [[{ text: p.change, strong: true }, { text: ' on last week' }]],
      axis: { min: 0 },
    };
  };
  /** The machine card on thetitan, then the service's own lines. */
  const machine = (own: ThingPageBar[], cpu: number): ThingPagePanel => ({
    kind: 'bars',
    id: 'machine',
    place: 'chart',
    span: 1,
    title: 'The machine',
    meta: 'thetitan',
    link: { kind: 'href', label: 'See thetitan', href: thingHref('server', 'thetitan') },
    items: [
      { id: 'cpu', label: 'Processor', note: 'of 8 cores', value: `${cpu} %`, pct: cpu / 100 },
      { id: 'memory', label: 'Memory', value: '5.2 of 16 GB', pct: 0.33 },
      { id: 'disk', label: 'Disk', value: '7.1 of 12 TB', pct: 0.59, sub: 'Full in about 5 months' },
      ...own,
    ],
  });
  const poster = (title: string) =>
    fixtureImage(
      'poster',
      title
        .toLowerCase()
        .normalize('NFD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, ''),
      `Poster of ${title}`,
    );
  return { button, notice, head, summary, week, machine, poster, now, ago };
}

type Kit = ReturnType<typeof kit>;

/** “Search for missing”, which asks first: it uses the indexers' daily limits. */
function searchMissing(k: Kit, app: 'Sonarr' | 'Radarr'): ThingPageButton {
  return k.button({
    action: 'search_missing',
    label: 'Search for missing',
    icon: 'search',
    confirm: {
      title: app === 'Sonarr' ? 'Search for every missing episode?' : 'Search for every missing movie?',
      body: `${app} asks your indexers for each one. That uses their daily limits.`,
      button: 'Search',
    },
  });
}

/** A Your library line: its count large, what changed under it, its button. */
function count(
  id: string,
  title: string,
  icon: 'tv' | 'film' | 'video' | 'download' | 'disk' | 'network' | 'plug',
  value: string,
  more: {
    detail?: string;
    note?: string;
    noteTone?: 'ok' | 'warn' | 'bad';
    actions?: ThingPageButton[];
    url?: string;
  } = {},
) {
  return {
    id,
    title,
    icon,
    ...(more.detail ? { detail: more.detail } : {}),
    right: value,
    figure: {
      value,
      ...(more.note ? { note: more.note } : {}),
      ...(more.noteTone ? { tone: more.noteTone } : {}),
    },
    ...(more.actions ? { actions: more.actions } : {}),
    ...(more.url ? { url: more.url } : {}),
  };
}

/* Sonarr ------------------------------------------------------------------------------------------------------------- */

function sonarr(ctx: FixtureServiceCtx) {
  const k = kit(ctx);
  const URL = 'http://10.100.0.20:8989';
  const coming: [string, string, number, string, boolean?][] = [
    ['Slow Horses', 'S05E03', -1 * HOUR, 'Hello Goodbye', true],
    ['The Bear', 'S04E04', 3 * HOUR, 'Worms'],
    ['Severance', 'S02E09', 1.2 * DAY, 'The After Hours'],
    ['Andor', 'S02E11', 2.1 * DAY, 'Who Else Knows?'],
    ['Shōgun', 'S02E02', 2.6 * DAY, 'Servants of Two Masters'],
    ['The Last of Us', 'S02E06', 3.3 * DAY, 'The Price'],
    ['Only Murders in the Building', 'S05E07', 4.2 * DAY, 'The Last Act'],
    ['Abbott Elementary', 'S05E09', 5.1 * DAY, 'Field Day'],
    ['The Diplomat', 'S03E04', 6.0 * DAY, 'Bad Faith'],
    ['Taskmaster', 'S20E06', 6.5 * DAY, 'A Rollerskate'],
  ];
  /** “Today 21:00”, “Tomorrow 03:00”, “Fri 22:00”, as Sonarr's page says when an episode airs. */
  /** On the hour, as episodes air. */
  const airAt = (ms: number) => new Date(Math.round((k.now() + ms) / HOUR) * HOUR);
  const air = (ms: number) => {
    const at = airAt(ms);
    const clock = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const days = Math.round(
      (new Date(at).setHours(0, 0, 0, 0) - new Date(k.now()).setHours(0, 0, 0, 0)) / DAY,
    );
    return `${days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : WEEKDAYS[at.getDay()]} ${clock}`;
  };
  const missing: [string, string, number][] = [
    ['Slow Horses · S05E02', 'Missing Persons', 2 * DAY],
    ['The Bear · S04E02', 'Bears', 9 * DAY],
    ['Andor · S02E08', 'Who Are You?', 12 * DAY],
    ['Severance · S02E06', 'Attila', 20 * DAY],
    ['The Diplomat · S03E01', 'Dreadnought', 26 * DAY],
    ['Taskmaster · S20E02', 'The Lurch', 33 * DAY],
  ];
  const page = (): ThingPage => ({
    ...k.head(
      SONARR,
      'sonarr',
      'Sonarr',
      'ok',
      'Downloading 2 items',
      [[{ text: 'Sonarr ' }, { text: '4.0.20.3014', strong: true }]],
      '10.100.0.20:8989',
    ),
    refreshS: 5,
    tabs: k.summary(
      [
        k.notice(
          {
            id: 'imports-1412340291',
            tone: 'warn',
            icon: 'download',
            title: 'The Bear · S04E03 can’t be imported',
            detail: 'Not an upgrade for the episode on disk',
            link: { kind: 'url', label: 'Open Sonarr', url: `${URL}/activity/queue` },
          },
          'you',
          'sonarr.imports',
          { lifts: 'fixed', words: 'Until it’s imported or removed.' },
        ),
      ],
      [
        {
          kind: 'gallery',
          id: 'queue',
          place: 'chart',
          span: 2,
          look: 'rows',
          title: 'Downloading now',
          meta: '1 downloading · 1 waiting · 2.4 GB left · about 6 min',
          link: { kind: 'href', label: 'Open SABnzbd', href: SAB_HREF },
          shape: 'poster',
          items: [
            {
              id: '1412340291',
              title: 'Slow Horses · S05E02',
              sub: 'WEBDL-1080p · 3.1 GB',
              image: k.poster('Slow Horses'),
              progress: 0.21,
              note: '0.7 GB of 3.1 GB',
              noteEnd: '6 min left',
              href: SAB_HREF,
            },
            {
              id: '1412340293',
              title: 'The Bear · S04E03',
              sub: 'WEBDL-1080p · 2.4 GB',
              image: k.poster('The Bear'),
              badge: { text: 'Can’t import', tone: 'warn' },
              progress: 1,
              note: '2.4 GB of 2.4 GB',
              href: SAB_HREF,
            },
          ] satisfies ThingGalleryItem[],
          empty: 'Nothing downloading.',
        },
        {
          kind: 'list',
          id: 'library',
          place: 'chart',
          span: 1,
          look: 'counts',
          title: 'Your library',
          items: [
            count('series', 'Series', 'tv', '214', {
              detail: '198 still airing · 16 ended',
              note: '+2 this week',
              noteTone: 'ok',
              url: `${URL}/`,
            }),
            count('episodes', 'Episodes', 'video', '12,340', {
              detail: 'of 13,002 aired',
              note: '+41 this week',
              noteTone: 'ok',
            }),
            count('missing', 'Missing', 'download', '38', {
              detail: 'Aired, not downloaded',
              actions: [searchMissing(k, 'Sonarr')],
              url: `${URL}/wanted/missing`,
            }),
            count('size', 'Space used', 'disk', '8.2 TB'),
          ],
        },
        {
          kind: 'gallery',
          id: 'upcoming',
          place: 'chart',
          span: 3,
          look: 'shelf',
          title: 'Coming up',
          meta: 'Next 7 days',
          shape: 'poster',
          items: coming.map(
            ([title, what, inMs, episode, onDisk], i): ThingGalleryItem => ({
              id: `ep-${i + 1}`,
              title,
              sub: `${what} · ${air(inMs)}`,
              image: k.poster(title),
              at: airAt(inMs).toISOString(),
              note: episode,
              ...(onDisk ? { badge: { text: 'On disk', tone: 'ok' as const } } : {}),
            }),
          ),
        },
        k.week({
          meta: 'Came in per day',
          label: 'Came in',
          values: [4, 9, 2, 7, 11, 3, 5],
          figure: '41',
          rest: 'episodes this week',
          change: '+12 %',
          color: 'green',
        }),
        k.machine(
          [
            {
              id: 'sonarr-version',
              label: 'Sonarr',
              value: '4.0.20.3014',
              pct: null,
              sub: 'Up to date',
              subTone: 'ok',
            },
            { id: 'disk-tv', label: 'Media disk', value: '6.1 of 8.0 TB', pct: 0.76, sub: '1.9 TB free' },
          ],
          6,
        ),
        {
          kind: 'list',
          id: 'missing',
          place: 'main',
          title: 'Missing',
          meta: '38',
          items: missing.map(([title, episode, agoMs], i) => ({
            id: `missing-${i + 1}`,
            title,
            detail: episode,
            at: k.ago(agoMs),
            image: k.poster(title.split(' · ')[0] ?? title),
          })),
          empty: 'Nothing missing.',
        },
      ],
    ),
  });
  return {
    page,
    row: () => ({
      line: '214 series',
      facts: [
        { label: 'Missing', value: '38' },
        { label: 'Downloading', value: '2' },
        { label: 'Disk free', value: '1.9 TB' },
      ],
    }),
    action: ({ action }: { action: string }) =>
      action === 'search_missing'
        ? { message: 'Sonarr is searching for the missing episodes.', recorded: true }
        : null,
    checks: [
      { check: 'media.disk', name: 'Media disk filling up', nature: 'problem' as const, perItem: true },
      {
        check: 'sonarr.health',
        name: 'Sonarr’s own health checks',
        nature: 'problem' as const,
        perItem: true,
      },
      {
        check: 'sonarr.imports',
        name: 'Downloads that can’t be imported',
        nature: 'problem' as const,
        perItem: true,
      },
    ],
  };
}

/* Radarr ------------------------------------------------------------------------------------------------------------- */

function radarr(ctx: FixtureServiceCtx) {
  const k = kit(ctx);
  const URL = 'http://10.100.0.20:7878';
  const later = (ms: number) => new Date(k.now() + ms).toISOString();
  const coming: [string, string, number][] = [
    ['Wicked: For Good', 'In cinemas', 2 * DAY],
    ['Zootopia 2', 'In cinemas', 3 * DAY],
    ['Frankenstein', 'Digital', 4 * DAY],
    ['One Battle After Another', 'On disc', 9 * DAY],
    ['Avatar: Fire and Ash', 'In cinemas', 14 * DAY],
    ['The Running Man', 'Digital', 18 * DAY],
    ['Hamnet', 'In cinemas', 23 * DAY],
    ['Bugonia', 'Digital', 27 * DAY],
  ];
  const day = (ms: number) =>
    new Date(k.now() + ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const page = (): ThingPage => ({
    ...k.head(
      RADARR,
      'radarr',
      'Radarr',
      'ok',
      'Downloading 2 items',
      [[{ text: 'Radarr ' }, { text: '6.4.4.10685', strong: true }]],
      '10.100.0.20:7878',
    ),
    refreshS: 5,
    tabs: k.summary(
      [],
      [
        {
          kind: 'gallery',
          id: 'queue',
          place: 'chart',
          span: 2,
          look: 'rows',
          title: 'Downloading now',
          meta: '1 downloading · 1 waiting · 6.7 GB left · about 4 min',
          link: { kind: 'href', label: 'Open SABnzbd', href: SAB_HREF },
          shape: 'poster',
          items: [
            {
              id: '2210',
              title: 'Conclave (2024)',
              sub: 'WEBDL-2160p · 18.2 GB',
              image: k.poster('Conclave'),
              progress: 0.63,
              note: '11.5 GB of 18.2 GB',
              noteEnd: '4 min left',
              href: SAB_HREF,
            },
            {
              id: '2211',
              title: 'Flow (2024)',
              sub: 'Bluray-1080p · 9.4 GB',
              image: k.poster('Flow'),
              progress: 0,
              note: '0 %',
              noteEnd: 'Queued',
              href: SAB_HREF,
            },
          ] satisfies ThingGalleryItem[],
          empty: 'Nothing downloading.',
        },
        {
          kind: 'list',
          id: 'library',
          place: 'chart',
          span: 1,
          look: 'counts',
          title: 'Your library',
          items: [
            count('movies', 'Movies', 'film', '612', {
              note: '+3 this week',
              noteTone: 'ok',
              url: `${URL}/`,
            }),
            count('on-disk', 'On disk', 'video', '580', {
              detail: 'of 612 movies',
              note: '+5 this week',
              noteTone: 'ok',
            }),
            count('missing', 'Missing', 'download', '32', {
              detail: 'Out, not downloaded',
              actions: [searchMissing(k, 'Radarr')],
            }),
            count('size', 'Space used', 'disk', '14.6 TB'),
          ],
        },
        {
          kind: 'gallery',
          id: 'upcoming',
          place: 'chart',
          span: 3,
          look: 'shelf',
          title: 'Coming up',
          meta: 'Next 30 days',
          shape: 'poster',
          items: coming.map(
            ([title, what, inMs], i): ThingGalleryItem => ({
              id: `movie-${i + 1}`,
              title,
              sub: `${what} · ${day(inMs)}`,
              image: k.poster(title),
              at: later(inMs),
            }),
          ),
        },
        k.week({
          meta: 'Came in per day',
          label: 'Came in',
          values: [1, 0, 2, 0, 1, 0, 1],
          figure: '5',
          rest: 'movies this week',
          change: '−17 %',
          color: 'green',
        }),
        k.machine(
          [
            {
              id: 'radarr-version',
              label: 'Radarr',
              value: '6.4.4.10685',
              pct: null,
              sub: 'Version 6.5.0.10903 is out',
            },
            {
              id: 'disk-movies',
              label: 'Media disk',
              value: '14.6 of 16 TB',
              pct: 0.91,
              sub: '1.4 TB free',
              tone: 'warn',
            },
          ],
          4,
        ),
        {
          kind: 'list',
          id: 'missing',
          place: 'main',
          title: 'Missing',
          meta: '32',
          items: [
            ['Anora (2024)', 3 * DAY],
            ['The Brutalist (2024)', 11 * DAY],
            ['Nosferatu (2024)', 19 * DAY],
            ['A Real Pain (2024)', 30 * DAY],
          ].map(([title, agoMs], i) => ({
            id: `missing-${i + 1}`,
            title: title as string,
            at: k.ago(agoMs as number),
            image: k.poster((title as string).replace(/ \(\d{4}\)$/, '')),
          })),
          empty: 'Nothing missing.',
        },
      ],
    ),
  });
  return {
    page,
    row: () => ({
      line: '612 movies',
      facts: [
        { label: 'Missing', value: '32' },
        { label: 'Downloading', value: '2' },
        { label: 'Disk free', value: '1.4 TB' },
      ],
    }),
    action: ({ action }: { action: string }) =>
      action === 'search_missing'
        ? { message: 'Radarr is searching for the missing movies.', recorded: true }
        : null,
    checks: [
      { check: 'media.disk', name: 'Media disk filling up', nature: 'problem' as const, perItem: true },
      {
        check: 'radarr.health',
        name: 'Radarr’s own health checks',
        nature: 'problem' as const,
        perItem: true,
      },
      {
        check: 'radarr.imports',
        name: 'Downloads that can’t be imported',
        nature: 'problem' as const,
        perItem: true,
      },
    ],
  };
}

/* NZBHydra2 ---------------------------------------------------------------------------------------------------------- */

function nzbhydra(ctx: FixtureServiceCtx) {
  const k = kit(ctx);
  const URL = 'http://10.100.0.20:5076';
  const grabs: [string, string, 'sonarr' | 'radarr', number, string?][] = [
    ['Slow.Horses.S05E02.1080p.WEB.h264-GRP', 'NZBgeek', 'sonarr', 12 * MIN],
    ['Conclave.2024.2160p.WEB-DL.DDP5.1-GRP', 'NZBgeek', 'radarr', 40 * MIN],
    ['Andor.S02E10.2160p.WEB.h265-GRP', 'DrunkenSlug', 'sonarr', 2 * HOUR],
    ['Flow.2024.1080p.BluRay.x264-GRP', 'NZBgeek', 'radarr', 3 * HOUR, 'The download client refused it'],
    ['The.Bear.S04E03.1080p.WEB.h264-GRP', 'DrunkenSlug', 'sonarr', 5 * HOUR],
    ['Shogun.S01E04.1080p.WEB.h264-GRP', 'NZBgeek', 'sonarr', 9 * HOUR],
  ];
  const time = (ms: number) =>
    new Date(k.now() - ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const page = (): ThingPage => ({
    ...k.head(
      HYDRA,
      'nzbhydra',
      'NZBHydra2',
      'warn',
      'NZBFinder is off',
      [[{ text: 'NZBHydra2 ' }, { text: '9.2.0', strong: true }], [{ text: '3 indexers', strong: true }]],
      '10.100.0.20:5076',
    ),
    tabs: k.summary(
      [
        k.notice(
          {
            id: 'off-NZBFinder',
            tone: 'warn',
            icon: 'network',
            title: 'NZBFinder is switched off after errors',
            detail: 'Failed to connect to api.nzbfinder.ws',
            link: { kind: 'url', label: 'Open NZBHydra2', url: `${URL}/stats/indexerStatuses` },
          },
          'problem',
          'nzbhydra.indexer_off',
          { lifts: 'fixed', words: 'Until it’s working again.' },
        ),
      ],
      [
        {
          kind: 'gallery',
          id: 'indexers',
          place: 'chart',
          span: 2,
          look: 'rows',
          title: 'Indexers',
          meta: 'How much of each one’s daily limit is used',
          link: { kind: 'url', label: 'Open NZBHydra2', url: `${URL}/stats/indexerStatuses` },
          shape: 'square',
          items: [
            {
              id: 'NZBFinder',
              title: 'NZBFinder',
              sub: 'Failed to connect to api.nzbfinder.ws',
              badge: { text: 'Off after errors', tone: 'bad' },
              progress: 0.12,
              note: '12 of 100 searches',
            },
            {
              id: 'DrunkenSlug',
              title: 'DrunkenSlug',
              sub: '9 grabs this week',
              badge: { text: '95 % used', tone: 'warn' },
              progress: 0.95,
              note: '95 of 100 searches',
              noteEnd: 'resets 01:00',
            },
            {
              id: 'NZBgeek',
              title: 'NZBgeek',
              sub: '31 grabs this week · 12 of 50 downloads',
              progress: 0.41,
              note: '412 of 1,000 searches',
              noteEnd: '41 %',
            },
          ] satisfies ThingGalleryItem[],
          empty: 'No indexers yet.',
        },
        {
          kind: 'list',
          id: 'today',
          place: 'chart',
          span: 1,
          look: 'counts',
          title: 'Today',
          items: [
            count('searches', 'Searches', 'network', '46', {
              note: '1,204 this week',
            }),
            count('grabs', 'Grabs', 'download', '7', {
              detail: '2 didn’t work this week',
              note: '41 this week',
            }),
            count('indexers', 'Indexers working', 'plug', '2 of 3', {
              note: '1 off after errors',
              noteTone: 'warn',
              url: `${URL}/config/indexers`,
            }),
          ],
        },
        k.week({
          meta: 'Grabs per day',
          label: 'Grabs',
          values: [5, 8, 4, 6, 9, 2, 7],
          figure: '41',
          rest: 'grabs this week',
          change: '+8 %',
          color: 'blue',
        }),
        k.machine([{ id: 'hydra-version', label: 'NZBHydra2', value: '9.2.0', pct: null }], 3),
        {
          kind: 'table',
          id: 'grabs',
          place: 'main',
          title: 'Recent grabs',
          meta: '7 today',
          columns: [
            { key: 'title', label: 'Title' },
            { key: 'indexer', label: 'Indexer' },
            { key: 'app', label: 'Asked by' },
            { key: 'at', label: 'When' },
          ],
          rows: grabs.map(([title, indexer, app, agoMs, error], i) => ({
            id: String(4321 - i),
            cells: {
              title: { text: title, ...(error ? { note: error, tone: 'bad' as const } : {}) },
              indexer: { text: indexer },
              app: {
                text: app === 'sonarr' ? 'Sonarr' : 'Radarr',
                href: thingHref('connection', app === 'sonarr' ? 'con_sonarr' : 'con_radarr'),
              },
              at: { text: time(agoMs) },
            },
          })),
          empty: 'Nothing grabbed yet.',
        },
      ],
    ),
  });
  return {
    page,
    row: () => ({
      line: '3 indexers',
      facts: [
        { label: 'Indexers', value: '2 of 3' },
        { label: 'Grabs today', value: '7' },
      ],
      reason: 'NZBFinder is switched off after errors',
    }),
    checks: [
      {
        check: 'nzbhydra.indexer_off',
        name: 'Indexers switched off after errors',
        nature: 'problem' as const,
        perItem: true,
      },
      { check: 'nzbhydra.vip', name: 'VIP memberships ending', nature: 'you' as const, perItem: true },
      {
        check: 'nzbhydra.limit',
        name: 'Indexers near their daily limit',
        nature: 'fyi' as const,
        perItem: true,
      },
      { check: 'nzbhydra.old', name: 'An old NZBHydra2 version', nature: 'fyi' as const, perItem: false },
    ],
  };
}

/* Jellyfin ----------------------------------------------------------------------------------------------------------- */

function jellyfin(ctx: FixtureServiceCtx) {
  const k = kit(ctx);
  const URL = 'http://10.100.0.20:8096';
  let scanning = false;
  const page = (): ThingPage => ({
    ...k.head(
      JELLYFIN,
      'jellyfin',
      'Jellyfin',
      'ok',
      '1 stream playing',
      [[{ text: 'Jellyfin ' }, { text: '10.10.3', strong: true }], [{ text: '3 libraries', strong: true }]],
      '10.100.0.20:8096',
    ),
    verdict: scanning
      ? 'Jellyfin is fine: 1 person is watching and libraries are being scanned.'
      : 'Jellyfin is fine: 1 person is watching and every library is up to date.',
    refreshS: 5,
    tabs: k.summary(
      [],
      [
        {
          kind: 'gallery',
          id: 'playing',
          place: 'chart',
          span: 2,
          look: 'rows',
          title: 'Now playing',
          meta: '1 stream · 18 Mb/s out',
          shape: 'poster',
          items: [
            {
              id: 'sess-1',
              title: 'Dune: Part Two',
              sub: 'Film · 2024 · 4K',
              image: k.poster('Dune: Part Two'),
              person: { name: 'Anna', note: 'Living room TV' },
              badge: { text: 'Converting', tone: 'warn' },
              progress: 0.42,
              note: '1:10:12 of 2:46:00',
              noteEnd: '1 h 36 min left',
            },
          ] satisfies ThingGalleryItem[],
          empty: 'Nobody is watching right now.',
        },
        {
          kind: 'list',
          id: 'libraries',
          place: 'chart',
          span: 1,
          look: 'counts',
          title: 'Libraries',
          meta: '3 libraries',
          ...(scanning
            ? {}
            : { buttons: [k.button({ action: 'scan', target: 'all', label: 'Scan all', icon: 'search' })] }),
          items: [
            count('library-movies', 'Movies', 'film', '412', {
              detail: scanning ? 'Scanning' : 'Scanned today',
              ...(scanning
                ? {}
                : {
                    actions: [
                      k.button({ action: 'scan', target: 'movies', label: 'Scan Movies', icon: 'search' }),
                    ],
                  }),
            }),
            count('library-tv', 'TV Shows', 'tv', '68', {
              detail: scanning ? '2,840 episodes · Scanning' : '2,840 episodes · Scanned today',
              ...(scanning
                ? {}
                : {
                    actions: [
                      k.button({ action: 'scan', target: 'tv', label: 'Scan TV Shows', icon: 'search' }),
                    ],
                  }),
            }),
          ],
        },
        {
          kind: 'gallery',
          id: 'recent',
          place: 'chart',
          span: 3,
          look: 'shelf',
          title: 'Recently added',
          link: { kind: 'url', label: 'See all in Jellyfin', url: `${URL}/web/index.html` },
          shape: 'poster',
          items: [
            {
              id: 'mov1',
              title: 'Inside Out 2',
              sub: 'Film · 2024',
              image: k.poster('Inside Out 2'),
              person: { name: 'Ben', note: 'Asked for it' },
              at: k.ago(2 * HOUR),
            },
            {
              id: 'ep1',
              title: 'Slow Horses',
              sub: 'S05E03',
              image: k.poster('Slow Horses'),
              at: k.ago(5 * HOUR),
            },
          ] satisfies ThingGalleryItem[],
          empty: 'Nothing added lately.',
        },
        k.week({
          meta: 'Plays per day',
          label: 'Plays',
          values: [2, 3, 1, 4, 2, 5, 3],
          figure: '20',
          rest: 'plays this week',
          change: '+11 %',
          color: 'blue',
        }),
        k.machine(
          [{ id: 'jellyfin-version', label: 'Jellyfin', value: '10.10.3', pct: null, sub: 'Linux 6.12' }],
          12,
        ),
      ],
    ),
  });
  return {
    page,
    row: () => ({
      line: '1 watching',
      facts: [
        { label: 'Movies', value: '412' },
        { label: 'Shows', value: '68' },
        { label: 'Watching now', value: '1' },
      ],
    }),
    action: ({ action }: { action: string }) => {
      if (action === 'scan') {
        scanning = true;
        return { message: 'Jellyfin is scanning every library.', recorded: true };
      }
      return null;
    },
    checks: [
      {
        check: 'jellyfin.task_failed',
        name: 'Failed scheduled tasks',
        nature: 'problem' as const,
        perItem: true,
      },
      {
        check: 'jellyfin.restart',
        name: 'Restart needed after changes',
        nature: 'you' as const,
        perItem: false,
      },
      {
        check: 'jellyfin.converting',
        name: 'Many streams converting at once',
        nature: 'fyi' as const,
        perItem: false,
      },
      { check: 'jellyfin.scan', name: 'Long library scans', nature: 'fyi' as const, perItem: true },
    ],
  };
}

/* qBittorrent -------------------------------------------------------------------------------------------------------- */

function qbittorrent(ctx: FixtureServiceCtx) {
  const k = kit(ctx);
  let paused = false;
  let altSpeed = false;
  const page = (): ThingPage => ({
    ...k.head(
      QBITTORRENT,
      'qbittorrent',
      'qBittorrent',
      'ok',
      paused ? 'Paused' : 'Downloading · 18 MB/s',
      [
        [{ text: 'qBittorrent ' }, { text: '5.0.3', strong: true }],
        [{ text: 'Ratio ' }, { text: '1.85', strong: true }],
      ],
      '10.100.0.20:8080',
    ),
    verdict: paused
      ? 'qBittorrent is fine: nothing downloading, seeding 14 torrents.'
      : 'qBittorrent is fine: downloading 1 torrent at 18 MB/s and seeding 14.',
    ...(paused ? {} : { refreshS: 5 }),
    tabs: k.summary(
      [],
      [
        {
          kind: 'gallery',
          id: 'queue',
          place: 'chart',
          span: 2,
          look: 'rows',
          title: 'Downloading now',
          meta: paused
            ? 'Paused · 1 download · 1.8 GB left'
            : '18 MB/s · 1 download · 1.8 GB left · about 2 min',
          buttons: [
            paused
              ? k.button({ action: 'resume', label: 'Resume all', icon: 'play', tone: 'primary' })
              : k.button({ action: 'pause', label: 'Pause all', icon: 'pause' }),
            k.button({
              action: 'toggle_alt_speed',
              label: altSpeed ? 'Full speed' : 'Slow down',
              icon: 'speed',
            }),
          ],
          shape: 'square',
          items: [
            {
              id: 'a1b2c3d4',
              title: 'Slow.Horses.S05E03.1080p.WEB-DL.DDP5.1-GRP',
              sub: 'tv-sonarr · 3.1 GB · 18 MB/s',
              progress: 0.42,
              ...(paused ? { paused: true, noteEnd: 'Paused' } : { noteEnd: '2 min left' }),
              note: '1.3 GB of 3.1 GB',
            },
          ] satisfies ThingGalleryItem[],
          empty: 'Nothing downloading.',
        },
        {
          kind: 'list',
          id: 'torrents',
          place: 'chart',
          span: 1,
          look: 'counts',
          title: 'Torrents',
          meta: '15 torrents',
          items: [
            count('downloading', 'Downloading', 'download', '1', { detail: paused ? 'Paused' : '18 MB/s' }),
            count('seeding', 'Seeding', 'network', '14', { detail: '2.1 MB/s up' }),
            count('transfer', 'All-time transfer', 'disk', '4.8 TB', {
              detail: '8.9 TB uploaded · ratio 1.85',
            }),
          ],
        },
        k.machine(
          [
            { id: 'qbt-version', label: 'qBittorrent', value: '5.0.3', pct: null },
            {
              id: 'qbt-connection',
              label: 'Connection',
              value: 'Connected',
              pct: null,
              sub: 'Incoming peers ok',
              subTone: 'ok',
            },
            { id: 'download-disk', label: 'Download disk', value: '480 GB free', pct: null },
          ],
          5,
        ),
      ],
    ),
  });
  return {
    page,
    row: () => ({
      line: paused ? 'Paused' : '1 download',
      facts: [
        { label: 'Speed', value: paused ? '0 B/s' : '18 MB/s' },
        { label: 'Disk free', value: '480 GB' },
      ],
    }),
    action: ({ action }: { action: string }) => {
      if (action === 'pause') {
        paused = true;
        return { message: 'Torrents paused.' };
      }
      if (action === 'resume') {
        paused = false;
        return { message: 'Torrents resumed.' };
      }
      if (action === 'toggle_alt_speed') {
        altSpeed = !altSpeed;
        return { message: 'Switched qBittorrent’s speed limit mode.' };
      }
      return null;
    },
    checks: [
      {
        check: 'qbittorrent.disk_low',
        name: 'Download disk low on space',
        nature: 'problem' as const,
        perItem: false,
      },
      {
        check: 'qbittorrent.disconnected',
        name: 'No network connection',
        nature: 'problem' as const,
        perItem: false,
      },
      {
        check: 'qbittorrent.errored',
        name: 'Torrents with errors',
        nature: 'problem' as const,
        perItem: true,
      },
      {
        check: 'qbittorrent.firewalled',
        name: 'Incoming connections firewalled',
        nature: 'fyi' as const,
        perItem: false,
      },
      { check: 'qbittorrent.stalled', name: 'Stalled downloads', nature: 'fyi' as const, perItem: true },
      {
        check: 'qbittorrent.alt_speed',
        name: 'Slow speed limits left on',
        nature: 'fyi' as const,
        perItem: false,
      },
    ],
  };
}

export const ARR_PAGES: FixtureServicePage[] = [
  {
    thing: SONARR,
    catalogId: 'sonarr',
    name: 'Sonarr',
    fields: { url: 'http://10.100.0.20:8989' },
    make: sonarr,
  },
  {
    thing: RADARR,
    catalogId: 'radarr',
    name: 'Radarr',
    fields: { url: 'http://10.100.0.20:7878' },
    make: radarr,
  },
  {
    thing: HYDRA,
    catalogId: 'nzbhydra',
    name: 'NZBHydra2',
    fields: { url: 'http://10.100.0.20:5076' },
    make: nzbhydra,
  },
  {
    thing: JELLYFIN,
    catalogId: 'jellyfin',
    name: 'Jellyfin',
    fields: { url: 'http://10.100.0.20:8096' },
    make: jellyfin,
  },
  {
    thing: QBITTORRENT,
    catalogId: 'qbittorrent',
    name: 'qBittorrent',
    fields: { url: 'http://10.100.0.20:8080' },
    make: qbittorrent,
  },
];
