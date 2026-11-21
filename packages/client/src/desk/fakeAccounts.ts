/**
 * The person's own accounts in the fake world (3.7; Whombat desk-display.md DK-159): a Google account with its
 * calendar and mail, an Email (IMAP) account and the Whombat's GitHub, as *Your accounts* in *Add a widget* and each
 * widget's view as the runtime draws it (desk-display-server.md DK-S255…DK-S259). Pure data.
 */
import type { DeskCatalogGroup, DeskWidgetSpec, DeskWidgetView } from './contract';

export const FAKE_GOOGLE = 'account:con_google';
export const FAKE_EMAIL = 'account:con_imap';
export const FAKE_GITHUB = 'account:github';

const item = (
  ref: string,
  mark: string,
  panel: string,
  name: string,
  line: string,
  view: 'list' | 'figures',
) => ({
  type: 'panel' as const,
  ref,
  opts: { panel },
  name,
  line,
  mark,
  view,
  ...(panel === 'pulls' ? {} : { private: true }),
});

/** *Your accounts*: one group per account, after the things and before the assistant's Home widgets. */
export const FAKE_ACCOUNT_GROUPS: readonly DeskCatalogGroup[] = [
  {
    key: FAKE_GOOGLE,
    thing: FAKE_GOOGLE,
    label: 'Google · mara@lumio.example',
    mark: 'google',
    items: [
      item(
        FAKE_GOOGLE,
        'google',
        'today',
        'Today',
        'What’s left of today’s meetings, each at its time',
        'list',
      ),
      item(
        FAKE_GOOGLE,
        'google',
        'next',
        'Next meeting',
        'What’s next, when, where and in how long',
        'figures',
      ),
      item(
        FAKE_GOOGLE,
        'google',
        'unread',
        'Unread mail',
        'How many unread in the inbox, and the newest',
        'list',
      ),
    ],
  },
  {
    key: FAKE_EMAIL,
    thing: FAKE_EMAIL,
    label: 'Email · mara@home.example',
    mark: 'imap',
    items: [
      item(
        FAKE_EMAIL,
        'imap',
        'unread',
        'Unread mail',
        'How many unread in the inbox, and the newest',
        'list',
      ),
    ],
  },
  {
    key: FAKE_GITHUB,
    thing: FAKE_GITHUB,
    label: 'GitHub',
    mark: 'github',
    items: [
      item(
        FAKE_GITHUB,
        'github',
        'pulls',
        'Pull requests',
        'What’s open, whose, and whether its checks pass',
        'list',
      ),
      item(
        FAKE_GITHUB,
        'github',
        'reviews',
        'Waiting for review',
        'Pull requests someone was asked to review',
        'list',
      ),
    ],
  },
];

/** An account widget's view in the fake; null when the account has no widget like that. */
export function fakeAccountView(w: DeskWidgetSpec): DeskWidgetView | null {
  const panel =
    w.type === 'figures'
      ? w.ref === FAKE_GITHUB
        ? 'pulls'
        : w.ref === FAKE_GOOGLE
          ? 'next'
          : 'unread'
      : w.opts.panel;
  const google = { name: 'Google', mark: 'google' };
  const github = { name: 'GitHub', mark: 'github' };
  switch (`${w.ref}#${panel}`) {
    case `${FAKE_GOOGLE}#today`:
      return {
        id: w.id,
        kind: 'list',
        title: 'Today',
        ...google,
        head: '3 left today',
        rows: [
          { title: 'Office day', meta: 'All day' },
          {
            time: '10:00',
            title: 'Standup',
            detail: 'Room 3 · with 4 others',
            meta: 'Now · until 10:15',
            tone: 'ok',
          },
          { time: '13:30', title: 'Bakkerij de Vries', detail: 'with 1 other' },
          { time: '16:00', title: 'Planning', detail: 'Teams · with 6 others' },
        ],
        empty: 'Nothing else today.',
      };
    case `${FAKE_GOOGLE}#next`:
      return {
        id: w.id,
        kind: 'figures',
        title: 'Next meeting',
        ...google,
        items: [{ value: 'in 12 min', label: 'Bakkerij de Vries' }],
        line: '13:30 · with 1 other',
      };
    case `${FAKE_GOOGLE}#unread`:
      return {
        id: w.id,
        kind: 'list',
        title: 'Unread mail',
        ...google,
        head: '7 unread',
        count: 7,
        rows: [
          { time: '12:41', title: 'Invoice 2026-114', detail: 'Bakkerij de Vries' },
          { time: '11:02', title: 'Your order has shipped', detail: 'Coolblue' },
          { time: '09:15', title: 'Lunch on Friday?', detail: 'Anna Jansen' },
          { time: 'Mon', title: 'Quarterly figures', detail: 'Joost Bakker' },
          { time: 'Mon', title: 'Welcome to the team', detail: 'Sanne de Wit' },
        ],
        empty: 'No unread mail.',
      };
    case `${FAKE_EMAIL}#unread`:
      return {
        id: w.id,
        kind: 'list',
        title: 'Unread mail',
        name: 'Email',
        mark: 'imap',
        rows: [],
        empty: 'No unread mail.',
      };
    case `${FAKE_GITHUB}#pulls`:
      return {
        id: w.id,
        kind: 'list',
        title: 'Pull requests',
        ...github,
        head: '3 open',
        rows: [
          { title: 'billing #482 · Invoice PDF export', detail: 'Dusty', meta: 'Checks fail', tone: 'bad' },
          { title: 'web #91 · Darker sidebar', detail: 'mara · Draft', meta: 'Checks running' },
          {
            title: 'web #88 · Fix the login redirect',
            detail: 'dependabot',
            meta: 'Checks pass',
            tone: 'ok',
          },
        ],
        empty: 'No open pull requests.',
      };
    case `${FAKE_GITHUB}#reviews`:
      return {
        id: w.id,
        kind: 'list',
        title: 'Waiting for review',
        ...github,
        head: '1 waiting',
        rows: [{ title: 'billing #482 · Invoice PDF export', detail: 'Waiting for you' }],
        empty: 'Nobody’s waiting for a review.',
      };
    default:
      return null;
  }
}
