/**
 * Fixture pages of the biz-money group: Mollie, Moneybird, Plausible, HubSpot and Pipedrive, their Summary in slots as
 * the server builds it (`apps/server/src/things/kinds/business/`). Each entry shows in the web's and the phone's fixture
 * mode at `/things/<thing>` and in the sidebar; its shape and an example are in `types.ts`.
 */
import type {
  NoticeNature,
  ThingGalleryItem,
  ThingLine,
  ThingPage,
  ThingPageBar,
  ThingPageButton,
  ThingPageItem,
  ThingPageNotice,
  ThingPagePanel,
} from '@whombat/core/domain';
import type { FixtureServiceCtx, FixtureServicePage } from './types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LOOK_ONLY = 'Look only: changes are off for this connection.';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The page's head, as the server sends it for a cloud service (no machine). */
function head(
  ctx: FixtureServiceCtx,
  p: {
    id: `connection:${string}`;
    catalogId: string;
    name: string;
    status: ThingPage['status'];
    badge: string;
    facts: ThingLine[];
    address: string;
    open: string;
    panels: ThingPagePanel[];
  },
): ThingPage {
  return {
    id: p.id,
    kind: 'connection',
    connectionId: p.id.slice('connection:'.length) as ThingPage['connectionId'],
    catalogId: p.catalogId,
    name: p.name,
    icon: p.catalogId,
    status: p.status,
    badge: p.badge,
    facts: p.facts,
    address: p.address,
    open: { label: `Open ${p.name}`, url: p.open },
    runsOn: null,
    settings: true,
    actions: [],
    readAt: ctx.ago(4_000),
    tabs: [{ key: 'overview', label: 'Summary', panels: p.panels }],
  };
}

const strong = (b: string, rest: string): ThingLine => [{ text: b, strong: true }, { text: rest }];

/** A button as the page offers it: refused on Look only. */
const buttonOf =
  (ctx: FixtureServiceCtx) =>
  (b: Omit<ThingPageButton, 'allowed'>): ThingPageButton =>
    ctx.lookOnly ? { ...b, allowed: false, reason: LOOK_ONLY } : { ...b, allowed: true };

/** A Worth a look line with its kind and check; Ignore only for who may quiet it. */
const notice = (
  ctx: FixtureServiceCtx,
  n: ThingPageNotice,
  nature: NoticeNature,
  check: string,
  words: string,
): ThingPageNotice => ({
  ...n,
  nature,
  check,
  ...(ctx.lookOnly ? {} : { ignore: { lifts: 'fixed' as const, words } }),
});

const strip = (items: ThingPageNotice[]): ThingPagePanel[] =>
  items.length ? [{ kind: 'notices', id: 'worth', place: 'top', title: 'Worth a look', items }] : [];

/** The last 7 days' timestamps and words, today last. */
function week(ctx: FixtureServiceCtx): { timestamps: string[]; labels: string[] } {
  const days = Array.from({ length: 7 }, (_, i) => new Date(ctx.now() - (6 - i) * DAY));
  return {
    timestamps: days.map((d) => d.toISOString()),
    labels: days.map((d, i) => (i === 6 ? 'Today' : (WEEKDAYS[d.getDay()] ?? ''))),
  };
}

function trendPanel(
  ctx: FixtureServiceCtx,
  p: {
    title: string;
    meta: string;
    label: string;
    values: number[];
    figure: string;
    rest: string;
    change?: string;
    color: 'green' | 'blue' | 'violet';
  },
): ThingPagePanel {
  return {
    kind: 'chart',
    id: 'week',
    place: 'chart',
    span: 1,
    title: p.title,
    meta: p.meta,
    style: 'bars',
    ...week(ctx),
    series: [{ key: 'values', label: p.label, values: p.values, color: p.color }],
    figure: { value: p.figure, rest: p.rest },
    ...(p.change ? { stats: [[{ text: p.change, strong: true }, { text: ' on last week' }]] } : {}),
    axis: { min: 0 },
  };
}

/** A line of Inventory: its count large on the right with what changed under it. */
const count = (p: {
  id: string;
  title: string;
  icon?: ThingPageItem['icon'];
  detail?: string;
  value: string;
  note?: string;
  noteTone?: 'ok' | 'warn' | 'bad';
  tone?: ThingPageItem['tone'];
  url?: string;
}): ThingPageItem => ({
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
});

/** People: a bar each against the first. */
const peoplePanel = (
  title: string,
  meta: string,
  items: { name: string; n: number; value: string; note?: string; tone?: 'warn' }[],
): ThingPagePanel => ({
  kind: 'bars',
  id: 'people',
  place: 'chart',
  span: 1,
  title,
  meta,
  items: items.map(
    (i, k): ThingPageBar => ({
      id: `person-${k}`,
      label: i.name,
      person: true,
      ...(i.note ? { note: i.note } : {}),
      value: i.value,
      pct: i.n / (items[0]?.n ?? 1),
      ...(i.tone ? { tone: i.tone } : {}),
    }),
  ),
});

/* Mollie -------------------------------------------------------------------------------------------------------- */

const MOLLIE = 'https://my.mollie.com/dashboard';

const PAYMENTS: {
  id: string;
  title: string;
  detail: string;
  at: number;
  tone?: 'bad' | 'warn';
}[] = [
  { id: 'tr_9pQ2', title: '€ 89.00 · Order 1048', detail: 'Lotte Bakker · iDEAL', at: 6 * MIN },
  {
    id: 'tr_9pQ1',
    title: '€ 24.95 · Order 1047',
    detail: 'Failed · Tom Visser · Card',
    at: 38 * MIN,
    tone: 'bad',
  },
  { id: 'tr_9pP9', title: '€ 312.50 · Order 1046', detail: 'Anna Jansen · iDEAL', at: 1.5 * HOUR },
  { id: 'tr_9pP8', title: '€ 45.00 · Order 1045', detail: 'Apple Pay', at: 2 * HOUR },
  { id: 'tr_9pP7', title: '€ 129.00 · Order 1044', detail: 'Pieter de Wit · Bancontact', at: 3 * HOUR },
  {
    id: 'tr_9pP6',
    title: '€ 18.50 · Order 1043',
    detail: 'Refunded · Sara Mulder · PayPal',
    at: 5 * HOUR,
    tone: 'warn',
  },
];

function mollie(ctx: FixtureServiceCtx): ThingPage {
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const nowHour = new Date(ctx.now()).getHours();
  const start = new Date(ctx.now());
  start.setHours(0, 0, 0, 0);
  // Added up hour by hour: today so far, and the same weekday last week all day.
  const todayBy = [
    0, 0, 0, 0, 0, 0, 0, 45, 45, 120, 249, 249, 378, 523, 523, 612, 836, 925, 1012, 1012, 1101, 1180,
  ];
  const lastBy = [
    0, 0, 0, 0, 0, 0, 30, 30, 95, 180, 210, 310, 420, 470, 520, 640, 700, 760, 790, 840, 900, 930, 960,
  ];
  return head(ctx, {
    id: 'connection:con_mollie',
    catalogId: 'mollie',
    name: 'Mollie',
    status: 'bad',
    badge: 'Chargeback of € 89.00',
    facts: [
      strong('Live', ' payments'),
      [{ text: 'Last paid ' }, { text: '6 min', strong: true }, { text: ' ago' }],
    ],
    address: 'my.mollie.com',
    open: MOLLIE,
    panels: [
      ...strip([
        notice(
          ctx,
          {
            id: 'chargeback-chb_xs8w3s',
            tone: 'bad',
            icon: 'money',
            title: 'Chargeback of € 89.00',
            detail: 'The payer’s bank took it back on 2 Nov: Not received.',
            link: { kind: 'url', label: 'Open in Mollie', url: MOLLIE },
            subject: { id: 'chargeback:chb_xs8w3s', name: '€ 89.00 on 2 Nov' },
          },
          'you',
          'mollie.chargeback',
          'Until it’s reversed.',
        ),
      ]),
      {
        kind: 'list',
        id: 'payments',
        place: 'chart',
        span: 2,
        title: 'Payments today',
        meta: '€ 1,180 today · 14 paid · 1 failed',
        link: { kind: 'url', label: 'Open Mollie', url: MOLLIE },
        items: PAYMENTS.map(
          (p): ThingPageItem => ({
            id: p.id,
            title: p.title,
            detail: p.detail,
            icon: 'money',
            ...(p.tone ? { tone: p.tone } : {}),
            right: p.at < HOUR ? `${Math.round(p.at / MIN)} min ago` : `${Math.round(p.at / HOUR)} h ago`,
            at: ctx.ago(p.at),
            url: `${MOLLIE}/payments/${p.id}`,
          }),
        ),
        empty: 'No payments in the last 30 days.',
      },
      {
        kind: 'list',
        id: 'month',
        place: 'chart',
        span: 1,
        look: 'counts',
        title: 'This month',
        items: [
          count({
            id: 'paid',
            title: 'Paid',
            icon: 'money',
            detail: '214 payments',
            value: '€ 18,460',
            note: '+€ 6,100 this week',
            noteTone: 'ok',
            url: MOLLIE,
          }),
          count({
            id: 'refunded',
            title: 'Refunded',
            icon: 'info',
            detail: 'On 2 payments this month',
            value: '€ 74',
            url: MOLLIE,
          }),
          count({
            id: 'chargebacks',
            title: 'Chargebacks',
            icon: 'warn',
            detail: 'Last 30 days',
            value: '1',
            tone: 'bad',
            url: MOLLIE,
          }),
          count({
            id: 'payout',
            title: 'Next payout',
            icon: 'clock',
            detail: 'Next settlement',
            value: '€ 3,412',
            url: MOLLIE,
          }),
        ],
      },
      trendPanel(ctx, {
        title: 'This week',
        meta: 'Paid per day',
        label: 'Paid',
        values: [740, 1210, 980, 610, 450, 930, 1180],
        figure: '€ 6,100',
        rest: 'paid this week',
        change: '+12 %',
        color: 'green',
      }),
      peoplePanel('Who paid most', 'This month', [
        { name: 'Anna Jansen', n: 862, value: '€ 862', note: '4 payments' },
        { name: 'Lotte Bakker', n: 534, value: '€ 534', note: '3 payments' },
        { name: 'Pieter de Wit', n: 387, value: '€ 387', note: '3 payments' },
        { name: 'Sara Mulder', n: 74, value: '€ 74', note: '2 payments' },
      ]),
      {
        kind: 'chart',
        id: 'today',
        place: 'main',
        title: 'Today by the hour',
        meta: `Against last ${new Date(ctx.now()).toLocaleDateString('en-GB', { weekday: 'long' })}`,
        timestamps: hours.map((h) => new Date(start.getTime() + h * HOUR).toISOString()),
        labels: hours.map((h) => `${String(h).padStart(2, '0')}:00`),
        series: [
          {
            key: 'today',
            label: 'Today',
            values: hours.map((h) => (h <= nowHour ? (todayBy[Math.min(h, todayBy.length - 1)] ?? 0) : null)),
            color: 'green',
            latest: '€ 1,180',
          },
          {
            key: 'week',
            label: 'Last week',
            values: hours.map((h) => lastBy[Math.min(h, lastBy.length - 1)] ?? 0),
            color: 'grey',
            latest: '€ 930',
          },
        ],
        figure: { value: '€ 1,180', rest: 'so far today' },
        stats: [
          [{ text: '€ 930', strong: true }, { text: ' last week by now' }],
          [{ text: '27 %', strong: true }, { text: ' more' }],
        ],
        axis: { min: 0 },
      },
      {
        kind: 'list',
        id: 'refunds',
        place: 'main',
        title: 'Refunds and chargebacks',
        items: [
          {
            id: 'cb-chb_xs8w3s',
            title: 'Chargeback € 89.00',
            detail: 'Not received',
            at: ctx.ago(2 * DAY),
            tone: 'bad',
          },
          {
            id: 're-re_4qqhO8',
            title: 'Refund € 49.00',
            detail: 'Returned order 1031',
            at: ctx.ago(3 * DAY),
            right: 'Refunded',
          },
          {
            id: 're-re_4qqhO2',
            title: 'Refund € 25.00',
            detail: 'Order 1022',
            at: ctx.ago(9 * DAY),
            right: 'Refunded',
          },
        ],
        empty: 'No refunds or chargebacks.',
      },
    ],
  });
}

/* Moneybird ------------------------------------------------------------------------------------------------------ */

const MB = 'https://moneybird.com/123456789';

function moneybird(ctx: FixtureServiceCtx): ThingPage {
  const late: [string, string, string, string, number][] = [
    ['inv-12', 'Foobar Holding B.V.', '2026-0012', '€ 1,240.00 unpaid', 67],
    ['inv-19', 'Anna Jansen', '2026-0019', '€ 250.50 unpaid', 17],
    ['inv-23', 'Studio Noord', '2026-0023', '€ 605.00 unpaid', 4],
  ];
  return head(ctx, {
    id: 'connection:con_moneybird',
    catalogId: 'moneybird',
    name: 'Moneybird',
    status: 'ok',
    badge: '3 invoices overdue',
    facts: [strong('€ 4,155', ' outstanding'), strong('3', ' overdue')],
    address: 'moneybird.com',
    open: MB,
    panels: [
      {
        kind: 'gallery',
        id: 'overdue',
        place: 'chart',
        span: 2,
        look: 'rows',
        title: 'Overdue',
        meta: '3 overdue · € 2,096',
        shape: 'square',
        link: { kind: 'url', label: 'Open in Moneybird', url: `${MB}/sales_invoices` },
        items: late.map(
          ([id, who, number, unpaid, days]): ThingGalleryItem => ({
            id,
            title: who,
            sub: `Invoice ${number}`,
            badge: { text: `${days} days late`, tone: days > 30 ? 'bad' : 'warn' },
            note: `Sent ${new Date(ctx.now() - (days + 14) * DAY).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
            noteEnd: unpaid,
            url: `${MB}/sales_invoices/${id}`,
          }),
        ),
        empty: 'No invoice is late.',
      },
      {
        kind: 'list',
        id: 'todo',
        place: 'chart',
        span: 1,
        look: 'counts',
        title: 'To do',
        items: [
          count({
            id: 'outstanding',
            title: 'Outstanding',
            icon: 'money',
            detail: '6 invoices open',
            value: '€ 4,155',
            note: '+2 sent this week',
            noteTone: 'ok',
            url: `${MB}/sales_invoices`,
          }),
          count({
            id: 'bills',
            title: 'Bills to process',
            icon: 'log',
            detail: '€ 121 to pay',
            value: '2',
            url: MB,
          }),
          count({
            id: 'bank',
            title: 'Bank lines to match',
            icon: 'info',
            detail: 'Not yet booked',
            value: '14',
            url: MB,
          }),
        ],
      },
      trendPanel(ctx, {
        title: 'Money in',
        meta: 'On the bank, per day',
        label: 'In',
        values: [0, 860, 1240, 0, 350, 0, 605],
        figure: '€ 3,055',
        rest: 'came in this week',
        change: '+18 %',
        color: 'green',
      }),
      peoplePanel('Who owes most', 'Still open', [
        { name: 'Foobar Holding B.V.', n: 2100, value: '€ 2,100', note: '2 invoices · 1 late', tone: 'warn' },
        { name: 'Acme B.V.', n: 860, value: '€ 860', note: '1 invoice' },
        { name: 'Studio Noord', n: 605, value: '€ 605', note: '1 invoice · 1 late', tone: 'warn' },
        { name: 'Anna Jansen', n: 250.5, value: '€ 251', note: '1 invoice · 1 late', tone: 'warn' },
      ]),
      {
        kind: 'table',
        id: 'bills',
        place: 'main',
        title: 'Bills waiting',
        meta: '2 bills',
        columns: [
          { key: 'supplier', label: 'Supplier' },
          { key: 'amount', label: 'Amount', numeric: true },
          { key: 'due', label: 'Due' },
          { key: 'state', label: 'State' },
        ],
        rows: [
          {
            id: 'bill-1',
            cells: {
              supplier: { text: 'Hosting Co', note: 'INV-88812' },
              amount: { text: '€ 121.00', mono: true },
              due: { text: '24 Oct', tone: 'warn' },
              state: { text: 'To pay' },
            },
          },
          {
            id: 'bill-2',
            cells: {
              supplier: { text: 'Office Supplies' },
              amount: { text: '€ 38.40', mono: true },
              due: { text: '—', tone: 'muted' },
              state: { text: 'New' },
            },
          },
        ],
        empty: 'No bills waiting.',
      },
      {
        kind: 'list',
        id: 'bank',
        place: 'main',
        title: 'Bank lines to match',
        meta: '14 lines',
        items: [
          { id: 'm1', title: '+€ 350.00', detail: 'Acme B.V. · Invoice 2026-0021', at: ctx.ago(2 * DAY) },
          { id: 'm2', title: '−€ 45.95', detail: 'Hosting Co · Monthly hosting', at: ctx.ago(4 * DAY) },
          { id: 'm3', title: '−€ 12.10', detail: 'Coffee & Co', at: ctx.ago(5 * DAY) },
        ],
        empty: 'Every bank line is matched.',
      },
    ],
  });
}

/* Plausible ------------------------------------------------------------------------------------------------------ */

function plausible(ctx: FixtureServiceCtx): ThingPage {
  const site = 'https://plausible.io/example.com';
  const sources: [string, string][] = [
    ['Google', '412'],
    ['Direct / None', '230'],
    ['DuckDuckGo', '96'],
    ['news.ycombinator.com', '71'],
    ['Bing', '38'],
    ['LinkedIn', '24'],
  ];
  const pages: [string, number][] = [
    ['/', 520],
    ['/pricing', 214],
    ['/blog/plain-analytics', 160],
    ['/docs/start', 92],
    ['/about', 41],
    ['/changelog', 23],
  ];
  return head(ctx, {
    id: 'connection:con_plausible',
    catalogId: 'plausible',
    name: 'Plausible',
    status: 'ok',
    badge: '1,284 visitors today',
    facts: [[{ text: 'example.com', strong: true }]],
    address: 'plausible.io',
    open: site,
    panels: [
      {
        kind: 'list',
        id: 'pages',
        place: 'chart',
        span: 2,
        title: 'Top pages',
        meta: 'Today',
        link: { kind: 'url', label: 'Open Plausible', url: site },
        items: pages.map(([path, n], i) => ({
          id: `page-${i}`,
          title: path,
          icon: 'log' as const,
          detail: `${Math.round((n / 1284) * 100)} % of today’s visitors`,
          right: n.toLocaleString('en-US'),
        })),
        empty: 'No visits yet today.',
      },
      {
        kind: 'list',
        id: 'today',
        place: 'chart',
        span: 1,
        look: 'counts',
        title: 'Today',
        items: [
          count({
            id: 'now',
            title: 'Visitors now',
            icon: 'device',
            detail: 'In the last 5 minutes',
            value: '7',
            url: site,
          }),
          count({
            id: 'today',
            title: 'Visitors today',
            icon: 'clock',
            detail: 'So far today',
            value: '1,284',
            note: '+14 % on yesterday',
            noteTone: 'ok',
          }),
          count({
            id: 'bounce',
            title: 'Bounce rate',
            icon: 'info',
            detail: 'Left after one page',
            value: '34 %',
          }),
          count({
            id: 'time',
            title: 'Visit time',
            icon: 'clock',
            detail: 'A visit, on average',
            value: '1 min 32 s',
          }),
        ],
      },
      trendPanel(ctx, {
        title: 'This week',
        meta: 'Visitors per day',
        label: 'Visitors',
        values: [1120, 1342, 1260, 1188, 640, 702, 1284],
        figure: '1,077',
        rest: 'visitors a day',
        change: '+6 %',
        color: 'blue',
      }),
      {
        kind: 'bars',
        id: 'sources',
        place: 'main',
        title: 'Where they come from',
        meta: 'Today',
        items: sources.map(([name, n], i) => ({
          id: `source-${i}`,
          label: name,
          value: n,
          pct: Number(n) / 412,
        })),
        empty: 'No visits yet today.',
      },
    ],
  });
}

/* HubSpot and Pipedrive ------------------------------------------------------------------------------------------- */

interface CrmWorld {
  thing: `connection:${string}`;
  catalogId: 'hubspot' | 'pipedrive';
  name: string;
  home: string;
  deal: (id: string) => string;
  task: string;
  newWord: [string, string];
  newPer: number[];
  stages: [string, number, number, string?][];
}

/** The same deals' stages as Pipedrive names them, with their pipeline (it has two). */
const PIPEDRIVE_STAGE: Record<string, string> = {
  'Contract sent': 'Negotiations started · Sales',
  'Presentation scheduled': 'Proposal made · Sales',
  'Qualified to buy': 'Lead in · Sales',
};

const CRMS: CrmWorld[] = [
  {
    thing: 'connection:con_hubspot',
    catalogId: 'hubspot',
    name: 'HubSpot',
    home: 'https://app-eu1.hubspot.com/',
    deal: (id) => `https://app-eu1.hubspot.com/contacts/4455667/record/0-3/${id}`,
    task: 'task',
    newWord: ['contact', 'contacts'],
    newPer: [2, 4, 1, 3, 0, 1, 2],
    stages: [
      ['Appointment scheduled', 4, 9200],
      ['Qualified to buy', 3, 14500],
      ['Presentation scheduled', 2, 18000],
      ['Contract sent', 2, 31000],
    ],
  },
  {
    thing: 'connection:con_pipedrive',
    catalogId: 'pipedrive',
    name: 'Pipedrive',
    home: 'https://example.pipedrive.com/',
    deal: (id) => `https://example.pipedrive.com/deal/${id}`,
    task: 'activity',
    newWord: ['deal', 'deals'],
    newPer: [1, 0, 2, 1, 0, 0, 1],
    stages: [
      ['Lead in', 3, 6400, 'Sales'],
      ['Proposal made', 2, 24000, 'Sales'],
      ['Negotiations started', 1, 18000, 'Sales'],
      ['Signed up', 2, 1600, 'Partners'],
    ],
  },
];

const TASKS: { id: string; subject: string; deal: string | null; dealId: string | null; days: number }[] = [
  {
    id: '7003',
    subject: 'Send the signed contract',
    deal: 'Foobar Holding – website',
    dealId: '9001',
    days: 12,
  },
  { id: '7001', subject: 'Call back about the quote', deal: 'Initech – rebuild', dealId: '9004', days: 9 },
  { id: '7002', subject: 'Follow up on the demo', deal: 'Acme – support', dealId: '9002', days: 3 },
  { id: '7005', subject: 'Book the kick-off', deal: null, dealId: null, days: 0 },
];

function crm(ctx: FixtureServiceCtx, w: CrmWorld, done: Set<string>): ThingPage {
  const button = buttonOf(ctx);
  const open = TASKS.filter((t) => !done.has(t.id));
  const old = open.filter((t) => t.days > 7);
  const newWeek = w.newPer.reduce((a, b) => a + b, 0);
  const total = w.stages.reduce((a, s) => a + s[2], 0);
  const count_ = w.stages.reduce((a, s) => a + s[1], 0);
  const biggest: [string, string, string, number][] = [
    ['9001', 'Foobar Holding – website', 'Contract sent', 18000],
    ['9006', 'Globex – platform', 'Presentation scheduled', 12500],
    ['9004', 'Initech – rebuild', 'Contract sent', 9000],
    ['9002', 'Acme – support', 'Qualified to buy', 6200],
    ['9008', 'Studio Noord – shop', 'Qualified to buy', 4800],
  ];
  const euros = (n: number) => `€ ${n.toLocaleString('en-US')}`;
  return head(ctx, {
    id: w.thing,
    catalogId: w.catalogId,
    name: w.name,
    status: 'ok',
    badge: open.length ? `${open.length} overdue` : 'Nothing overdue',
    facts: [strong(String(count_), ' open deals'), strong('2', ' won this month')],
    address: new URL(w.home).host,
    open: w.home,
    panels: [
      // Overdue tasks' Worth a look lines start off: Live carries them.
      {
        kind: 'list',
        id: 'overdue',
        place: 'chart',
        span: 2,
        title: 'Overdue',
        ...(open.length
          ? {
              meta: [`${open.length} overdue`, old.length ? `${old.length} over a week` : null]
                .filter(Boolean)
                .join(' · '),
            }
          : {}),
        link: { kind: 'url', label: `Open ${w.name}`, url: w.home },
        items: open.map(
          (t): ThingPageItem => ({
            id: t.id,
            title: t.subject,
            detail: [t.deal ? `About ${t.deal}` : null, t.days ? `due ${t.days} days ago` : 'due today 09:30']
              .filter(Boolean)
              .join(' · '),
            icon: 'clock',
            ...(t.days > 7 ? { tone: 'warn' as const } : {}),
            ...(t.dealId ? { url: w.deal(t.dealId) } : {}),
            actions: [button({ action: 'done', target: t.id, label: 'Done', icon: 'check' })],
          }),
        ),
        empty: `No ${w.task} is overdue.`,
      },
      {
        kind: 'list',
        id: 'deals',
        place: 'chart',
        span: 1,
        look: 'counts',
        title: 'Deals',
        items: [
          count({
            id: 'open',
            title: 'Open deals',
            icon: 'money',
            detail: `${count_} deals`,
            value: euros(total),
            note: '+3 this week',
            noteTone: 'ok',
            url: w.home,
          }),
          count({
            id: 'won',
            title: 'Won this month',
            icon: 'money',
            detail: '2 deals',
            value: '€ 6,500',
            note: '+1 this week',
            noteTone: 'ok',
            url: w.home,
          }),
          count({
            id: 'new',
            title: `New ${w.newWord[1]}`,
            icon: 'log',
            detail: 'Last 7 days',
            value: String(newWeek),
            url: w.home,
          }),
        ],
      },
      trendPanel(ctx, {
        title: 'This week',
        meta: `New ${w.newWord[1]} per day`,
        label: `New ${w.newWord[1]}`,
        values: w.newPer,
        figure: String(newWeek),
        rest: `new ${newWeek === 1 ? w.newWord[0] : w.newWord[1]} this week`,
        change: '+25 %',
        color: 'violet',
      }),
      {
        kind: 'bars',
        id: 'pipeline',
        place: 'main',
        title: 'Pipeline',
        meta: `${count_} open · ${euros(total)}`,
        link: { kind: 'url', label: `Open ${w.name}`, url: w.home },
        items: w.stages.map(([label, n, sum, pipeline], i) => ({
          id: `stage-${i}`,
          label,
          ...(pipeline ? { note: pipeline } : {}),
          value: `${n} · ${euros(sum)}`,
          pct: sum / Math.max(...w.stages.map((s) => s[2])),
        })),
        empty: 'No open deals.',
      },
      {
        kind: 'list',
        id: 'biggest',
        place: 'main',
        title: 'Biggest open deals',
        items: biggest.map(([id, name, stage, sum]) => ({
          id: `deal-${id}`,
          title: name,
          detail: w.catalogId === 'pipedrive' ? (PIPEDRIVE_STAGE[stage] ?? stage) : stage,
          icon: 'money' as const,
          right: euros(sum),
          url: w.deal(id),
        })),
      },
    ],
  });
}

const CRM_PAGES: FixtureServicePage[] = CRMS.map((w) => ({
  thing: w.thing,
  catalogId: w.catalogId,
  name: w.name,
  fields: { url: w.home },
  make: (ctx) => {
    const done = new Set<string>();
    return {
      page: () => crm(ctx, w, done),
      row: () => {
        const n = TASKS.length - done.size;
        return {
          line: n ? `${n} overdue · ${w.stages.reduce((a, s) => a + s[1], 0)} open deals` : 'Nothing overdue',
          facts: [
            {
              label: 'Open deals',
              value: `€ ${w.stages.reduce((a, s) => a + s[2], 0).toLocaleString('en-US')}`,
            },
            { label: w.catalogId === 'hubspot' ? 'Overdue tasks' : 'Overdue activities', value: String(n) },
          ],
        };
      },
      action: ({ action, target }) => {
        if (action !== 'done' || typeof target !== 'string' || done.has(target)) return null;
        const task = TASKS.find((t) => t.id === target);
        if (!task) return null;
        done.add(target);
        return { message: `Marked done in ${w.name}.`, recorded: true };
      },
      checks: [
        {
          check: 'crm.overdue',
          name: w.catalogId === 'hubspot' ? 'Tasks over a week overdue' : 'Activities over a week overdue',
          nature: 'fyi',
          perItem: true,
        },
      ],
    };
  },
}));

export const BIZ_MONEY_PAGES: FixtureServicePage[] = [
  {
    thing: 'connection:con_mollie',
    catalogId: 'mollie',
    name: 'Mollie',
    make: (ctx) => ({
      page: () => mollie(ctx),
      row: () => ({
        line: '€ 1,180 today',
        facts: [
          { label: 'Paid today', value: '€ 1,180' },
          { label: 'This month', value: '€ 18,460' },
        ],
        reason: 'Chargeback of € 89.00',
      }),
      checks: [
        { check: 'mollie.chargeback', name: 'Chargebacks', nature: 'you', perItem: true },
        {
          check: 'mollie.payments_failing',
          name: 'Many payments failing today',
          nature: 'problem',
          perItem: false,
        },
        { check: 'mollie.test_mode', name: 'Only test payments', nature: 'fyi', perItem: false },
      ],
    }),
  },
  {
    thing: 'connection:con_moneybird',
    catalogId: 'moneybird',
    name: 'Moneybird',
    fields: { administration: '123456789' },
    make: (ctx) => ({
      page: () => moneybird(ctx),
      row: () => ({
        line: '3 invoices overdue',
        facts: [
          { label: 'Outstanding', value: '€ 4,155' },
          { label: 'Overdue', value: '3' },
        ],
      }),
      checks: [
        { check: 'moneybird.invoice_late', name: 'Invoices over 30 days late', nature: 'you', perItem: true },
        { check: 'moneybird.bank_to_match', name: 'Many bank lines to match', nature: 'fyi', perItem: false },
      ],
    }),
  },
  {
    thing: 'connection:con_plausible',
    catalogId: 'plausible',
    name: 'Plausible',
    fields: { url: 'https://plausible.io', site: 'example.com' },
    make: (ctx) => ({
      page: () => plausible(ctx),
      row: () => ({
        line: '1,284 visitors today',
        facts: [
          { label: 'Visitors now', value: '7' },
          { label: 'Today', value: '1,284' },
        ],
      }),
      checks: [
        {
          check: 'plausible.no_visitors',
          name: 'A busy site with no visitors today',
          nature: 'problem',
          perItem: true,
        },
      ],
    }),
  },
  ...CRM_PAGES,
];
