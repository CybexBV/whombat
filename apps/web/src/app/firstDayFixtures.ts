/**
 * The first day in fixture mode (`VITE_FIXTURE_FIRST_DAY=found|looking`; Whombat first-day.md): a Whombat just claimed,
 * nothing connected, Chat holding only the welcome thread as the Whombat posts it — what the network scan found with a
 * button each (`found`), or what the assistant can do while the scan still looks (`looking`) — with mail as its reply,
 * and Needs you holding only the assistant's backup proposal. The cards are the Whombat's words, written out here.
 */
import type { GuideCard, NeedsYouItem } from '@whombat/core';

export type FirstDayFixture = 'found' | 'looking';

export function firstDayFixtureOf(value: unknown): FirstDayFixture | undefined {
  return value === 'found' || value === 'looking' ? value : undefined;
}

const card = (over: Pick<GuideCard, 'node' | 'title' | 'body' | 'blocks' | 'state'>): GuideCard => ({
  kind: 'guide',
  guide: 'welcome',
  step: null,
  answer: null,
  ...over,
});

const mail = card({
  node: 'mail',
  title: 'Your email',
  body: 'I can read, sort and draft replies. I always ask before I send anything.',
  state: 'open',
  blocks: [
    {
      type: 'actions',
      actions: [
        {
          id: 'imap',
          label: 'Other email (IMAP)',
          style: 'primary',
          href: '/settings?tab=connections&connection=imap',
        },
        { id: 'google', label: 'Gmail or Google Workspace', style: 'secondary', href: null },
        { id: 'later', label: 'Maybe later', style: 'quiet', href: null },
      ],
    },
  ],
});

const found = card({
  node: 'found',
  title: 'Found on your network',
  body: 'Connect the ones you want, and I’ll keep an eye on them.',
  state: 'done',
  blocks: [
    {
      type: 'actions',
      actions: [
        {
          id: 'find_1',
          label: 'Connect Home Assistant',
          style: 'primary',
          href: '/settings?tab=connections&connection=homeassistant&url=http%3A%2F%2F192.168.1.20%3A8123&access=manage',
        },
        {
          id: 'find_2',
          label: 'Connect the UniFi gateway',
          style: 'secondary',
          href: '/settings?tab=connections&connection=unifi_network&url=https%3A%2F%2F192.168.1.1&access=read',
        },
        {
          id: 'find_3',
          label: 'Add the Debian server',
          style: 'secondary',
          href: '/things/servers?add=1&address=192.168.1.30',
        },
      ],
    },
  ],
});

/** The id of the welcome's first message: its thread's root, which the rest reply in. */
export const FIRST_DAY_ROOT_ID = 'msg_first-day-1';

/** The welcome's messages, oldest first: the first is the thread's root, the others reply in its thread. */
export function firstDayWelcome(
  kind: FirstDayFixture,
  names: { person: string; assistant: string },
): { text: string; card: GuideCard | null }[] {
  const hi = `Hi ${names.person}, I’m ${names.assistant}.`;
  if (kind === 'found')
    return [
      {
        text: `${hi} I found Home Assistant, a UniFi gateway and a Debian server on your network. Want me to look after them?`,
        card: found,
      },
      { text: '', card: mail },
    ];
  return [
    {
      text: `${hi} I can look after your servers, your network and your home, and help with your email. I’m looking around your network now and I’ll tell you what I find.`,
      card: null,
    },
    { text: '', card: mail },
  ];
}

/** Needs you's one item: nothing backs this Whombat up, nothing added or found to hold it, so a USB disk. */
export function firstDayBackupItem(at: string): NeedsYouItem {
  return {
    id: 'backup:this-whombat',
    ref: { kind: 'backup', id: 'this-whombat' },
    kind: 'backup',
    severity: 'warn',
    title: 'Back up this Whombat to a USB disk every night?',
    body: 'Right now everything on it is only here: your chats, settings and connections. Name a USB disk WHOMBAT-BACKUP, plug it into your Whombat and say yes.',
    at,
    actions: [
      {
        id: 'yes',
        label: 'Yes, do it',
        style: 'primary',
        kind: 'ask',
        text: 'Yes, back up this Whombat every night to the disk named WHOMBAT-BACKUP I plugged in.',
      },
      {
        id: 'places',
        label: 'See other places',
        style: 'secondary',
        kind: 'open',
        href: '/settings?tab=appliance&section=backups',
      },
    ],
    href: '/settings?tab=appliance&section=backups',
    group: 'you',
  };
}
