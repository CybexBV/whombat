/**
 * Fixture pages of the biz-dev group: GitLab, Forgejo, GitHub Actions, Todoist and T3 Code, their Summary in slots as
 * the server builds it (`apps/server/src/things/kinds/business/`). Each entry shows in the web's and the phone's
 * fixture mode at `/things/<thing>` and in the sidebar; its shape and an example are in `types.ts`.
 */
import type {
  ThingGalleryItem,
  ThingLine,
  ThingPage,
  ThingPageBar,
  ThingPageButton,
  ThingPageItem,
  ThingPageNotice,
  ThingPagePanel,
} from '@whombat/core/domain';
import { thingHref } from '@whombat/core/domain';
import type { FixtureServiceCtx, FixtureServicePage } from './types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LOOK_ONLY = 'Look only: changes are off for this connection.';

/** A button as the page offers it: disabled on Look only. */
const buttonOf =
  (ctx: FixtureServiceCtx) =>
  (b: Omit<ThingPageButton, 'allowed'>): ThingPageButton =>
    ctx.lookOnly ? { ...b, allowed: false, reason: LOOK_ONLY } : { ...b, allowed: true };

const bold = (text: string) => ({ text, strong: true });
const plain = (text: string) => ({ text });

/** The page's head, as the server answers it. */
function headOf(
  ctx: FixtureServiceCtx,
  p: {
    name: string;
    catalogId: string;
    status: ThingPage['status'];
    badge: string;
    facts: ThingLine[];
    address: string;
    open: { label: string; url: string };
  },
): Omit<ThingPage, 'tabs'> {
  const id = `connection:con_${p.catalogId.replace(/_/g, '-')}` as const;
  return {
    id,
    kind: 'connection',
    connectionId: id.slice('connection:'.length) as ThingPage['connectionId'],
    catalogId: p.catalogId,
    name: p.name,
    icon: p.catalogId,
    status: p.status,
    badge: p.badge,
    facts: p.facts,
    address: p.address,
    open: p.open,
    runsOn: null,
    settings: true,
    actions: [],
    readAt: ctx.ago(20_000),
  };
}

const summary = (panels: ThingPagePanel[]) => [{ key: 'overview', label: 'Summary', panels }];

/** Worth a look as the page's strip, left out without a line. */
const worth = (items: ThingPageNotice[]): ThingPagePanel[] =>
  items.length ? [{ kind: 'notices', id: 'worth', place: 'top', title: 'Worth a look', items }] : [];

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
  };
}

/** This week's Trend: a bar per day, today last. */
function week(
  ctx: FixtureServiceCtx,
  p: {
    title?: string;
    meta: string;
    label: string;
    values: number[];
    figure: { value: string; rest: string };
    change?: string;
    failed?: number;
    color: 'blue' | 'green' | 'violet';
  },
): ThingPagePanel {
  const days = p.values.map((_, i) => new Date(ctx.now() - (p.values.length - 1 - i) * DAY));
  const stats: ThingLine[] = [];
  if (p.change) stats.push([bold(p.change), plain(' on last week')]);
  if (p.failed) stats.push([bold(String(p.failed)), plain(' failed')]);
  return {
    kind: 'chart',
    id: 'week',
    place: 'chart',
    span: 1,
    title: p.title ?? 'This week',
    meta: p.meta,
    style: 'bars',
    timestamps: days.map((d) => d.toISOString()),
    labels: days.map((d, i) => (i === days.length - 1 ? 'Today' : (WEEKDAYS[d.getDay()] ?? ''))),
    series: [{ key: 'values', label: p.label, values: p.values, color: p.color }],
    figure: p.figure,
    ...(stats.length ? { stats } : {}),
    axis: { min: 0 },
  };
}

/** “<name> itself”: the service's own lines when Whombat knows no machine it runs on. */
const itself = (name: string, items: ThingPageBar[]): ThingPagePanel => ({
  kind: 'bars',
  id: 'machine',
  place: 'chart',
  span: 1,
  title: `${name} itself`,
  items,
});

/* GitLab: self-hosted on thetitan --------------------------------------------------------------------------------- */

const GITLAB = 'https://gitlab.example.com';
const REVIEWS: [string, string, string, number, boolean?][] = [
  ['New header for the home page', 'acme/web', 'Anna de Vries', 3 * DAY],
  ['Rate limits for the public API', 'acme/api', 'Sam Okafor', 26 * HOUR, true],
  ['Translate the checkout into German', 'acme/web', 'Lena Hoffmann', 5 * HOUR],
  ['Faster image thumbnails', 'acme/media', 'Sam Okafor', 40 * MIN],
];

const gitlab: FixtureServicePage = {
  thing: 'connection:con_gitlab',
  catalogId: 'gitlab',
  name: 'GitLab',
  fields: { url: GITLAB },
  make: (ctx) => {
    const button = buttonOf(ctx);
    let retried = false;
    const runner: ThingPageNotice = {
      id: 'runner-12',
      tone: 'warn',
      icon: 'power',
      title: 'Runner build-02 is offline',
      link: { kind: 'ask', label: 'Look into it', question: 'Why is the GitLab runner build-02 offline?' },
      nature: 'problem',
      check: 'git.runner_offline',
      subject: { id: 'runner:12', name: 'build-02' },
      ...(ctx.lookOnly ? {} : { ignore: { lifts: 'fixed', words: 'Until it’s back online.' } }),
    };
    const page = (): ThingPage => {
      const failing: ThingPageItem[] = retried
        ? []
        : [
            {
              id: 'failing-101/5501',
              title: 'acme/web · main',
              icon: 'warn',
              tone: 'bad',
              detail: 'Its last pipeline failed 2 h ago',
              right: 'Failing',
              url: `${GITLAB}/acme/web/-/pipelines/5501`,
              actions: [button({ action: 'retry', target: '101/5501', label: 'Retry', icon: 'retry' })],
            },
          ];
      const reviews = REVIEWS.map(
        ([title, project, author, age, draft], i): ThingPageItem => ({
          id: `review-${700 + i}`,
          title,
          detail: `${project} · ${author} · open ${age >= 2 * DAY ? `${Math.round(age / DAY)} days` : age >= HOUR ? `${Math.round(age / HOUR)} h` : `${Math.round(age / MIN)} min`}`,
          ...(draft ? { right: 'Draft' } : {}),
          url: `${GITLAB}/${project}/-/merge_requests/${40 + i}`,
        }),
      );
      return {
        ...headOf(ctx, {
          name: 'GitLab',
          catalogId: 'gitlab',
          status: 'warn',
          badge: 'A runner is offline',
          facts: [
            [plain('GitLab '), bold('18.5.1')],
            [bold('4'), plain(' waiting for your review')],
          ],
          address: 'gitlab.example.com',
          open: { label: 'Open GitLab', url: GITLAB },
        }),
        tabs: summary([
          ...worth([runner]),
          {
            kind: 'list',
            id: 'waiting',
            place: 'chart',
            span: 2,
            title: 'Waiting for you',
            meta: retried ? '4 to review' : '1 failing · 4 to review',
            items: [...failing, ...reviews],
            empty: 'Nothing waits for you. Every default branch passes.',
          },
          {
            kind: 'list',
            id: 'counts',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'In GitLab',
            items: [
              count({
                id: 'reviews',
                title: 'Your reviews',
                icon: 'clock',
                value: '4',
                note: 'oldest 3 days',
              }),
              count({
                id: 'branches',
                title: 'Default branches',
                icon: 'log',
                detail: 'Changed in the last 7 days',
                value: '8',
                ...(retried ? { note: 'All pass', noteTone: 'ok' } : { note: '1 failing', noteTone: 'bad' }),
              }),
              count({
                id: 'runners',
                title: 'Runners',
                icon: 'power',
                value: '2 of 3',
                note: '1 offline',
                noteTone: 'warn',
              }),
            ],
          },
          week(ctx, {
            meta: 'Pipelines on default branches per day',
            label: 'Pipelines',
            values: [12, 9, 15, 4, 2, 11, 7],
            figure: { value: '60', rest: 'pipelines this week' },
            change: '+8 %',
            failed: 5,
            color: 'blue',
          }),
          {
            kind: 'bars',
            id: 'machine',
            place: 'chart',
            span: 1,
            title: 'The machine',
            meta: 'thetitan',
            link: { kind: 'href', label: 'See thetitan', href: thingHref('server', 'thetitan') },
            items: [
              { id: 'cpu', label: 'Processor', note: 'of 8 cores', value: '18 %', pct: 0.18 },
              { id: 'memory', label: 'Memory', value: '9.8 of 16 GB', pct: 0.61 },
              { id: 'disk', label: 'Disk', value: '7.1 of 12 TB', pct: 0.59 },
              { id: 'version', label: 'GitLab', value: '18.5.1', pct: null },
            ],
          },
          {
            kind: 'list',
            id: 'runners',
            place: 'main',
            title: 'Runners',
            items: [
              { id: '12', title: 'build-02', detail: '18.5.0', tone: 'bad', right: 'Offline' },
              { id: '11', title: 'build-01', detail: '18.5.0', tone: 'ok', right: 'Online' },
              { id: '13', title: 'docs', detail: '18.4.2', tone: 'ok', right: 'Online' },
            ],
          },
        ]),
      };
    };
    return {
      page,
      row: () => ({
        line: retried ? '4 to review' : '1 failing · 4 to review',
        facts: [
          { label: 'Your reviews', value: '4' },
          { label: 'Failing', value: retried ? '0' : '1' },
        ],
      }),
      action: ({ action }) => {
        if (action !== 'retry' || retried) return null;
        retried = true;
        return { message: 'Running acme/web’s pipeline again.', recorded: true };
      },
      checks: [
        {
          check: 'git.branch_failing',
          name: 'Default branches whose pipeline fails',
          nature: 'problem',
          perItem: true,
        },
        { check: 'git.runner_offline', name: 'Runners going offline', nature: 'problem', perItem: true },
      ],
    };
  },
};

/* Forgejo: self-hosted, on a machine Whombat doesn't know ---------------------------------------------------------- */

const FORGEJO = 'https://git.home.example';

const forgejo: FixtureServicePage = {
  thing: 'connection:con_forgejo',
  catalogId: 'forgejo',
  name: 'Forgejo',
  fields: { url: FORGEJO },
  make: (ctx) => ({
    page: () => ({
      ...headOf(ctx, {
        name: 'Forgejo',
        catalogId: 'forgejo',
        status: 'ok',
        badge: 'Default branches pass',
        facts: [
          [plain('Forgejo '), bold('17.0.1')],
          [bold('2'), plain(' waiting for your review')],
        ],
        address: 'git.home.example',
        open: { label: 'Open Forgejo', url: FORGEJO },
      }),
      tabs: summary([
        {
          kind: 'list',
          id: 'waiting',
          place: 'chart',
          span: 2,
          title: 'Waiting for you',
          meta: '2 to review',
          items: [
            {
              id: 'review-31',
              title: 'Move the photo backups to the new disk',
              detail: 'home/backups · ann · open 2 days',
              url: `${FORGEJO}/home/backups/pulls/31`,
            },
            {
              id: 'review-32',
              title: 'Dark mode for the family calendar',
              detail: 'home/calendar · tom · open 4 h',
              right: 'Draft',
              url: `${FORGEJO}/home/calendar/pulls/32`,
            },
          ],
          empty: 'Nothing waits for you. Every default branch passes.',
        },
        {
          kind: 'list',
          id: 'counts',
          place: 'chart',
          span: 1,
          look: 'counts',
          title: 'In Forgejo',
          items: [
            count({ id: 'reviews', title: 'Your reviews', icon: 'clock', value: '2', note: 'oldest 2 days' }),
            count({
              id: 'branches',
              title: 'Default branches',
              icon: 'log',
              detail: 'Changed in the last 7 days',
              value: '3',
              note: 'All pass',
              noteTone: 'ok',
            }),
            count({
              id: 'runners',
              title: 'Runners',
              icon: 'power',
              value: '1 of 1',
              note: 'All online',
              noteTone: 'ok',
            }),
          ],
        },
        week(ctx, {
          meta: 'Runs on default branches per day',
          label: 'Runs',
          values: [3, 5, 0, 1, 6, 4, 2],
          figure: { value: '21', rest: 'runs this week' },
          change: '−12 %',
          failed: 2,
          color: 'blue',
        }),
        itself('Forgejo', [{ id: 'version', label: 'Forgejo', value: '17.0.1', pct: null }]),
        {
          kind: 'list',
          id: 'runners',
          place: 'main',
          title: 'Runners',
          items: [{ id: '1', title: 'build-01', detail: 'v9.1.0', tone: 'ok', right: 'Online' }],
        },
      ]),
    }),
    row: () => ({
      line: '2 to review',
      facts: [
        { label: 'Your reviews', value: '2' },
        { label: 'Failing', value: '0' },
      ],
    }),
    checks: [
      {
        check: 'git.branch_failing',
        name: 'Default branches whose run fails',
        nature: 'problem',
        perItem: true,
      },
      { check: 'git.runner_offline', name: 'Runners going offline', nature: 'problem', perItem: true },
    ],
  }),
};

/* GitHub Actions: two repositories, a self-hosted runner offline ------------------------------------------------- */

const githubActions: FixtureServicePage = {
  thing: 'connection:con_github-actions',
  catalogId: 'github_actions',
  name: 'GitHub Actions',
  fields: { repos: 'acme/web, acme/api' },
  make: (ctx) => {
    const button = buttonOf(ctx);
    let retried = false;
    const page = (): ThingPage => {
      const running: ThingGalleryItem[] = [
        {
          id: 'acme/web/9005',
          title: 'Main checks',
          sub: 'web · main · ci-main · Fast and integration checks',
          progress: 0.5,
          note: '20 min',
          noteEnd: 'About 20 min left',
          url: 'https://github.com/acme/web/actions/runs/9005',
        },
        {
          id: 'acme/api/412',
          title: 'Release',
          sub: 'api · main · ci-main · Build the images',
          progress: 0.82,
          note: '6 min',
          noteEnd: 'About 1 min left',
          url: 'https://github.com/acme/api/actions/runs/412',
        },
        {
          id: 'acme/web/9004',
          title: 'PR checks',
          sub: 'web · fix/login',
          noteEnd: 'Waiting 10 min',
          badge: { text: 'Waiting', tone: 'bad' },
          url: 'https://github.com/acme/web/actions/runs/9004',
        },
      ];
      const latest = [
        ['acme/web/9003', 'Main checks', 'web', retried ? 'Passed' : 'Failed', '2 h ago', '41 min'],
        ['acme/web/8990', 'Nightly', 'web', 'Passed', 'Today 03:00', '1 h 12 min'],
        ['acme/api/408', 'Main checks', 'api', 'Passed', 'Yesterday 17:40', '9 min'],
      ] as const;
      return {
        ...headOf(ctx, {
          name: 'GitHub Actions',
          catalogId: 'github_actions',
          status: 'warn',
          badge: 'A runner is offline',
          facts: [[plain('Watching '), bold('2 repositories')]],
          address: 'github.com',
          open: { label: 'Open GitHub', url: 'https://github.com' },
        }),
        refreshS: 30,
        tabs: summary([
          ...worth([
            {
              id: 'runner-acme/web/2',
              tone: 'warn',
              icon: 'power',
              title: 'Runner ci-pr is offline',
              link: {
                kind: 'ask',
                label: 'Look into it',
                question: 'Why is the GitHub Actions runner ci-pr offline?',
              },
              nature: 'problem',
              check: 'git.runner_offline',
              subject: { id: 'runner:acme/web/2', name: 'ci-pr' },
              ...(ctx.lookOnly ? {} : { ignore: { lifts: 'fixed', words: 'Until it’s back online.' } }),
            },
          ]),
          {
            kind: 'gallery',
            id: 'running',
            place: 'chart',
            span: 2,
            look: 'rows',
            shape: 'square',
            title: 'Running now',
            meta: '2 running · 1 waiting',
            items: running,
            empty: 'Nothing is running.',
          },
          {
            kind: 'list',
            id: 'counts',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'Builds',
            items: [
              count({
                id: 'workflows',
                title: 'Workflows',
                icon: 'log',
                detail: 'Last result on main',
                value: '3',
                ...(retried ? { note: 'All pass', noteTone: 'ok' } : { note: '1 failing', noteTone: 'bad' }),
              }),
              count({
                id: 'today',
                title: 'Runs today',
                icon: 'clock',
                value: '7',
                note: '3 passed · 2 failed',
                noteTone: 'warn',
              }),
              count({
                id: 'runners',
                title: 'Runners',
                icon: 'power',
                value: '1 of 2',
                note: '1 offline',
                noteTone: 'warn',
              }),
              count({
                id: 'repositories',
                title: 'Repositories',
                icon: 'database',
                value: '2',
                detail: 'Watched',
              }),
            ],
          },
          week(ctx, {
            meta: 'Runs per day, every branch',
            label: 'Runs',
            values: [21, 18, 30, 9, 4, 25, 7],
            figure: { value: '114', rest: 'runs this week' },
            change: '+12 %',
            failed: 9,
            color: 'blue',
          }),
          {
            kind: 'table',
            id: 'latest',
            place: 'main',
            title: 'Last runs on main',
            meta: '3 workflows · 2 repositories',
            columns: [
              { key: 'workflow', label: 'Workflow' },
              { key: 'result', label: 'Result' },
              { key: 'when', label: 'When' },
              { key: 'took', label: 'Took', numeric: true },
              ...(retried ? [] : [{ key: 'retry', label: '' }]),
            ],
            rows: latest.map(([id, workflow, repo, result, at, took]) => ({
              id,
              cells: {
                workflow: {
                  text: workflow,
                  note: repo,
                  url: `https://github.com/${id.replace(/\/(\d+)$/, '/actions/runs/$1')}`,
                },
                result: { text: result, dot: result === 'Failed' ? 'bad' : 'ok' },
                when: { text: at },
                took: { text: took },
                ...(result === 'Failed'
                  ? {
                      retry: {
                        text: 'Retry',
                        action: button({ action: 'retry', target: id, label: 'Retry', icon: 'retry' }),
                      },
                    }
                  : {}),
              },
            })),
          },
          {
            kind: 'list',
            id: 'runners',
            place: 'main',
            title: 'Runners',
            meta: '1 of 2 online · 1 busy',
            items: [
              { id: 'acme/web/2', title: 'ci-pr', detail: 'pr', tone: 'bad', right: 'Offline' },
              {
                id: 'acme/web/1',
                title: 'ci-main',
                detail: 'Running Main checks',
                tone: 'ok',
                right: 'Busy',
              },
            ],
          },
        ]),
      };
    };
    return {
      page,
      row: () => ({
        line: '2 running · 1 waiting',
        facts: [
          { label: 'Running', value: '2' },
          { label: 'Failing', value: retried ? '0' : '1' },
        ],
      }),
      action: ({ action }) => {
        if (action !== 'retry' || retried) return null;
        retried = true;
        return { message: 'Running Main checks’s failed jobs again.', recorded: true };
      },
      checks: [
        {
          check: 'git.branch_failing',
          name: 'Workflows failing on a default branch',
          nature: 'problem',
          perItem: true,
        },
        { check: 'git.runner_offline', name: 'Runners going offline', nature: 'problem', perItem: true },
        {
          check: 'git.job_waiting',
          name: 'Jobs waiting long for a runner',
          nature: 'problem',
          perItem: true,
        },
      ],
    };
  },
};

/* Todoist ------------------------------------------------------------------------------------------------------ */

const TODOIST = 'https://app.todoist.com/app/today';
const TASKS: { id: string; title: string; detail: string; late?: boolean; right?: string }[] = [
  { id: 't1', title: 'Send the invoice to Acme', detail: 'Work · 14 Oct', late: true },
  { id: 't2', title: 'Call the bank about the card', detail: 'Work · Yesterday', late: true },
  { id: 't3', title: 'Water the plants', detail: 'Home · 10:00', right: 'Repeats' },
  { id: 't4', title: 'Pay the VAT return', detail: 'Work · 12:00', right: 'P1' },
  { id: 't5', title: 'Book the car for its service', detail: 'Home · Today' },
  { id: 't6', title: 'Answer Lena about the offsite', detail: 'Work · Today', right: 'P3' },
];

/**
 * Todoist with an API token (`con_todoist`), or signed in with Todoist (`con_todoist_mcp`): the same page read through
 * its MCP server's tools that only read, without Done.
 */
const todoistOf = (mcp: boolean): FixtureServicePage => ({
  thing: mcp ? 'connection:con_todoist_mcp' : 'connection:con_todoist',
  catalogId: 'todoist',
  name: 'Todoist',
  make: (ctx) => {
    const button = buttonOf(ctx);
    const done = new Set<string>();
    const page = (): ThingPage => {
      const open = TASKS.filter((t) => !done.has(t.id));
      const late = open.filter((t) => t.late).length;
      const today = open.length - late;
      const doneToday = 3 + done.size;
      return {
        ...headOf(ctx, {
          name: 'Todoist',
          catalogId: 'todoist',
          status: 'ok',
          badge: today ? `${today} ${today === 1 ? 'task' : 'tasks'} today` : 'Nothing due today',
          facts: [
            [bold(String(today)), plain(' due today')],
            [bold(String(doneToday)), plain(' done')],
          ],
          address: 'todoist.com',
          open: { label: 'Open Todoist', url: TODOIST },
        }),
        ...(mcp ? { id: 'connection:con_todoist_mcp', connectionId: 'con_todoist_mcp' } : {}),
        tabs: summary([
          {
            kind: 'list',
            id: 'tasks',
            place: 'chart',
            span: 2,
            title: 'Today',
            meta: `${today} today · ${late} overdue · ${doneToday} done`,
            link: { kind: 'url', label: 'Open Todoist', url: TODOIST },
            items: open.map((t) => ({
              id: t.id,
              title: t.title,
              detail: t.detail,
              ...(t.late ? { tone: 'warn' as const } : {}),
              ...(t.right ? { right: t.right } : {}),
              ...(mcp
                ? {}
                : { actions: [button({ action: 'done', target: t.id, label: 'Done', icon: 'check' })] }),
            })),
            empty: 'Nothing due today.',
          },
          {
            kind: 'list',
            id: 'coming',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'Your tasks',
            items: [
              count({
                id: 'today',
                title: 'Today',
                icon: 'clock',
                value: String(today),
                note: `${doneToday} done`,
                noteTone: 'ok',
              }),
              count({
                id: 'overdue',
                title: 'Overdue',
                icon: 'warn',
                value: String(late),
                ...(late ? { note: 'oldest 14 Oct', noteTone: 'warn' } : { note: 'Nothing overdue' }),
              }),
              count({ id: 'tomorrow', title: 'Tomorrow', icon: 'clock', value: '5' }),
              count({ id: 'week', title: 'Next 7 days', icon: 'clock', detail: 'After today', value: '17' }),
            ],
          },
          week(ctx, {
            title: 'Done this week',
            meta: 'Tasks done per day',
            label: 'Done',
            values: [6, 8, 4, 0, 1, 7, doneToday],
            figure: { value: String(26 + doneToday), rest: 'tasks done' },
            change: '+9 %',
            color: 'green',
          }),
        ]),
      };
    };
    return {
      page,
      row: () => {
        const open = TASKS.filter((t) => !done.has(t.id));
        const late = open.filter((t) => t.late).length;
        return {
          line: `${open.length - late} today · ${late} overdue`,
          facts: [
            { label: 'Today', value: String(open.length - late) },
            { label: 'Overdue', value: String(late) },
          ],
        };
      },
      action: ({ action, target }) => {
        if (mcp || action !== 'done' || typeof target !== 'string' || done.has(target)) return null;
        const task = TASKS.find((t) => t.id === target);
        if (!task) return null;
        done.add(target);
        return {
          message: task.right === 'Repeats' ? 'Done. It’s back on its next day.' : 'Done.',
          recorded: true,
        };
      },
      checks: [],
    };
  },
});

/* T3 Code: a computer on the LAN ---------------------------------------------------------------------------------- */

const T3 = 'http://192.168.1.20:3773';

const t3code: FixtureServicePage = {
  thing: 'connection:con_t3code',
  catalogId: 't3code',
  name: 'T3 Code',
  fields: { url: T3 },
  make: (ctx) => {
    const button = buttonOf(ctx);
    let answered: string | null = null;
    let stopped = false;
    const page = (): ThingPage => {
      const waits: ThingGalleryItem[] = answered
        ? []
        : [
            {
              id: 'ask',
              title: 'Which colour should the Buy button be?',
              sub: 'Shop site · Pick a button colour',
              badge: { text: 'Question', tone: 'warn' },
              noteEnd: 'Waiting 6 min',
              url: `${T3}/env/ask`,
              actions: ['Blue', 'Green', 'Orange'].map((o) =>
                button({ action: 'answer', target: 'ask', value: o, label: o }),
              ),
            },
          ];
      const approval: ThingGalleryItem = {
        id: 'approval',
        title: 'Add a contact form',
        sub: 'Shop site · Asks permission for editing contact.html',
        badge: { text: 'Permission', tone: 'warn' },
        noteEnd: 'Waiting 2 min',
        url: `${T3}/env/approval`,
      };
      const working: ThingGalleryItem[] = [
        {
          id: 'photos',
          title: 'Resize the product photos',
          sub: 'Garden app · Codex · gpt-6-astra',
          note: 'For 30 min',
          noteEnd: 'Finishing up',
          url: `${T3}/env/photos`,
        },
        {
          id: 'checkout',
          title: 'Fix the checkout page',
          sub: 'Shop site · Claude Opus 5.5',
          ...(stopped ? {} : { note: 'For 12 min' }),
          noteEnd: stopped ? 'Stopped' : 'Working',
          url: `${T3}/env/checkout`,
          ...(stopped
            ? {}
            : {
                actions: [
                  button({
                    action: 'stop',
                    target: 'checkout',
                    label: 'Stop',
                    icon: 'stop',
                    tone: 'danger',
                    confirm: {
                      title: 'Stop “Fix the checkout page”?',
                      body: 'T3 Code stops what its agent is doing now. The thread stays, and you can carry on there.',
                      button: 'Stop',
                    },
                  }),
                ],
              }),
        },
      ];
      const working1 = stopped ? working.slice(0, 1) : working;
      const nWaits = waits.length + 1;
      const recent: [string, string, string, 'ok' | 'warn' | 'bad' | 'off', string][] = [
        ['ask', 'Pick a button colour', 'Shop site', answered ? 'ok' : 'warn', 'Today 21:49'],
        ['checkout', 'Fix the checkout page', 'Shop site', stopped ? 'off' : 'ok', 'Today 21:46'],
        ['photos', 'Resize the product photos', 'Garden app', 'ok', 'Today 21:30'],
        ['seed', 'Seed packets page', 'Garden app', 'ok', 'Today 16:02'],
        ['deploy', 'Deploy the shop to staging', 'Shop site', 'bad', 'Today 11:20'],
      ];
      const states: Record<string, string> = {
        ok: 'Done',
        warn: 'Waiting for you',
        bad: 'Failed',
        off: 'Stopped',
      };
      return {
        ...headOf(ctx, {
          name: 'T3 Code',
          catalogId: 't3code',
          status: 'ok',
          badge: `${working1.length} working`,
          facts: [
            [plain('T3 Code '), bold('0.1.3'), plain(' · workbench · Linux')],
            [plain('Signed in until '), bold('19 Nov')],
          ],
          address: '192.168.1.20:3773',
          open: { label: 'Open T3 Code', url: `${T3}/` },
        }),
        refreshS: 30,
        tabs: summary([
          {
            kind: 'gallery',
            id: 'now',
            place: 'chart',
            span: 2,
            look: 'rows',
            shape: 'square',
            title: 'Your coding agents',
            meta: `${nWaits} waiting for you · ${working1.length} working`,
            items: [...waits, approval, ...working1],
            empty: 'Nothing is working.',
          },
          {
            kind: 'list',
            id: 'counts',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'In T3 Code',
            items: [
              count({
                id: 'finished',
                title: 'Finished today',
                icon: 'log',
                value: '2',
                note: '1 failed',
                noteTone: 'warn',
              }),
              count({
                id: 'open',
                title: 'Open threads',
                icon: 'database',
                detail: 'In 2 projects',
                value: '7',
              }),
              count({
                id: 'programs',
                title: 'AI programs',
                icon: 'plug',
                value: '2 of 4',
                note: '2 can’t run',
                noteTone: 'warn',
              }),
              count({
                id: 'tasks',
                title: 'Scheduled tasks',
                icon: 'clock',
                value: '3',
                note: '1 failed last time',
                noteTone: 'bad',
              }),
            ],
          },
          week(ctx, {
            meta: 'Threads finished per day',
            label: 'Finished',
            values: [4, 6, 3, 0, 1, 5, 2],
            figure: { value: '21', rest: 'threads finished' },
            change: '+31 %',
            failed: 2,
            color: 'violet',
          }),
          itself('T3 Code', [
            { id: 't3-version', label: 'T3 Code', value: '0.1.3', pct: null },
            { id: 't3-computer', label: 'Computer', value: 'Linux · workbench', pct: null },
          ]),
          {
            kind: 'table',
            id: 'recent',
            place: 'main',
            title: 'Recent threads',
            columns: [
              { key: 'thread', label: 'Thread' },
              { key: 'state', label: 'State' },
              { key: 'when', label: 'When' },
            ],
            rows: recent.map(([id, title, project, dot, at]) => ({
              id,
              cells: {
                thread: { text: title, note: project, url: `${T3}/env/${id}` },
                state: { text: states[dot] ?? 'Done', dot },
                when: { text: at },
              },
            })),
          },
          {
            kind: 'list',
            id: 'projects',
            place: 'main',
            title: 'Projects',
            meta: '2 projects',
            items: [
              { id: 'garden', title: 'Garden app', detail: '1 working', tone: 'ok', right: '2 open' },
              {
                id: 'shop',
                title: 'Shop site',
                detail: `${nWaits} waiting for you · ${stopped ? 0 : 1} working`,
                tone: 'warn',
                right: '5 open',
              },
            ],
          },
          {
            kind: 'list',
            id: 'programs',
            place: 'main',
            title: 'AI programs',
            meta: '2 ready · 2 switched off',
            items: [
              {
                id: 'program:opencode',
                title: 'OpenCode',
                detail: 'Install it on that computer, or switch it off in T3 Code.',
                tone: 'warn',
                right: 'Not installed',
              },
              {
                id: 'program:pi',
                title: 'Pi',
                detail: 'Run pi login on that computer.',
                tone: 'warn',
                right: 'Not signed in',
              },
              {
                id: 'program:codex',
                title: 'Codex',
                detail: 'gpt-6-astra and gpt-6-mini',
                tone: 'ok',
                right: 'Ready',
              },
              {
                id: 'program:claudeAgent',
                title: 'Claude',
                detail: 'Claude Opus 5.5, Claude Sonnet 5.5 and 10 more',
                tone: 'ok',
                right: 'Ready',
              },
            ],
          },
          {
            kind: 'list',
            id: 'tasks',
            place: 'main',
            title: 'Scheduled tasks',
            meta: '3 tasks',
            items: [
              {
                id: 'links',
                title: 'Check the shop for broken links',
                detail: 'Weekdays at 07:00 · next tomorrow 07:00',
                tone: 'ok',
                right: 'Went fine',
              },
              {
                id: 'deps',
                title: 'Update the dependencies',
                detail: 'Every 7 days · next 27 Oct',
                tone: 'bad',
                right: 'Failed',
              },
              {
                id: 'issues',
                title: 'Answer new issues',
                detail: 'When its webhook is called',
                right: 'Switched off',
              },
            ],
          },
        ]),
      };
    };
    return {
      page,
      row: () => ({
        line: `${answered ? 1 : 2} waiting for you · ${stopped ? 1 : 2} working`,
        facts: [
          { label: 'Working', value: String(stopped ? 1 : 2) },
          { label: 'Waiting for you', value: String(answered ? 1 : 2) },
        ],
      }),
      action: ({ action, target, value }) => {
        if (action === 'answer' && target === 'ask' && !answered && typeof value === 'string') {
          answered = value;
          return { message: `Answered: ${value}.`, recorded: true };
        }
        if (action === 'stop' && target === 'checkout' && !stopped) {
          stopped = true;
          return { message: 'T3 Code is stopping it.', recorded: true };
        }
        return null;
      },
      checks: [
        {
          check: 't3code.signin_ends',
          name: 'Whombat’s sign-in to T3 Code ending soon',
          nature: 'you',
          perItem: false,
        },
        {
          check: 't3code.program_cant_run',
          name: 'AI programs in use that can’t run',
          nature: 'you',
          perItem: true,
        },
        { check: 't3code.thread_waiting', name: 'Threads waiting for you', nature: 'you', perItem: true },
        { check: 't3code.thread_failed', name: 'Threads that failed', nature: 'problem', perItem: true },
      ],
    };
  },
};

export const BIZ_DEV_PAGES: FixtureServicePage[] = [
  gitlab,
  forgejo,
  githubActions,
  todoistOf(false),
  todoistOf(true),
  t3code,
];
