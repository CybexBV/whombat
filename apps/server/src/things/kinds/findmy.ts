/**
 * A Find My connection's page and card (docs/decisions/findmy-connection.md): its first tab is Find My, which names the
 * Mac it reads (`ThingPageTab.server`) for the apps to draw from that Mac's own operations, and its Timeline tab follows
 * (findmy-timeline.md), drawn by the apps from the connection's timeline operations; the card says how many people the
 * last read had and how long ago, or why it couldn't read. Everything here comes from the box's memory: the page and
 * the health pass never read Find My themselves, and say no place and nothing of the timeline (Overview is also on the
 * desk display).
 */
import { FIND_MY_TIMELINE_TAB, type HostFindMy, type HostFindMyCode } from '@whombat/core';
import type { CatalogConnectionRow } from '../../connections/types';
import { findMyFor } from '../../hosts/findmy';
import { type MacProblem, macOf, runMacCheck } from '../../hosts/findmy-connection';
import { serverLabel } from '../../hosts/self';
import { hostsFor } from '../../hosts/service';
import type { Services } from '../../services';
import type { KindCheck, KindNotice } from '../quiet/types';
import { line, plural, span } from '../words';
import type { KindModule } from './registry';
import type { KindView } from './types';

/** Its one check: the last read's problem. It starts off: a read that failed is what a person opens the page for. */
export const FIND_MY_CHECKS: readonly KindCheck[] = [
  { check: 'findmy.read', name: 'Find My can’t be read', nature: 'problem', perItem: false, startsOn: false },
];

/** A read's problem in a few words, for the card. */
const SHORT: Partial<Record<HostFindMyCode, string>> = {
  in_use: 'The Mac is in use',
  no_find_my: 'Find My didn’t open',
  helper_old: 'Whombat Helper is updating',
  no_helper: 'Whombat Helper isn’t running',
  no_access: 'Helper needs Accessibility',
  locked: 'The Mac is locked',
  timeout: 'The Mac didn’t answer',
};

/** The card's words when the connection's own check failed. */
const MAC_SHORT: Record<MacProblem, string> = {
  no_mac: 'No Mac yet',
  gone: 'The Mac is gone',
  not_mac: 'Not a Mac',
  helper_old: 'Whombat Helper is updating',
};

/** “3 people · read 5 min ago”, “Not read yet”, or the read's problem in a few words. */
export function findMyGlanceLine(shown: HostFindMy | null, now: Date): string {
  if (shown?.problem) return SHORT[shown.problem.code] ?? 'Find My couldn’t be read';
  if (!shown?.readAt) return 'Not read yet';
  const ago = now.getTime() - new Date(shown.readAt).getTime();
  const when = ago < 60_000 ? 'read just now' : `read ${span(ago)} ago`;
  return `${plural(shown.people.length, 'person', 'people')} · ${when}`;
}

/** Worth a look: why the last read didn't work, when it didn't. */
export function findMyNotices(shown: HostFindMy | null, mac: string): KindNotice[] {
  const problem = shown?.problem;
  if (!problem) return [];
  return [
    {
      id: 'findmy-read',
      tone: problem.code === 'in_use' ? 'info' : 'warn',
      icon: 'device',
      title: SHORT[problem.code] ?? 'Find My couldn’t be read',
      detail: `Find My on ${mac} couldn’t be read. Open the Find My tab to see why and read it again.`.slice(
        0,
        200,
      ),
      nature: 'problem',
      check: 'findmy.read',
      ignore: { lifts: 'fixed', words: 'Until a read works again.' },
      episode: problem.code,
    },
  ];
}

/** What the box remembers of the connection's Mac, without counting as a look. */
function remembered(
  services: Services,
  row: CatalogConnectionRow,
): { mac: string | null; shown: HostFindMy | null } {
  const mac = macOf(row);
  return { mac, shown: mac ? findMyFor(services).peek(mac) : null };
}

/** The key of the tab the apps draw Find My on. */
export const FIND_MY_TAB = 'findmy';

/**
 * The page: Find My first (the apps draw it from the Mac's operations), then the Timeline (an app below session minor 5
 * doesn't get it: `things/older-apps.ts`), its head's facts, its one line.
 */
export function findMyView(mac: string | null, shown: HostFindMy | null): KindView {
  const name = mac ? serverLabel(mac) : null;
  return {
    // No response time: nothing is sent anywhere to answer.
    charts: [],
    notices: name ? findMyNotices(shown, name) : [],
    panels: [],
    tabs: mac
      ? [
          { key: FIND_MY_TAB, label: 'Find My', server: mac, panels: [] },
          { key: FIND_MY_TIMELINE_TAB, label: 'Timeline', server: mac, panels: [] },
        ]
      : [],
    facts: [
      ...(name ? [line(`On **${name}**`)] : []),
      ...(shown?.readAt ? [line(`**${plural(shown.people.length, 'person', 'people')}**`)] : []),
    ],
    actions: [],
    readAt: shown?.readAt ? new Date(shown.readAt) : null,
    suggestions: ['Where is everyone?'],
  };
}

export const FIND_MY_KIND: KindModule = {
  checks: FIND_MY_CHECKS,
  page: async ({ services, row }) => {
    const { mac, shown } = remembered(services, row);
    return findMyView(mac, shown);
  },
  seen: async (services, row, now) => {
    const { mac, shown } = remembered(services, row);
    return {
      glance: { facts: [], line: findMyGlanceLine(shown, now) },
      points: {},
      notices: findMyNotices(shown, mac ? serverLabel(mac) : 'the Mac'),
    };
  },
  // The connection's check failed: the Mac gone, not a Mac, its helper too old (nothing about places).
  unanswered: async (services, row) => {
    const found = await runMacCheck(hostsFor(services), row.fields.mac);
    return found.code ? MAC_SHORT[found.code] : null;
  },
};
