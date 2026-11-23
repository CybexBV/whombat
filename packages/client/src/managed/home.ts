/**
 * The account site's home (`/` at app.whombat.com, docs/app/decisions/account-home.md) and the menu under a box's name
 * on its own page: one list of the person's Whombats, each opening at its own address, with one way to add another.
 * The words, the rows in the order this device opened them, and each Whombat's line. Pure: the web draws them.
 */

import { LINK_PRICE_TEXT, LINK_PRICE_YEAR_TEXT } from '@whombat/protocol';
import type { ApplianceSummary, LinkAccount, LinkedBox } from './control';
import { agoText, COPY } from './copy';
import { licenceDay } from './licence';
import { linkBoxesInOrder, linkPlanLine, linkPlanTone, WHOMBAT_LINK_TEXT } from './link';
import { isRetired } from './retired';
import { SWITCHER_ONLINE_S } from './switcher';

/** Where the account site is: the box's menu links there. */
export const ACCOUNT_SITE_URL = 'https://app.whombat.com';
/** Where the installer is downloaded. */
export const DOWNLOAD_URL = 'https://whombat.com/download';
/** The account site's page that adds a Whombat by the code on its screen (`/link` still works, the box screens show it). */
export const ADD_PAGE_PATH = '/add';

export const HOME_TEXT = {
  title: (count: number) => (count === 1 ? 'Your Whombat' : 'Your Whombats'),
  sub: (count: number) =>
    count === 1
      ? 'Everything you keep stays on your Whombat. This page only opens it.'
      : 'Everything you keep stays on your Whombats. This page only opens them.',
  open: 'Open',
  openName: (name: string) => `Open ${name}`,
  openedLast: 'Opened last',
  add: 'Add a Whombat',
  /** The footer's way to the account page. */
  account: 'Account and billing',
  /** The plan in one line at the foot: “Whombat Link · Free for good · 3 Whombats”. */
  plan: (line: string, count: number) =>
    count > 1 ? `Whombat Link · ${line} · ${count} Whombats` : `Whombat Link · ${line}`,
  loading: 'Loading your Whombats…',
  more: (name: string) => `More for ${name}`,
  remove: 'Remove from Whombat Link',
  /** A Whombat this page doesn't open: one an older organization linked at its own address. */
  elsewhere: 'Opens at its own address',
  /** Control hasn't heard from it for a while (it asks control about once an hour). */
  quiet: (ago: string) => `Not heard from since ${ago}`,
  emptyTitle: 'Add your Whombat',
  emptySub: 'Your account is ready. Now add the Whombat you installed at home.',
  steps: [
    { t: 'Install it', d: 'Put Whombat on a computer that stays on.' },
    { t: 'Choose Easy', d: 'Its screen then shows a code, like ABCD-EFGH.' },
    { t: 'Enter the code', d: 'It changes every 15 minutes.' },
  ],
  download: 'Download the installer',
  offer: `First month free, then ${LINK_PRICE_TEXT} or ${LINK_PRICE_YEAR_TEXT} for each Whombat. No card needed to start.`,
  /** The account menu at the top right. */
  menu: {
    label: (email: string) => `Your account, ${email}`,
    account: 'Account and billing',
    phone: 'Phone app',
    signOut: 'Sign out',
  },
} as const;

export const ACCOUNT_TEXT = {
  back: 'Your Whombats',
  title: 'Account',
  link: 'Subscription',
  linkAbout: 'Reach your Whombats from anywhere and get their notifications on your phone.',
  you: 'You',
  email: 'Email',
  phone: 'Phone app',
  phoneMeta: 'Whombat for iPhone and Android',
  phoneGet: 'Get the app',
  signOut: 'Sign out',
  signOutMeta: 'On this browser',
  keepsWorking: 'Your Whombats keep working at home without an account.',
  delete: COPY.account.deleteEntry,
} as const;

/** The sign-in page's way for someone new: the code on the Whombat's screen makes the account on the way. */
export const SIGN_IN_NEW_TEXT = {
  divider: 'New to Whombat?',
  line: 'Start with the code your Whombat shows on its screen.',
  add: 'Add your Whombat',
} as const;

/** The `/add` page's words where they differ from `/link`'s: one name for adding a Whombat everywhere. */
export const ADD_TEXT = {
  kicker: 'ADD A WHOMBAT',
  title: 'Add a Whombat',
  confirmTitle: 'Add this Whombat?',
  confirmName: (name: string) => `Add ${name}?`,
  gets: ['Open it from anywhere', 'Its notifications on your phone', 'Its own web address'],
  confirm: 'Add it',
  confirming: 'Adding…',
  doneTitle: (name: string) => `${name} is added`,
} as const;

/** The menu under a box's name on its own page. */
export const BOX_MENU_TEXT = {
  kicker: 'YOUR WHOMBATS',
  here: 'This Whombat',
  all: 'All Whombats',
  add: 'Add a Whombat',
  label: (name: string) => `${name}. Your Whombats`,
  opensElsewhere: (name: string) => `${name}, opens at its own address`,
} as const;

export type HomeTone = 'ok' | 'warn' | 'bad' | 'mut';

/**
 * Control hears from a linked Whombat about once an hour (its Link status, its updates, its door to the relay), so a
 * shorter silence says nothing. Longer than this, the line says when it was last heard from.
 */
export const LINK_QUIET_S = 3 * 3600;

/** One Whombat's line: the dot's tone and the words after it (its address follows them where it has one). */
export interface WhombatLine {
  tone: HomeTone;
  /** Null: the address alone says it (on, and heard from lately). */
  text: string | null;
  /** Its address opens it now. */
  opens: boolean;
}

/** What a linked Whombat's line says, here and in a box's menu. */
export function linkWhombatLine(
  box: Pick<LinkedBox, 'state' | 'lastSeenAt' | 'host'> & {
    /** Undefined where it isn't known (a box's menu): the line then doesn't say when Link ends. */
    graceEndsAt?: number | null | undefined;
  },
  now: number = Date.now(),
  timeZone?: string,
): WhombatLine {
  const reachable = box.host !== null;
  switch (box.state) {
    case 'starting':
      return { tone: 'warn', text: WHOMBAT_LINK_TEXT.boxStarting, opens: false };
    case 'off':
      return { tone: 'mut', text: WHOMBAT_LINK_TEXT.boxOff, opens: false };
    case 'ended':
      return { tone: 'bad', text: WHOMBAT_LINK_TEXT.boxEnded, opens: false };
    case 'grace':
      return {
        tone: 'warn',
        text:
          box.graceEndsAt === undefined
            ? null
            : box.graceEndsAt === null
              ? WHOMBAT_LINK_TEXT.boxEnded
              : WHOMBAT_LINK_TEXT.boxEnds(
                  licenceDay(new Date(box.graceEndsAt * 1000).toISOString(), timeZone),
                ),
        opens: reachable,
      };
    case 'on': {
      if (!reachable) return { tone: 'warn', text: WHOMBAT_LINK_TEXT.boxStarting, opens: false };
      const quiet = box.lastSeenAt !== null && now / 1000 - box.lastSeenAt > LINK_QUIET_S;
      return quiet
        ? { tone: 'mut', text: HOME_TEXT.quiet(agoText(box.lastSeenAt as number, now)), opens: true }
        : { tone: 'ok', text: null, opens: true };
    }
  }
}

/** Where a linked Whombat opens: its own address, while that works. */
export function whombatUrl(host: string | null): string | null {
  return host ? `https://${host}/` : null;
}

/** A row of the home page. */
export interface HomeRow {
  device: string;
  name: string;
  tone: HomeTone;
  /** The line under the name, before the address. */
  text: string | null;
  /** The address shown after the line. */
  host: string | null;
  /** `url`: its own address; `here`: this site opens it (an older organization's Whombat); null: not now. */
  open: { kind: 'url'; url: string } | { kind: 'here' } | null;
  openedLast: boolean;
  /** Its Link, when it has one: Remove takes it out. */
  link: LinkedBox | null;
  /** An older organization's Whombat, opened on this site. */
  appliance: ApplianceSummary | null;
}

/**
 * The home page's rows: the Link Whombats and an older organization's, the one this device opened last first, the
 * rest in control's order. An older organization's Whombat linked at its own address shows once, as the Link one.
 */
export function homeRows(input: {
  account: LinkAccount | null;
  /** An older organization's Whombats (this site opens them), when the account has one. */
  hosted?: readonly ApplianceSummary[] | null;
  lastOpened: string | null;
  now?: number;
  timeZone?: string;
}): HomeRow[] {
  const now = input.now ?? Date.now();
  const boxes = input.account?.boxes ?? [];
  const linked = new Set(boxes.map((b) => b.device));
  const rows: HomeRow[] = boxes.map((box) => {
    const line = linkWhombatLine(box, now, input.timeZone);
    const url = line.opens ? whombatUrl(box.host) : null;
    return {
      device: box.device,
      name: box.name ?? WHOMBAT_LINK_TEXT.yourWhombatTitle,
      tone: line.tone,
      text: line.text,
      host: box.state === 'ended' || box.state === 'off' ? null : box.host,
      open: url ? { kind: 'url', url } : null,
      openedLast: false,
      link: box,
      appliance: null,
    };
  });
  for (const a of input.hosted ?? []) {
    if (isRetired(a) || linked.has(a.device)) continue;
    const online = a.lastSeenAt !== null && now / 1000 - a.lastSeenAt < SWITCHER_ONLINE_S;
    rows.push({
      device: a.device,
      name: a.name ?? a.device,
      tone: a.ownAddress ? 'mut' : online ? 'ok' : 'mut',
      text: a.ownAddress
        ? HOME_TEXT.elsewhere
        : online
          ? COPY.appliances.online
          : a.lastSeenAt !== null
            ? COPY.appliances.offline(agoText(a.lastSeenAt, now))
            : COPY.appliances.neverSeen,
      host: null,
      open: a.ownAddress ? null : { kind: 'here' },
      openedLast: false,
      link: null,
      appliance: a,
    });
  }
  const ordered = linkBoxesInOrder(rows, input.lastOpened);
  if (rows.length > 1 && ordered[0] && ordered[0].device === input.lastOpened) ordered[0].openedLast = true;
  return ordered;
}

/** The plan's line at the foot of the home page, or null while there is nothing to say (no Link, no Whombat). */
export function homePlanLine(
  account: LinkAccount | null,
  timeZone?: string,
): { tone: HomeTone; text: string } | null {
  if (!account) return null;
  if (account.plan.state === 'none' && account.boxes.length === 0) return null;
  return {
    tone: linkPlanTone(account.plan),
    text: HOME_TEXT.plan(linkPlanLine(account.plan, timeZone), account.plan.boxes || account.boxes.length),
  };
}

/** A Whombat of the same account as it reaches a box's menu (the session's `link.whombats`). */
export interface MenuWhombat {
  device: string;
  name: string | null;
  state: LinkedBox['state'];
  host: string | null;
  /** ISO time. */
  lastSeenAt: string | null;
}

export interface BoxMenuRow {
  device: string;
  name: string;
  tone: HomeTone;
  text: string;
  /** Its own address, while that opens it. */
  url: string | null;
}

/** The other Whombats in a box's menu, by name: each with its line and where it opens. */
export function boxMenuRows(list: readonly MenuWhombat[], now: number = Date.now()): BoxMenuRow[] {
  return list
    .map((w): BoxMenuRow => {
      const lastSeenAt = w.lastSeenAt ? Math.floor(Date.parse(w.lastSeenAt) / 1000) : null;
      const line = linkWhombatLine({ state: w.state, host: w.host, lastSeenAt }, now);
      return {
        device: w.device,
        name: w.name ?? WHOMBAT_LINK_TEXT.yourWhombatTitle,
        tone: line.tone,
        text: line.text ?? w.host ?? '',
        url: line.opens ? whombatUrl(w.host) : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The box's menu is there while the box has Whombat Link (it belongs to an account to go back to). */
export function boxHasAccount(state: LinkedBox['state'] | null | undefined): boolean {
  return state !== undefined && state !== null && state !== 'off';
}

/** The account site's address for a path (`/`, `/add`). */
export function accountSiteUrl(path: string): string {
  return `${ACCOUNT_SITE_URL}${path === '/' ? '/' : path}`;
}
