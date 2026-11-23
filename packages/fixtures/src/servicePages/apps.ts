/**
 * Fixture pages of the apps group: Immich, Paperless-ngx and Nextcloud, their Summary in slots as the server builds it
 * (docs/decisions/service-slots.md). Each entry shows in the web's and the phone's fixture mode at `/things/<thing>` and
 * in the sidebar; its shape and an example are in `types.ts`.
 *
 * Immich runs on a machine Whombat knows (the card links it), Paperless-ngx and Nextcloud on machines it doesn't (the
 * card is “<name> itself”). Immich's paused queue resumes and Paperless's failed import is marked seen with their
 * buttons; the next page shows it.
 */
import {
  type NoticeNature,
  type ThingGalleryItem,
  type ThingLine,
  type ThingPage,
  type ThingPageBar,
  type ThingPageButton,
  type ThingPageItem,
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

/** What every page here is built with. */
function kit(ctx: FixtureServiceCtx) {
  const button = (b: Omit<ThingPageButton, 'allowed'>): ThingPageButton =>
    ctx.lookOnly ? { ...b, allowed: false, reason: LOOK_ONLY } : { ...b, allowed: true };
  /** A Worth a look line with its check and Ignore (none on Look only). */
  const notice = (
    n: ThingPageNotice,
    nature: NoticeNature,
    check: string,
    ignore: string,
  ): ThingPageNotice => ({
    ...n,
    nature,
    check,
    ...(ctx.lookOnly ? {} : { ignore: { lifts: 'fixed' as const, words: ignore } }),
  });
  /** The last seven days, today last: their times and words. */
  const week = () => {
    const at = Array.from({ length: 7 }, (_, i) => new Date(ctx.now() - (6 - i) * DAY));
    return {
      timestamps: at.map((d) => d.toISOString()),
      labels: at.map((d, i) => (i === 6 ? 'Today' : (WEEKDAYS[d.getDay()] ?? ''))),
    };
  };
  const page = (p: {
    thing: `connection:${string}`;
    catalogId: string;
    name: string;
    status: ThingPage['status'];
    badge: string;
    facts: ThingLine[];
    address: string;
    url: string;
    worth: ThingPageNotice[];
    panels: ThingPagePanel[];
  }): ThingPage => ({
    id: p.thing,
    kind: 'connection',
    connectionId: p.thing.slice('connection:'.length) as ThingPage['connectionId'],
    catalogId: p.catalogId,
    name: p.name,
    icon: p.catalogId,
    status: p.status,
    badge: p.badge,
    facts: p.facts,
    address: p.address,
    open: { label: `Open ${p.name}`.slice(0, 40), url: p.url },
    runsOn: null,
    settings: true,
    actions: [],
    readAt: ctx.ago(6_000),
    tabs: [
      {
        key: 'overview',
        label: 'Summary',
        panels: [
          ...(p.worth.length
            ? [
                {
                  kind: 'notices' as const,
                  id: 'worth',
                  place: 'top' as const,
                  title: 'Worth a look',
                  items: p.worth,
                },
              ]
            : []),
          ...p.panels,
        ],
      },
    ],
  });
  return { button, notice, week, page };
}

/** “Today 18:12”, “Yesterday 09:40”, “2 Nov”, as the server words a moment. */
function when(at: Date, now: number): string {
  const day = (t: number) => new Date(t).toDateString();
  const clock = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (day(at.getTime()) === day(now)) return `Today ${clock}`;
  if (day(at.getTime()) === day(now - DAY)) return `Yesterday ${clock}`;
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** A line of Inventory: its count on the right with what changed under it. */
function count(
  id: string,
  title: string,
  value: string,
  more: Omit<ThingPageItem, 'id' | 'title' | 'right' | 'figure'> & { note?: string; noteTone?: 'ok' } = {},
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

/** A person in People: their bar against the busiest. */
function person(
  k: number,
  label: string,
  value: string,
  pct: number,
  more: Partial<ThingPageBar> = {},
): ThingPageBar {
  return { id: `person-${k}`, label, person: true, value, pct, ...more };
}

/* Immich ------------------------------------------------------------------------------------------------------------ */

const IMMICH = 'connection:con_immich';
const IMMICH_URL = 'http://10.100.0.20:2283';
/** Photos and videos added per day this week, the oldest first. */
const IMMICH_WEEK = [38, 12, 64, 41, 9, 120, 32];

const immich: FixtureServicePage = {
  thing: IMMICH,
  catalogId: 'immich',
  name: 'Immich',
  fields: { url: IMMICH_URL },
  make: (ctx) => {
    const { button, notice, week, page } = kit(ctx);
    let resumed = false;
    const recent = (): ThingGalleryItem[] =>
      [
        ['IMG_4412.HEIC', 25, false],
        ['IMG_4411.HEIC', 26, false],
        ['VID_0938.MOV', 90, true],
        ['IMG_4409.HEIC', 3 * HOUR, false],
        ['IMG_4408.HEIC', 3 * HOUR + 4 * MIN, false],
        ['PXL_1102_180412.jpg', 26 * HOUR, false],
        ['PXL_1102_175930.jpg', 26 * HOUR + 5 * MIN, false],
        ['VID_0937.MOV', 27 * HOUR, true],
        ['IMG_4402.HEIC', 2 * DAY, false],
        ['IMG_4399.HEIC', 2 * DAY + HOUR, false],
        ['IMG_4398.HEIC', 3 * DAY, false],
        ['IMG_4391.HEIC', 4 * DAY, false],
      ].map(([name, ago, video], i) => {
        const at = new Date(
          ctx.now() - (typeof ago === 'number' && ago < 1000 ? ago * MIN : (ago as number)),
        );
        return {
          id: `immich-recent-${i + 1}`,
          title: name as string,
          sub: when(at, ctx.now()),
          at: at.toISOString(),
          image: fixtureImage('square', `immich-recent-${i + 1}`, name as string),
          ...(video ? { badge: { text: 'Video', tone: 'ok' as const } } : {}),
          url: `${IMMICH_URL}/photos/immich-recent-${i + 1}`,
        };
      });
    const squares = (prefix: string, items: [string, string][]): ThingGalleryItem[] =>
      items.map(([title, sub], i) => ({
        id: `${prefix}-${i + 1}`,
        title,
        sub,
        image: fixtureImage('square', `${prefix}-${i + 1}`, title),
        url: `${IMMICH_URL}/photos/${prefix}-${i + 1}`,
      }));
    return {
      page: () => {
        const resume = button({ action: 'resume', target: 'smartSearch', label: 'Resume', icon: 'play' });
        const worth = resumed
          ? []
          : [
              notice(
                {
                  id: 'paused-smartSearch',
                  tone: 'warn',
                  icon: 'clock',
                  title: 'The smart search queue is paused',
                  detail: '412 jobs waiting.',
                  action: resume,
                  subject: { id: 'queue:smartSearch', name: 'Smart search' },
                },
                'you',
                'immich.queue_paused',
                'Until it’s resumed.',
              ),
            ];
        const queues: ThingPageItem[] = [
          {
            id: 'queue-smartSearch',
            title: 'Smart search',
            icon: resumed ? 'photo' : 'clock',
            ...(resumed
              ? { detail: '412 waiting · 1 running' }
              : { detail: '412 waiting · paused', tone: 'warn' as const, actions: [resume] }),
          },
          {
            id: 'queue-thumbnailGeneration',
            title: 'Thumbnails',
            icon: 'photo',
            detail: '118 waiting · 2 running',
          },
          {
            id: 'queue-faceDetection',
            title: 'Face detection',
            icon: 'photo',
            detail: '64 waiting · 1 running',
          },
        ];
        const w = week();
        return page({
          thing: IMMICH,
          catalogId: 'immich',
          name: 'Immich',
          status: resumed ? 'ok' : 'warn',
          badge: resumed ? '48,211 photos' : 'The smart search queue is paused',
          facts: [
            [{ text: 'Immich ' }, { text: '3.3.6', strong: true }],
            [{ text: '50,145', strong: true }, { text: ' photos and videos' }],
          ],
          address: '10.100.0.20:2283',
          url: IMMICH_URL,
          worth,
          panels: [
            {
              kind: 'list',
              id: 'jobs',
              place: 'chart',
              span: 2,
              title: 'Working on',
              meta: '594 waiting',
              link: { kind: 'url', label: 'Open jobs', url: `${IMMICH_URL}/admin/jobs-status` },
              items: queues,
              empty: 'Nothing to do.',
            },
            {
              kind: 'list',
              id: 'library',
              place: 'chart',
              span: 1,
              look: 'counts',
              title: 'In Immich',
              items: [
                count('photos', 'Photos', '48,211', {
                  icon: 'photo',
                  detail: '402 GB',
                  note: '+312 this week',
                  noteTone: 'ok',
                  url: `${IMMICH_URL}/photos`,
                }),
                count('videos', 'Videos', '1,934', {
                  icon: 'video',
                  detail: '410 GB',
                  note: '+4 this week',
                  noteTone: 'ok',
                  url: `${IMMICH_URL}/photos`,
                }),
                count('albums', 'Albums', '24', {
                  icon: 'media',
                  detail: 'Yours · 3 shared',
                  url: `${IMMICH_URL}/albums`,
                }),
                count('faces', 'People', '86', {
                  icon: 'camera',
                  detail: 'Recognised in your photos',
                  url: `${IMMICH_URL}/people`,
                }),
              ],
            },
            {
              kind: 'gallery',
              id: 'recent',
              place: 'chart',
              span: 3,
              look: 'shelf',
              shape: 'square',
              title: 'Recently added',
              meta: 'Newest first',
              link: { kind: 'url', label: 'Open Immich', url: `${IMMICH_URL}/photos` },
              items: recent(),
              empty: 'Nothing here yet.',
            },
            {
              kind: 'chart',
              id: 'week',
              place: 'chart',
              span: 1,
              title: 'This week',
              meta: 'Photos and videos added per day',
              style: 'bars',
              ...w,
              series: [{ key: 'values', label: 'Added', values: IMMICH_WEEK, color: 'blue' }],
              figure: { value: '316', rest: 'added this week' },
              stats: [[{ text: '+18 %', strong: true }, { text: ' on last week' }]],
              axis: { min: 0 },
            },
            {
              kind: 'bars',
              id: 'people',
              place: 'chart',
              span: 1,
              title: 'Who uses most space',
              meta: '3 people',
              items: [
                person(0, 'Mara', '520 GB', 1, { note: '30,111 photos · 1,200 videos' }),
                person(1, 'Ben', '292 GB', 292 / 520, {
                  note: '14,020 photos · 610 videos',
                  tone: 'warn',
                  sub: 'Quota 300 GB',
                  subTone: 'warn',
                }),
                person(2, 'Lotte', '41 GB', 41 / 520, { note: '4,080 photos · 124 videos' }),
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
                {
                  id: 'cpu',
                  label: 'Processor',
                  note: 'of 8 cores',
                  value: resumed ? '34 %' : '18 %',
                  pct: resumed ? 0.34 : 0.18,
                },
                { id: 'memory', label: 'Memory', value: '6.1 of 16 GB', pct: 0.38 },
                { id: 'disk', label: 'Disk', value: '7.1 of 12 TB', pct: 0.59 },
                {
                  id: 'immich-version',
                  label: 'Immich',
                  value: '3.3.6',
                  pct: null,
                  sub: 'Up to date',
                  subTone: 'ok',
                },
                {
                  id: 'photo-disk',
                  label: 'Photo disk',
                  value: '3.1 of 4.0 TB',
                  pct: 0.78,
                  sub: '900 GB free',
                },
              ],
            },
            {
              kind: 'gallery',
              id: 'memories',
              place: 'main',
              look: 'shelf',
              shape: 'square',
              title: 'On this day',
              meta: 'Earlier years',
              items: squares('immich-day', [
                ['A year ago · Texel', '2025'],
                ['A year ago · Texel', '2025'],
                ['3 years ago · Lisbon', '2023'],
                ['3 years ago · Lisbon', '2023'],
                ['5 years ago · Utrecht', '2021'],
                ['5 years ago', '2021'],
                ['6 years ago · Texel', '2020'],
                ['6 years ago · Texel', '2020'],
                ['8 years ago · Ghent', '2018'],
                ['8 years ago · Ghent', '2018'],
                ['9 years ago', '2017'],
                ['10 years ago · Rome', '2016'],
              ]),
              empty: 'No photos from this day in earlier years.',
            },
            {
              kind: 'gallery',
              id: 'favourites',
              place: 'main',
              look: 'shelf',
              shape: 'square',
              title: 'Favourites',
              meta: 'A few at random',
              link: { kind: 'url', label: 'Open favourites', url: `${IMMICH_URL}/favorites` },
              items: squares('immich-fav', [
                ['Texel', 'June 2019'],
                ['Amsterdam', 'April 2024'],
                ['Porto', 'May 2022'],
                ['Zandvoort', 'August 2025'],
                ['Annecy', 'July 2023'],
                ['Utrecht', 'December 2024'],
                ['Bruges', 'March 2021'],
                ['Den Haag', 'September 2024'],
                ['Lisbon', 'May 2023'],
                ['Texel', 'July 2025'],
                ['Vlieland', 'June 2022'],
                ['Amsterdam', 'January 2026'],
              ]),
              empty: 'No favourites yet. Mark a photo with the heart in Immich.',
            },
          ],
        });
      },
      row: () => ({
        line: 'Photos · Immich 3.3.6',
        facts: [
          { label: 'Photos', value: '48,211' },
          { label: 'Disk', value: '78 %' },
        ],
        ...(resumed ? {} : { reason: 'The smart search queue is paused' }),
      }),
      action: ({ action, target }) => {
        if (action !== 'resume' || target !== 'smartSearch' || resumed) return null;
        resumed = true;
        return { message: 'Smart search goes on.', recorded: true };
      },
      checks: [
        { check: 'immich.disk_full', name: 'Disk filling up', nature: 'problem', perItem: false },
        { check: 'immich.queue_paused', name: 'Paused job queues', nature: 'you', perItem: true },
        { check: 'immich.jobs_failed', name: 'Failed jobs', nature: 'problem', perItem: true },
        { check: 'immich.integrity', name: 'Missing or changed files', nature: 'problem', perItem: false },
        { check: 'immich.update', name: 'Immich updates', nature: 'fyi', perItem: false },
      ],
    };
  },
};

/* Paperless-ngx ----------------------------------------------------------------------------------------------------- */

const PAPERLESS = 'connection:con_paperless';
const PAPERLESS_URL = 'http://10.100.0.20:8000';
/** Documents added per day this week, the oldest first. */
const PAPERLESS_WEEK = [2, 0, 5, 1, 3, 0, 3];

const paperless: FixtureServicePage = {
  thing: PAPERLESS,
  catalogId: 'paperless',
  name: 'Paperless-ngx',
  fields: { url: PAPERLESS_URL },
  make: (ctx) => {
    const { button, notice, week, page } = kit(ctx);
    let seen = false;
    const docs = (prefix: string, items: [string, string, string][]): ThingGalleryItem[] =>
      items.map(([title, from, when], i) => ({
        id: `doc-${prefix}-${i + 1}`,
        title,
        sub: `${from} · added ${when}`,
        image: fixtureImage('poster', `paperless-${prefix}-${i + 1}`, title),
        url: `${PAPERLESS_URL}/documents/${i + 1}/details`,
      }));
    return {
      page: () => {
        const markSeen = button({ action: 'seen', target: '41', label: 'Mark seen', icon: 'check' });
        const worth = seen
          ? []
          : [
              notice(
                {
                  id: 'failed-41',
                  tone: 'warn',
                  icon: 'warn',
                  title: 'scan-2026-11-03.pdf didn’t import',
                  detail: 'The file can’t be read. Yesterday 18:20.',
                  link: { kind: 'url', label: 'Show them', url: `${PAPERLESS_URL}/tasks` },
                  action: markSeen,
                  subject: { id: 'import:41', name: 'scan-2026-11-03.pdf' },
                },
                'you',
                'paperless.import_failed',
                'Until it’s marked seen.',
              ),
            ];
        return page({
          thing: PAPERLESS,
          catalogId: 'paperless',
          name: 'Paperless-ngx',
          status: seen ? 'ok' : 'warn',
          badge: seen ? '9 documents in the inbox' : 'An import failed',
          facts: [
            [{ text: 'Paperless-ngx ' }, { text: '3.4.2', strong: true }],
            [{ text: '1,284', strong: true }, { text: ' documents' }],
          ],
          address: '10.100.0.20:8000',
          url: PAPERLESS_URL,
          worth,
          panels: [
            {
              kind: 'gallery',
              id: 'inbox',
              place: 'chart',
              span: 2,
              look: 'rows',
              shape: 'square',
              title: 'In the inbox',
              meta: '9 waiting · 1 importing',
              link: {
                kind: 'url',
                label: 'Open the inbox',
                url: `${PAPERLESS_URL}/documents?sort=added&reverse=1`,
              },
              items: docs('inbox', [
                ['Energy bill November', 'Energy company', 'today 09:12'],
                ['Parking permit renewal', 'City council', 'yesterday 16:40'],
                ['Health insurance 2027', 'Health insurer', '2 Nov'],
                ['Payslip October', 'Employer', '1 Nov'],
              ]),
              empty: 'Nothing waits in the inbox.',
            },
            {
              kind: 'list',
              id: 'library',
              place: 'chart',
              span: 1,
              look: 'counts',
              title: 'In Paperless',
              items: [
                count('documents', 'Documents', '1,284', {
                  icon: 'log',
                  note: '+14 this week',
                  noteTone: 'ok',
                  url: `${PAPERLESS_URL}/documents`,
                }),
                count('correspondents', 'Correspondents', '96', {
                  icon: 'door',
                  url: `${PAPERLESS_URL}/correspondents`,
                }),
                count('tags', 'Tags', '41', {
                  icon: 'key',
                  url: `${PAPERLESS_URL}/tags`,
                }),
                count('types', 'Document types', '12', {
                  icon: 'media',
                  url: `${PAPERLESS_URL}/documenttypes`,
                }),
                count('paths', 'Storage paths', '3', {
                  icon: 'disk',
                  url: `${PAPERLESS_URL}/storagepaths`,
                }),
              ],
            },
            {
              kind: 'gallery',
              id: 'filed',
              place: 'chart',
              span: 3,
              look: 'shelf',
              shape: 'poster',
              title: 'Filed lately',
              meta: 'Newest first',
              link: {
                kind: 'url',
                label: 'Open documents',
                url: `${PAPERLESS_URL}/documents?sort=added&reverse=1`,
              },
              items: docs('filed', [
                ['Mortgage statement', 'Bank', '3 Nov'],
                ['Car insurance', 'Insurer', '3 Nov'],
                ['Gym membership', 'Sports club', '2 Nov'],
                ['Phone bill October', 'Phone company', '1 Nov'],
                ['Payslip September', 'Employer', '30 Oct'],
                ['Energy bill October', 'Energy company', '29 Oct'],
                ['Dentist invoice', 'Dentist', '28 Oct'],
                ['School trip', 'School', '27 Oct'],
                ['Bank statement', 'Bank', '27 Oct'],
                ['Water bill', 'Water company', '26 Oct'],
                ['Road tax', 'Tax office', '25 Oct'],
                ['Home insurance', 'Insurer', '24 Oct'],
              ]),
            },
            {
              kind: 'chart',
              id: 'week',
              place: 'chart',
              span: 1,
              title: 'This week',
              meta: 'Documents added per day',
              style: 'bars',
              ...week(),
              series: [{ key: 'values', label: 'Added', values: PAPERLESS_WEEK, color: 'blue' }],
              figure: { value: '14', rest: 'added this week' },
              stats: [[{ text: '+27 %', strong: true }, { text: ' on last week' }]],
              axis: { min: 0 },
            },
            {
              kind: 'bars',
              id: 'people',
              place: 'chart',
              span: 1,
              title: 'Who sends the most',
              meta: 'All time',
              items: [
                person(0, 'Energy company', '84 documents', 1, { note: 'Newest 4 Nov' }),
                person(1, 'Bank', '71 documents', 71 / 84, { note: 'Newest 3 Nov' }),
                person(2, 'Employer', '60 documents', 60 / 84, { note: 'Newest 1 Nov' }),
                person(3, 'City council', '38 documents', 38 / 84, { note: 'Newest 3 Nov' }),
                person(4, 'Health insurer', '25 documents', 25 / 84, { note: 'Newest 2 Nov' }),
              ],
            },
            {
              kind: 'bars',
              id: 'machine',
              place: 'chart',
              span: 1,
              title: 'Paperless-ngx itself',
              items: [
                {
                  id: 'paperless-version',
                  label: 'Paperless-ngx',
                  value: '3.4.2',
                  pct: null,
                  sub: 'Up to date',
                  subTone: 'ok',
                },
                {
                  id: 'documents-disk',
                  label: 'Documents disk',
                  value: '24 of 120 GB',
                  pct: 0.2,
                  sub: '96 GB free',
                },
                { id: 'database', label: 'Database', value: 'PostgreSQL', pct: null },
              ],
            },
            ...(seen
              ? []
              : [
                  {
                    kind: 'table' as const,
                    id: 'failed',
                    place: 'main' as const,
                    title: 'Failed imports',
                    meta: 'Not marked seen',
                    link: {
                      kind: 'url' as const,
                      label: 'Open Paperless-ngx',
                      url: `${PAPERLESS_URL}/tasks`,
                    },
                    columns: [
                      { key: 'file', label: 'File' },
                      { key: 'why', label: 'Why' },
                      { key: 'when', label: 'When' },
                      { key: 'seen', label: '' },
                    ],
                    rows: [
                      {
                        id: '41',
                        cells: {
                          file: { text: 'scan-2026-11-03.pdf', mono: true },
                          why: { text: 'The file can’t be read' },
                          when: { text: 'Yesterday 18:20' },
                          seen: { text: 'Mark seen', action: markSeen },
                        },
                      },
                    ],
                  },
                ]),
            {
              kind: 'list',
              id: 'checks',
              place: 'main',
              title: 'Paperless’s checks',
              meta: 'Version 3.4.2',
              buttons: [button({ action: 'sanity', label: 'Run sanity check', icon: 'check' })],
              items: [
                { id: 'database', title: 'Database', right: 'OK', tone: 'ok' },
                { id: 'redis', title: 'Redis', right: 'OK', tone: 'ok' },
                { id: 'celery', title: 'Worker', right: 'OK', tone: 'ok' },
                { id: 'index', title: 'Search index', detail: 'Updated 2 h ago', right: 'OK', tone: 'ok' },
                { id: 'classifier', title: 'Classifier', detail: 'Trained 5 h ago', right: 'OK', tone: 'ok' },
                { id: 'sanity', title: 'Sanity check', detail: 'Ran 3 days ago', right: 'OK', tone: 'ok' },
              ],
            },
          ],
        });
      },
      row: () => ({
        line: 'Documents · Paperless-ngx 3.4.2',
        facts: [
          { label: 'Inbox', value: '9' },
          { label: 'Failed imports', value: seen ? '0' : '1' },
        ],
        ...(seen ? {} : { reason: 'An import failed' }),
      }),
      action: ({ action, target }) => {
        if (action === 'sanity')
          return { message: 'Paperless-ngx is checking its documents. It takes a few minutes.' };
        if (action !== 'seen' || target !== '41' || seen) return null;
        seen = true;
        return { message: 'Marked as seen.', recorded: true };
      },
      checks: [
        { check: 'paperless.import_failed', name: 'Imports failing', nature: 'you', perItem: true },
        { check: 'paperless.health', name: 'Paperless’s own checks', nature: 'problem', perItem: true },
        { check: 'paperless.classifier', name: 'The classifier not training', nature: 'fyi', perItem: false },
        { check: 'paperless.disk_full', name: 'Disk filling up', nature: 'problem', perItem: false },
        { check: 'paperless.update', name: 'Paperless-ngx updates', nature: 'fyi', perItem: false },
      ],
    };
  },
};

/* Nextcloud --------------------------------------------------------------------------------------------------------- */

const NEXTCLOUD = 'connection:con_nextcloud';
const NEXTCLOUD_URL = 'https://cloud.example.com';

const nextcloud: FixtureServicePage = {
  thing: NEXTCLOUD,
  catalogId: 'nextcloud',
  name: 'Nextcloud',
  fields: { url: NEXTCLOUD_URL },
  make: (ctx) => {
    const { page, week } = kit(ctx);
    return {
      page: () =>
        page({
          thing: NEXTCLOUD,
          catalogId: 'nextcloud',
          name: 'Nextcloud',
          status: 'ok',
          badge: '2 people active today',
          facts: [
            [{ text: 'Nextcloud ' }, { text: '35.0.2', strong: true }],
            [{ text: '4', strong: true }, { text: ' users' }],
          ],
          address: 'cloud.example.com',
          url: NEXTCLOUD_URL,
          worth: [],
          panels: [
            {
              kind: 'list',
              id: 'cloud',
              place: 'chart',
              span: 1,
              look: 'counts',
              title: 'In Nextcloud',
              items: [
                count('files', 'Files', '48,210', { icon: 'disk', url: `${NEXTCLOUD_URL}/apps/files` }),
                count('users', 'Users', '4', {
                  icon: 'key',
                  detail: '3 this week · 1 turned off',
                  note: '2 on today',
                  noteTone: 'ok',
                  url: `${NEXTCLOUD_URL}/settings/users`,
                }),
                count('shares', 'Shares', '12', {
                  icon: 'network',
                  detail: '4 links · 8 with people',
                  note: '1 open link',
                  url: `${NEXTCLOUD_URL}/apps/files/sharingout`,
                }),
                count('apps', 'Apps', '51', {
                  icon: 'plug',
                  note: '2 updates waiting',
                  url: `${NEXTCLOUD_URL}/settings/apps/updates`,
                }),
              ],
            },
            // Space used, from Whombat's own readings of the free space: what was added each day.
            {
              kind: 'chart',
              id: 'week',
              place: 'chart',
              span: 1,
              title: 'Space used',
              meta: 'From its free space',
              style: 'bars',
              ...week(),
              series: [
                {
                  key: 'values',
                  label: 'Added',
                  values: [3.2, 1.1, null, 6.4, 0.8, 2.5, 1.4],
                  color: 'violet',
                  unit: 'GB',
                },
              ],
              figure: { value: '+15 GB', rest: 'this week' },
              axis: { min: 0 },
            },
            {
              kind: 'bars',
              id: 'people',
              place: 'chart',
              span: 1,
              title: 'Who uses most space',
              meta: '4 users',
              items: [
                person(0, 'Mara', '412 GB', 1, { note: 'On today' }),
                person(1, 'John', '188 GB', 188 / 412, { note: 'On today' }),
                person(2, 'Lotte', '9.2 GB', 9.2 / 412, {
                  note: 'Last seen 3 days ago',
                  tone: 'warn',
                  sub: 'Quota 10 GB',
                  subTone: 'warn',
                }),
                person(3, 'Sam', '1.1 GB', 1.1 / 412, { note: 'Turned off' }),
              ],
            },
            // Alone in its row: the server widens it and lays its lines side by side.
            {
              kind: 'bars',
              id: 'machine',
              place: 'chart',
              span: 3,
              columns: 3,
              title: 'Nextcloud itself',
              items: [
                {
                  id: 'nextcloud-version',
                  label: 'Nextcloud',
                  value: '35.0.2',
                  pct: null,
                  sub: 'Version 35.0.3 is out',
                },
                { id: 'free', label: 'Free for files', value: '1.8 TB', pct: null },
                { id: 'database', label: 'Database', value: 'MariaDB 11.4.3', pct: null, sub: '1.2 GB' },
              ],
            },
            {
              kind: 'list',
              id: 'apps',
              place: 'main',
              title: 'Apps with updates',
              meta: '51 apps installed',
              link: { kind: 'url', label: 'Open apps', url: `${NEXTCLOUD_URL}/settings/apps/updates` },
              items: [
                { id: 'app-calendar', title: 'calendar', right: '6.1.0', icon: 'update' },
                { id: 'app-deck', title: 'deck', right: '2.0.1', icon: 'update' },
              ],
            },
          ],
        }),
      row: () => ({
        line: 'Files · Nextcloud 35.0.2',
        facts: [
          { label: 'Active today', value: '2' },
          { label: 'Free space', value: '1.8 TB' },
        ],
      }),
      checks: [
        {
          check: 'nextcloud.not_admin',
          name: 'Connected without an admin account',
          nature: 'fyi',
          perItem: false,
        },
        { check: 'nextcloud.free', name: 'Free space running out', nature: 'problem', perItem: false },
        { check: 'nextcloud.update', name: 'Nextcloud updates', nature: 'fyi', perItem: false },
        { check: 'nextcloud.app_update', name: 'App updates', nature: 'fyi', perItem: false },
      ],
    };
  },
};

export const APPS_PAGES: FixtureServicePage[] = [immich, paperless, nextcloud];
