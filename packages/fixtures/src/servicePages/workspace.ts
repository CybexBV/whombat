/**
 * Fixture pages of the workspace group: Notion, Airtable and Dropbox, their Summary in slots as the server builds it
 * (`apps/server/src/things/kinds/workspace/`). Each entry shows in the web's and the phone's fixture mode at
 * `/things/<thing>` and in the sidebar; its shape and an example are in `types.ts`.
 */
import type { ThingLine, ThingPage, ThingPageItem, ThingPagePanel } from '@whombat/core/domain';
import type { FixtureServiceCtx, FixtureServicePage } from './types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const bold = (text: string) => ({ text, strong: true });
const plain = (text: string) => ({ text });

/** The page's head, as the server answers it. */
function headOf(
  ctx: FixtureServiceCtx,
  p: {
    name: string;
    catalogId: string;
    badge: string;
    facts: ThingLine[];
    address: string;
    open: { label: string; url: string };
    readAgo?: number;
  },
): Omit<ThingPage, 'tabs'> {
  const id = `connection:con_${p.catalogId}` as const;
  return {
    id,
    kind: 'connection',
    connectionId: id.slice('connection:'.length) as ThingPage['connectionId'],
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
    readAt: ctx.ago(p.readAgo ?? 40_000),
  };
}

const summary = (panels: ThingPagePanel[]) => [{ key: 'overview', label: 'Summary', panels }];

/** An Inventory line: its count large on the right with what changed under it. */
function count(p: {
  id: string;
  title: string;
  value: string;
  note?: string;
  noteTone?: 'ok' | 'warn' | 'bad';
  detail?: string;
  tone?: 'ok' | 'warn' | 'bad';
  icon?: ThingPageItem['icon'];
  url?: string;
}): ThingPageItem {
  return {
    id: p.id,
    title: p.title,
    ...(p.icon ? { icon: p.icon } : {}),
    ...(p.detail ? { detail: p.detail } : {}),
    ...(p.tone ? { tone: p.tone } : {}),
    right: p.value,
    figure: {
      value: p.value,
      ...(p.note ? { note: p.note } : {}),
      ...(p.noteTone ? { tone: p.noteTone } : {}),
    },
    ...(p.url ? { url: p.url } : {}),
  };
}

/** This week's Trend: a bar per day, today last. */
function week(
  ctx: FixtureServiceCtx,
  p: {
    title: string;
    meta: string;
    label: string;
    values: number[];
    figure: { value: string; rest: string };
    change?: string;
    color: 'blue' | 'violet';
    unit?: string;
  },
): ThingPagePanel {
  const days = p.values.map((_, i) => new Date(ctx.now() - (p.values.length - 1 - i) * DAY));
  return {
    kind: 'chart',
    id: 'week',
    place: 'chart',
    span: 1,
    title: p.title,
    meta: p.meta,
    style: 'bars',
    timestamps: days.map((d) => d.toISOString()),
    labels: days.map((d, i) => (i === days.length - 1 ? 'Today' : (WEEKDAYS[d.getDay()] ?? ''))),
    series: [
      {
        key: 'values',
        label: p.label,
        values: p.values,
        color: p.color,
        ...(p.unit ? { unit: p.unit } : {}),
      },
    ],
    figure: p.figure,
    ...(p.change ? { stats: [[bold(p.change), plain(' on last week')]] } : {}),
    axis: { min: 0 },
  };
}

/** “Today 14:05”, “Yesterday 18:00”, “17 Oct”, as the server's `when`. */
function whenAgo(ctx: FixtureServiceCtx, ms: number): string {
  const at = new Date(ctx.now() - ms);
  const now = new Date(ctx.now());
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(at, now)) return `Today ${clock}`;
  if (sameDay(at, new Date(ctx.now() - DAY))) return `Yesterday ${clock}`;
  return `${at.getDate()} ${MONTHS[at.getMonth()]}`;
}

/* Notion: signed in with an access token -------------------------------------------------------------------------- */

const NOTION = 'https://www.notion.so/';
/** Title, page or database, who changed it, how long ago. */
const EDITED: [string, 'page' | 'database', string, number][] = [
  ['Launch plan', 'page', 'Anna de Vries', 25 * MIN],
  ['Tasks', 'database', 'Sam Okafor', 2 * HOUR],
  ['Weekly sync notes', 'page', 'Lena Hoffmann', 4 * HOUR],
  ['Hiring: product designer', 'page', 'Anna de Vries', 6 * HOUR],
  ['Content calendar', 'database', 'Sam Okafor', 26 * HOUR],
  ['Onboarding checklist', 'page', 'Whombat', 30 * HOUR],
  ['Q4 goals', 'page', 'Anna de Vries', 3 * DAY],
  ['Office move', 'page', 'Lena Hoffmann', 4 * DAY],
];

const notion: FixtureServicePage = {
  thing: 'connection:con_notion',
  catalogId: 'notion',
  name: 'Notion',
  make: (ctx) => {
    const today = EDITED.filter(([, , , ago]) => whenAgo(ctx, ago).startsWith('Today')).length;
    return {
      page: () => ({
        ...headOf(ctx, {
          name: 'Notion',
          catalogId: 'notion',
          badge: today ? `${today} ${today === 1 ? 'page' : 'pages'} changed today` : 'Nothing changed today',
          facts: [[bold('Acme')], [bold(String(today)), plain(' changed today')]],
          address: 'notion.so',
          open: { label: 'Open Notion', url: NOTION },
        }),
        tabs: summary([
          {
            kind: 'list',
            id: 'recent',
            place: 'chart',
            span: 2,
            title: 'Edited lately',
            meta: today ? `${today} changed today` : 'Nothing changed today',
            link: { kind: 'url', label: 'Open Notion', url: NOTION },
            items: EDITED.map(([title, kind, who, ago], i) => ({
              id: `notion-${i}`,
              title,
              icon: kind === 'database' ? 'database' : 'log',
              detail: `${kind === 'database' ? 'Database' : 'Page'} · ${who}`,
              right: whenAgo(ctx, ago),
              url: `${NOTION}${title.replace(/[^A-Za-z0-9]+/g, '-')}-2a1b6c3d4e5f4a6b8c7d1e2f3a4b5c0${i}`,
            })),
            empty: 'Nothing is shared with Whombat yet. In Notion, share pages with its connection.',
          },
          {
            kind: 'list',
            id: 'counts',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'In Notion',
            meta: 'What is shared with Whombat',
            items: [
              count({
                id: 'pages',
                title: 'Pages',
                icon: 'log',
                value: '100+',
                note: '23 changed this week',
                noteTone: 'ok',
              }),
              count({
                id: 'databases',
                title: 'Databases',
                icon: 'database',
                value: '12',
                note: '3 changed this week',
                noteTone: 'ok',
              }),
              count({ id: 'people', title: 'People', icon: 'key', detail: 'Members and guests', value: '8' }),
            ],
          },
          week(ctx, {
            title: 'Edits this week',
            meta: 'Pages and databases changed per day',
            label: 'Changed',
            values: [5, 9, 7, 2, 1, 6, today],
            figure: { value: String(30 + today), rest: 'pages changed' },
            change: '+12 %',
            color: 'blue',
          }),
          {
            kind: 'bars',
            id: 'people',
            place: 'chart',
            span: 1,
            title: 'Who edits most',
            meta: 'Who last changed each page',
            items: [
              ['Anna de Vries', 41],
              ['Sam Okafor', 27],
              ['Lena Hoffmann', 19],
              ['Whombat', 6],
            ].map(([name, n], i) => ({
              id: `person-${i}`,
              label: name as string,
              person: true,
              value: `${n} pages`,
              pct: (n as number) / 41,
            })),
          },
        ]),
      }),
      row: () => ({
        line: `${today} changed today`,
        facts: [
          { label: 'Changed today', value: String(today) },
          { label: 'Pages', value: '100+' },
        ],
      }),
      checks: [],
    };
  },
};

/* Airtable: signed in with Airtable, read an hour ago at most -------------------------------------------------------- */

const AIRTABLE = 'https://airtable.com/';
/** Name, id, tables (null: not counted), the connection's access. */
const BASES: [string, string, number | null, string][] = [
  ['Content calendar', 'appQ8v2nRtP4mKx1a', 6, 'Creator'],
  ['Hiring pipeline', 'appLkNDICXNqxSDhG', 4, 'Editor'],
  ['Product roadmap', 'appSW9R5uCNmRmfl6', 3, 'Editor'],
  ['Office inventory', 'appT3mQ9xLw2Rb7Kc', 2, 'Commenter'],
  ['Event planning', 'appV5nH8pYz4Jd1Fe', 5, 'Read only'],
  ['Sales pipeline', 'appW6kJ2qRx8Mt3Gh', null, 'Editor'],
  ['Customer portal', 'appZ7kD3wHs9LpQ2b', null, 'Interface only'],
];

const airtable: FixtureServicePage = {
  thing: 'connection:con_airtable',
  catalogId: 'airtable',
  name: 'Airtable',
  make: (ctx) => ({
    page: () => ({
      ...headOf(ctx, {
        name: 'Airtable',
        catalogId: 'airtable',
        badge: '7 bases',
        facts: [[bold('7'), plain(' bases · '), bold('20+'), plain(' tables')]],
        address: 'airtable.com',
        open: { label: 'Open Airtable', url: AIRTABLE },
        readAgo: 23 * MIN,
      }),
      tabs: summary([
        {
          kind: 'list',
          id: 'bases',
          place: 'chart',
          span: 2,
          title: 'Your bases',
          link: { kind: 'url', label: 'Open Airtable', url: AIRTABLE },
          items: BASES.map(([name, id, tables, access]) => ({
            id,
            title: name,
            icon: 'database',
            ...(tables !== null ? { detail: `${tables} ${tables === 1 ? 'table' : 'tables'}` } : {}),
            right: access,
            url: `${AIRTABLE}${id}`,
          })),
          empty: 'No bases yet.',
        },
        {
          kind: 'list',
          id: 'counts',
          place: 'chart',
          span: 1,
          look: 'counts',
          title: 'In Airtable',
          meta: 'The bases you can open',
          items: [
            count({ id: 'bases', title: 'Bases', icon: 'database', value: '7' }),
            count({
              id: 'tables',
              title: 'Tables',
              icon: 'log',
              detail: 'In the first 5 bases',
              value: '20+',
            }),
          ],
        },
      ]),
    }),
    row: () => ({
      line: '7 bases · 20+ tables',
      facts: [
        { label: 'Bases', value: '7' },
        { label: 'Tables', value: '20+' },
      ],
    }),
    checks: [],
  }),
};

/* Dropbox: 62 % of 2 TB used ---------------------------------------------------------------------------------------- */

const DROPBOX = 'https://www.dropbox.com/home';
/** Name, icon, size, how long ago. */
const CHANGED: [string, ThingPageItem['icon'], string, number][] = [
  ['Quarterly report.pdf', 'log', '2.4 MB', 3 * HOUR],
  ['Invoice 2026-118.pdf', 'log', '182 kB', 22 * HOUR],
  ['IMG_2208.jpg', 'photo', '3 MB', 4 * DAY],
  ['Garden plans.xlsx', 'log', '64 kB', 9 * DAY],
  ['Voice memo.m4a', 'music', '5 MB', 17 * DAY],
];

const dropbox: FixtureServicePage = {
  thing: 'connection:con_dropbox',
  catalogId: 'dropbox',
  name: 'Dropbox',
  make: (ctx) => ({
    page: () => ({
      ...headOf(ctx, {
        name: 'Dropbox',
        catalogId: 'dropbox',
        badge: '62 % used',
        facts: [[bold('1.2 TB'), plain(' of 2.0 TB used')]],
        address: 'dropbox.com',
        open: { label: 'Open Dropbox', url: DROPBOX },
      }),
      tabs: summary([
        {
          kind: 'list',
          id: 'changed',
          place: 'chart',
          span: 2,
          title: 'Changed lately',
          meta: 'Files at the top of your Dropbox',
          link: { kind: 'url', label: 'Open Dropbox', url: DROPBOX },
          items: CHANGED.map(([title, icon, size, ago], i) => ({
            id: `file-${i}`,
            title,
            ...(icon ? { icon } : {}),
            detail: size,
            right: whenAgo(ctx, ago),
          })),
        },
        {
          kind: 'list',
          id: 'counts',
          place: 'chart',
          span: 1,
          look: 'counts',
          title: 'In Dropbox',
          items: [
            count({
              id: 'space',
              title: 'Space used',
              icon: 'disk',
              value: '62 %',
              note: '1.2 of 2.0 TB',
              url: DROPBOX,
            }),
            count({
              id: 'folders',
              title: 'Folders',
              icon: 'disk',
              detail: 'At the top',
              value: '9',
              note: '4 files beside them',
            }),
            count({ id: 'links', title: 'Shared links', icon: 'network', value: '14' }),
          ],
        },
        week(ctx, {
          title: 'Space used',
          meta: 'Full in about 18 months',
          label: 'Added',
          values: [1.2, 0.4, 2.8, 0.9, 0, 3.1, 1.5],
          figure: { value: '+9.9 GB', rest: 'this week' },
          change: '+18 %',
          color: 'violet',
          unit: 'GB',
        }),
      ]),
    }),
    row: () => ({
      line: '62 % used',
      facts: [{ label: 'Space used', value: '62 %', note: '1.2 of 2.0 TB' }],
    }),
    checks: [{ check: 'dropbox.space', name: 'Dropbox is almost full', nature: 'problem', perItem: false }],
  }),
};

export const WORKSPACE_PAGES: FixtureServicePage[] = [notion, airtable, dropbox];
