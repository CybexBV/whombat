/**
 * The person's accounts as pages (the server's `things/accounts/`): Google (Microsoft 365 is drawn the same way, with
 * OneDrive and without Changed lately), Email (IMAP), GitHub and Website feedback. Each opens on its Summary in slots;
 * the apps draw its Connection tab from the account's own settings. Google and Email use the ids the web's world gives
 * their connections (`connectorFixtures.ts`), so the Connection tab shows that account.
 */
import type { ThingPage, ThingPageItem } from '@whombat/core/domain';
import type { FixtureServiceCtx, FixtureServicePage } from './types.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const GOOGLE = 'connection:con_mara';
const EMAIL = 'connection:con_mail_mara_fastmail_com';
const GITHUB = 'connection:github';
const FEEDBACK = 'connection:feedback';

const count = (
  id: string,
  title: string,
  value: string,
  more: Partial<ThingPageItem> = {},
): ThingPageItem => ({
  id,
  title,
  right: value,
  ...more,
  figure: { value, ...(more.figure ?? {}) },
});

/** The last seven days, today last, as a Trend's timestamps and words. */
function week(ctx: FixtureServiceCtx) {
  const at = Array.from({ length: 7 }, (_, i) => new Date(ctx.now() - (6 - i) * DAY));
  return {
    timestamps: at.map((d) => d.toISOString()),
    labels: at.map((d, i) => (i === 6 ? 'Today' : (WEEKDAYS[d.getDay()] ?? ''))),
  };
}

/** The base every account page shares: its Summary is the only server tab, and it has a Connection tab. */
function base(
  ctx: FixtureServiceCtx,
  page: Pick<ThingPage, 'id' | 'catalogId' | 'name' | 'icon' | 'verdict'> &
    Partial<Pick<ThingPage, 'connectionId' | 'address' | 'open'>>,
  panels: ThingPage['tabs'][number]['panels'],
): ThingPage {
  return {
    kind: 'connection',
    status: 'ok',
    badge: 'Fine',
    facts: [],
    runsOn: null,
    settings: true,
    actions: [],
    readAt: ctx.ago(MINUTE),
    ...page,
    tabs: [{ key: 'overview', label: 'Summary', panels }],
  };
}

const unreadMail = (ctx: FixtureServiceCtx, mails: [string, string, number][]): ThingPageItem[] =>
  mails.map(([subject, from, ago], i) => ({
    id: `mail-${i}`,
    title: subject,
    detail: from,
    at: ctx.ago(ago),
    right: ago < HOUR ? `${Math.round(ago / MINUTE)} min ago` : `${Math.round(ago / HOUR)} h ago`,
  }));

const google: FixtureServicePage = {
  thing: GOOGLE,
  catalogId: 'google',
  name: 'Google',
  make: (ctx) => ({
    page: () =>
      base(
        ctx,
        {
          id: GOOGLE,
          connectionId: 'con_mara' as ThingPage['connectionId'],
          catalogId: 'google',
          name: 'Google',
          icon: 'google',
          verdict: '4 unread mails, and 2 meetings left today.',
          address: 'mara@burrowhq.example',
          open: { label: 'Open Gmail', url: 'https://mail.google.com/' },
        },
        [
          {
            kind: 'list',
            id: 'today',
            place: 'chart',
            span: 2,
            title: 'Today',
            meta: '2 left',
            items: [
              {
                id: 'event-0',
                title: 'Design review',
                detail: '45 min · Google Meet',
                icon: 'clock',
                at: new Date(ctx.now() + 25 * MINUTE).toISOString(),
                right: 'in 25 min',
                tone: 'info',
              },
              {
                id: 'event-1',
                title: 'Call with Arnica Labs',
                detail: '30 min · Phone',
                icon: 'clock',
                at: new Date(ctx.now() + 3 * HOUR).toISOString(),
                right: 'in 3 h',
              },
            ],
          },
          {
            kind: 'list',
            id: 'account',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'In your account',
            items: [
              count('unread', 'Unread mail', '4', { icon: 'log', detail: 'In your inbox' }),
              count('meetings', 'Meetings today', '5', { icon: 'clock', detail: '2 left' }),
              count('space', 'Drive space', '84 %', {
                icon: 'disk',
                detail: '12.6 GB of 15 GB',
              }),
              count('automations', 'Automations', '1', { icon: 'update', detail: 'Start on new mail' }),
            ],
          },
          {
            kind: 'list',
            id: 'unread-mail',
            title: 'Unread mail',
            meta: '4 unread',
            items: unreadMail(ctx, [
              ['Invoice 2026-114 for November', 'Arnica Labs', 12 * MINUTE],
              ['Re: Design review notes', 'Noor Haddad', 48 * MINUTE],
              ['Your order is on its way', 'Example Shop', 3 * HOUR],
              ['Lunch on Friday?', 'Sam Okafor', 5 * HOUR],
            ]),
          },
          {
            kind: 'list',
            id: 'files',
            title: 'Changed lately',
            meta: 'In Drive',
            items: [
              {
                id: 'file-0',
                title: 'Q4 plan',
                detail: 'Google Docs · you',
                icon: 'log',
                right: '20 min ago',
                url: 'https://docs.google.com/document/d/example-q4-plan',
              },
              {
                id: 'file-1',
                title: 'Budget 2027',
                detail: 'Google Sheets · Noor Haddad',
                icon: 'database',
                right: '2 h ago',
                url: 'https://docs.google.com/spreadsheets/d/example-budget',
              },
              {
                id: 'file-2',
                title: 'Team offsite photos',
                detail: 'Folder · Sam Okafor',
                icon: 'photo',
                right: 'Yesterday',
                url: 'https://drive.google.com/drive/folders/example-offsite',
              },
            ],
          },
        ],
      ),
    row: () => ({ line: '4 unread · mara@burrowhq.example', facts: [{ label: 'Unread', value: '4' }] }),
    checks: [{ check: 'files.space', name: 'Drive almost full', nature: 'fyi', perItem: false }],
  }),
};

const email: FixtureServicePage = {
  thing: EMAIL,
  catalogId: 'imap',
  name: 'Email',
  make: (ctx) => ({
    page: () =>
      base(
        ctx,
        {
          id: EMAIL,
          connectionId: 'con_mail_mara_fastmail_com' as ThingPage['connectionId'],
          catalogId: 'imap',
          name: 'Email',
          icon: 'imap',
          verdict: '3 unread mails in your inbox.',
          address: 'mara@fastmail.com',
        },
        [
          {
            kind: 'list',
            id: 'unread',
            place: 'chart',
            span: 2,
            title: 'Unread mail',
            meta: '3 unread',
            items: unreadMail(ctx, [
              ['Your November statement', 'Example Bank', 25 * MINUTE],
              ['Tickets for Saturday', 'Example Theatre', 2 * HOUR],
              ['Weekly digest', 'Example News', 7 * HOUR],
            ]),
          },
          {
            kind: 'list',
            id: 'account',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'In your mailbox',
            items: [
              count('unread', 'Unread mail', '3', { icon: 'log', detail: 'In your inbox' }),
              count('automations', 'Automations', '0', { icon: 'update', detail: 'Start on new mail' }),
              count('checked', 'Checked', '2 min ago', { icon: 'clock', detail: 'imap.fastmail.com' }),
            ],
          },
        ],
      ),
    row: () => ({ line: '3 unread · mara@fastmail.com', facts: [{ label: 'Unread', value: '3' }] }),
  }),
};

const github: FixtureServicePage = {
  thing: GITHUB,
  catalogId: 'github',
  name: 'GitHub',
  make: (ctx) => ({
    page: () =>
      base(
        ctx,
        {
          id: GITHUB,
          catalogId: 'github',
          name: 'GitHub',
          icon: 'github',
          verdict: '1 review waits for you, and 2 pull requests have failing checks.',
          address: '@burrowhq',
          open: { label: 'Open GitHub', url: 'https://github.com/burrowhq' },
        },
        [
          {
            kind: 'list',
            id: 'waiting',
            place: 'chart',
            span: 2,
            title: 'Waiting for you',
            meta: '3',
            items: [
              {
                id: 'pr-desk-412',
                title: '#412 Retry sign-in after a password change',
                detail: 'desk · Noor Haddad asks your review',
                icon: 'clock',
                at: ctx.ago(2 * HOUR),
                right: '2 h ago',
                url: 'https://github.com/burrowhq/desk/pull/412',
              },
              {
                id: 'pr-billing-409',
                title: '#409 Invoice PDF shows the wrong VAT line',
                detail: 'billing · Yours · Checks failing',
                icon: 'warn',
                tone: 'bad',
                at: ctx.ago(5 * HOUR),
                right: '5 h ago',
                url: 'https://github.com/burrowhq/billing/pull/409',
              },
              {
                id: 'pr-infra-88',
                title: '#88 Move the base image to the new release',
                detail: 'infra · Sam Okafor · Checks failing',
                icon: 'warn',
                tone: 'bad',
                at: ctx.ago(DAY),
                right: '1 day ago',
                url: 'https://github.com/burrowhq/infra/pull/88',
              },
            ],
          },
          {
            kind: 'list',
            id: 'github',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'On GitHub',
            items: [
              count('repos', 'Repositories on', '6', { icon: 'database' }),
              count('open', 'Open pull requests', '14', {
                icon: 'log',
                figure: { value: '14', note: '+5 this week' },
              }),
              count('failing', 'Failing checks', '2', {
                icon: 'warn',
                tone: 'warn',
                figure: { value: '2', tone: 'warn' },
              }),
              count('review', 'Waiting on review', '4', { icon: 'clock' }),
            ],
          },
          {
            kind: 'chart',
            id: 'merged',
            place: 'chart',
            span: 1,
            title: 'Merged',
            meta: 'Per day',
            style: 'bars',
            ...week(ctx),
            series: [{ key: 'values', label: 'Merged', values: [2, 3, 1, 0, 0, 4, 1], color: 'blue' }],
            figure: { value: '11', rest: 'this week' },
            stats: [[{ text: '+22 %', strong: true }, { text: ' on last week' }]],
            axis: { min: 0 },
          },
          {
            kind: 'bars',
            id: 'people',
            place: 'chart',
            span: 1,
            title: 'Who opens most',
            meta: 'Last 30 days',
            items: [
              { id: 'person-0', label: 'Noor Haddad', person: true, value: '9 pull requests', pct: 1 },
              { id: 'person-1', label: 'Mara Oduya', person: true, value: '6 pull requests', pct: 6 / 9 },
              { id: 'person-2', label: 'Sam Okafor', person: true, value: '4 pull requests', pct: 4 / 9 },
            ],
          },
        ],
      ),
    row: () => ({ line: '@burrowhq · 6 repositories on', facts: [] }),
  }),
};

const feedback: FixtureServicePage = {
  thing: FEEDBACK,
  catalogId: 'feedback',
  name: 'Website feedback',
  make: (ctx) => ({
    page: () =>
      base(
        ctx,
        {
          id: FEEDBACK,
          catalogId: 'feedback',
          name: 'Website feedback',
          icon: 'feedback',
          verdict: '2 new reports wait for a look.',
        },
        [
          {
            kind: 'list',
            id: 'new',
            place: 'chart',
            span: 2,
            title: 'New reports',
            meta: '2 new',
            items: [
              {
                id: 'report-0',
                title: 'The export button does nothing',
                detail: 'Billing portal · Jamie Ortega',
                icon: 'warn',
                at: ctx.ago(12 * MINUTE),
                right: '12 min ago',
              },
              {
                id: 'report-1',
                title: 'Typo on the pricing page',
                detail: 'Docs · Priya Nair',
                icon: 'info',
                at: ctx.ago(3 * HOUR),
                right: '3 h ago',
              },
            ],
          },
          {
            kind: 'list',
            id: 'reports',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'Reports',
            items: [
              count('week', 'This week', '7', {
                icon: 'log',
                figure: { value: '7', note: '+2 on last week' },
              }),
              count('open', 'Open', '5', { icon: 'warn' }),
              count('fixed', 'Fixed', '9', { icon: 'update', detail: 'Last 30 days' }),
              count('sites', 'Sites', '2', { icon: 'network', detail: 'Billing portal, Docs' }),
            ],
          },
          {
            kind: 'chart',
            id: 'week',
            place: 'chart',
            span: 1,
            title: 'Reports',
            meta: 'Per day',
            style: 'bars',
            ...week(ctx),
            series: [{ key: 'values', label: 'Reports', values: [1, 0, 2, 1, 0, 1, 2], color: 'blue' }],
            figure: { value: '7', rest: 'this week' },
            stats: [[{ text: '+40 %', strong: true }, { text: ' on last week' }]],
            axis: { min: 0 },
          },
          {
            kind: 'bars',
            id: 'people',
            place: 'chart',
            span: 1,
            title: 'Who reports most',
            meta: 'Last 30 days',
            items: [
              { id: 'person-0', label: 'Jamie Ortega', person: true, value: '3 reports', pct: 1 },
              { id: 'person-1', label: 'Priya Nair', person: true, value: '2 reports', pct: 2 / 3 },
              { id: 'person-2', label: 'Sam Okafor', person: true, value: '1 report', pct: 1 / 3 },
            ],
          },
        ],
      ),
    row: () => ({ line: '2 new reports · 2 sites', facts: [{ label: 'New', value: '2' }] }),
  }),
};

export const ACCOUNT_PAGES: FixtureServicePage[] = [google, email, github, feedback];
